//! The window where the user signs in on twitch.tv to link the playback
//! session (see `twitch::playback_session`). Electron's equivalent is
//! `PlaybackSessionService.link`.
//!
//! A plain Win32 window holds an InPrivate WebView2: GPUI draws its own windows
//! with a topmost DirectComposition target, which would cover a child webview.
//! Navigation stays on Twitch's sign-in hosts, downloads are refused, and the
//! page gets no bridge into the app. Once Twitch sets its `auth-token` cookie,
//! the token is checked, saved to Credential Manager, and the window closes.
//!
//! WebView2's setup and cookie reads pump messages while they wait, so they run
//! in the async task's body, never inside a GPUI update.

use std::cell::{Cell, RefCell};
use std::num::NonZeroIsize;
use std::rc::Rc;
use std::time::Duration;

use anyhow::{Context as _, Result};
use gpui::{App, AsyncApp};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DWMWA_USE_IMMERSIVE_DARK_MODE, DwmSetWindowAttribute};
use windows::Win32::Graphics::Gdi::{BLACK_BRUSH, GetStockObject, HBRUSH};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    CS_HREDRAW, CS_VREDRAW, CW_USEDEFAULT, CreateWindowExW, DefWindowProcW, DestroyWindow,
    GetWindowRect, IDC_ARROW, IsWindow, LoadCursorW, RegisterClassExW, SetForegroundWindow,
    WINDOW_EX_STYLE, WM_CLOSE, WNDCLASSEXW, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
};
use windows::core::w;
use wry::raw_window_handle::{
    HandleError, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle,
};

use crate::twitch::playback_session;

const LOGIN_URL: &str = "https://www.twitch.tv/login";

thread_local! {
    /// The sign-in window while it is open, so a second request focuses it.
    static OPEN: Cell<Option<isize>> = const { Cell::new(None) };
    /// Set by the window's close button; the task tears the window down.
    static CLOSE_REQUESTED: Cell<bool> = const { Cell::new(false) };
}

pub enum Outcome {
    Linked(Option<String>),
    Cancelled,
}

/// Opens the sign-in window (or focuses the open one). `done` runs once it
/// closes, linked or not.
pub fn open(owner: Option<isize>, cx: &mut App, done: impl FnOnce(Result<Outcome>, &mut App) + 'static) {
    if let Some(open) = OPEN.get() {
        let hwnd = HWND(open as _);
        // SAFETY: plain window calls on a handle this thread created.
        unsafe {
            if IsWindow(Some(hwnd)).as_bool() {
                let _ = SetForegroundWindow(hwnd);
                return;
            }
        }
        OPEN.set(None);
    }
    cx.spawn(async move |cx: &mut AsyncApp| {
        let result = run(owner, cx).await;
        let _ = cx.update(|cx| done(result, cx));
    })
    .detach();
}

/// Twitch's own sign-in, and the identity providers it offers.
fn allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('@') {
        return false;
    }
    let host = authority.split(':').next().unwrap_or_default().to_ascii_lowercase();
    is_twitch_host(&host)
        || host == "accounts.google.com"
        || host == "appleid.apple.com"
        || host == "amazon.com"
        || host.ends_with(".amazon.com")
}

fn is_twitch_host(host: &str) -> bool {
    let host = host.trim_start_matches('.');
    host == "twitch.tv" || host.ends_with(".twitch.tv")
}

/// Removes the window when the task ends, however it ends.
struct Window(HWND);

impl Drop for Window {
    fn drop(&mut self) {
        OPEN.set(None);
        // SAFETY: this thread created the window; destroying it twice fails
        // harmlessly.
        unsafe {
            let _ = DestroyWindow(self.0);
        }
    }
}

impl HasWindowHandle for Window {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let hwnd = NonZeroIsize::new(self.0.0 as isize).ok_or(HandleError::Unavailable)?;
        // SAFETY: the webview built on this handle is dropped before the
        // window (see `run`).
        Ok(unsafe { WindowHandle::borrow_raw(RawWindowHandle::Win32(Win32WindowHandle::new(hwnd))) })
    }
}

async fn run(owner: Option<isize>, cx: &mut AsyncApp) -> Result<Outcome> {
    let window = Window(create_window(owner.map(|owner| HWND(owner as _)))?);
    OPEN.set(Some(window.0.0 as isize));
    CLOSE_REQUESTED.set(false);

    let pending = Rc::new(RefCell::new(None::<String>));
    // InPrivate: nothing of the session is left on disk. The folder holds
    // only WebView2's own runtime state.
    let mut context = wry::WebContext::new(
        std::env::var_os("LOCALAPPDATA")
            .map(|path| std::path::PathBuf::from(path).join("VioletWireRust").join("WebView2")),
    );
    let webview = {
        let pending = pending.clone();
        wry::WebViewBuilder::new_with_web_context(&mut context)
            .with_url(LOGIN_URL)
            .with_incognito(true)
            .with_devtools(false)
            .with_clipboard(true)
            .with_background_color((14, 14, 16, 255))
            .with_navigation_handler(|url| allowed(&url))
            // Sign-in providers that open a popup load in this window instead.
            .with_new_window_req_handler(move |url, _| {
                if allowed(&url) {
                    *pending.borrow_mut() = Some(url);
                }
                wry::NewWindowResponse::Deny
            })
            .with_download_started_handler(|_, _| false)
            .with_document_title_changed_handler(|title| {
                if std::env::var_os("VIOLETWIRE_PLAYBACK_LOG").is_some() {
                    eprintln!("[link] page title: {}", crate::http::short_message(&title));
                }
            })
            .build(&window)
            .context("Could not open Twitch's sign-in page. Microsoft Edge WebView2 may be missing.")?
    };

    let outcome = loop {
        cx.background_executor().timer(Duration::from_millis(400)).await;
        // SAFETY: plain query on a handle this thread created.
        if CLOSE_REQUESTED.get() || unsafe { !IsWindow(Some(window.0)).as_bool() } {
            break Ok(Outcome::Cancelled);
        }
        if let Some(url) = pending.borrow_mut().take() {
            let _ = webview.load_url(&url);
        }
        let token = webview
            .cookies_for_url("https://www.twitch.tv")
            .ok()
            .and_then(|cookies| {
                cookies.into_iter().find(|cookie| {
                    cookie.name() == "auth-token"
                        && cookie.domain().is_none_or(is_twitch_host)
                        && playback_session::is_token(cookie.value())
                })
            })
            .map(|cookie| cookie.value().to_owned());
        let Some(token) = token else { continue };
        let check = token.clone();
        let result = cx
            .background_executor()
            .spawn(async move { playback_session::validate(&check) })
            .await
            .and_then(|login| {
                playback_session::save(token, login.clone())?;
                Ok(Outcome::Linked(login))
            });
        break result;
    };
    drop(webview);
    drop(context);
    drop(window);
    outcome
}

fn create_window(owner: Option<HWND>) -> Result<HWND> {
    // SAFETY: standard window-class registration and creation on the UI
    // thread, which pumps messages (GPUI's loop).
    unsafe {
        let instance = GetModuleHandleW(None)?;
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(window_proc),
            hInstance: instance.into(),
            hCursor: LoadCursorW(None, IDC_ARROW)?,
            hbrBackground: HBRUSH(GetStockObject(BLACK_BRUSH).0),
            lpszClassName: w!("VioletWireTwitchSignIn"),
            ..Default::default()
        };
        // Fails harmlessly when the class is already registered.
        RegisterClassExW(&class);

        let scale = owner.map_or(1., |owner| GetDpiForWindow(owner).max(96) as f32 / 96.);
        let (width, height) = ((620. * scale) as i32, (760. * scale) as i32);
        let (mut x, mut y) = (CW_USEDEFAULT, CW_USEDEFAULT);
        let mut bounds = RECT::default();
        if let Some(owner) = owner
            && GetWindowRect(owner, &mut bounds).is_ok()
        {
            x = bounds.left + ((bounds.right - bounds.left) - width) / 2;
            y = bounds.top + ((bounds.bottom - bounds.top) - height) / 2;
        }
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("VioletWireTwitchSignIn"),
            w!("Sign in to Twitch for playback"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            x,
            y,
            width,
            height,
            owner,
            None,
            Some(instance.into()),
            None,
        )?;
        let dark: i32 = 1;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            (&raw const dark).cast(),
            std::mem::size_of::<i32>() as u32,
        );
        Ok(hwnd)
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if message == WM_CLOSE {
        // The task drops the webview first, then destroys the window.
        CLOSE_REQUESTED.set(true);
        return LRESULT(0);
    }
    // SAFETY: default handling for every other message.
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::allowed;

    #[test]
    fn keeps_navigation_on_sign_in_hosts() {
        assert!(allowed("https://www.twitch.tv/login"));
        assert!(allowed("https://passport.twitch.tv/x"));
        assert!(allowed("https://accounts.google.com/o/oauth2"));
        assert!(allowed("https://www.amazon.com/ap/signin"));
        assert!(!allowed("http://www.twitch.tv/login"));
        assert!(!allowed("https://twitch.tv.evil.example/"));
        assert!(!allowed("https://evil.example/?u=https://www.twitch.tv"));
        assert!(!allowed("https://www.twitch.tv@evil.example/"));
        assert!(!allowed("https://nottwitch.tv/"));
    }
}
