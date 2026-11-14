//! The Kick account, as Electron's `KickService` keeps it: the viewer signs in
//! on Kick's own page in a window of its own, with a WebView2 profile kept
//! only for Kick, so VioletWire never sees a password. Requests that need the
//! account (the followed list, sending chat) then run from a hidden kick.com
//! page on that same profile, the way Electron used its Kick partition: the
//! browser sends Kick's cookies itself, and the `session_token` cookie goes
//! along as the bearer Kick's API expects. Nothing is written outside the
//! WebView2 profile, and the token is never logged.
//!
//! Anonymous Kick lookups stay on Streamlink (`playback/kick.rs`).
//!
//! WebView2 setup, cookie reads and script calls pump messages while they
//! wait, so they only run in async task bodies, never inside a GPUI update.

use std::cell::{Cell, RefCell};
use std::num::NonZeroIsize;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail};
use gpui::{App, AsyncApp};
use serde_json::Value;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DWMWA_USE_IMMERSIVE_DARK_MODE, DwmSetWindowAttribute};
use windows::Win32::Graphics::Gdi::{BLACK_BRUSH, GetStockObject, HBRUSH};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    CS_HREDRAW, CS_VREDRAW, CW_USEDEFAULT, CreateWindowExW, DefWindowProcW, DestroyWindow,
    GetWindowRect, IDC_ARROW, IsWindow, LoadCursorW, RegisterClassExW, SetForegroundWindow,
    WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLOSE, WNDCLASSEXW, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
};
use windows::core::{HSTRING, w};
use wry::raw_window_handle::{HandleError, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle};

/// Kick's sign-in page; `redirect` makes its social logins come back through
/// kick.com so the site session starts (see Electron's `getKickLoginUrl`).
const LOGIN_URL: &str = "https://id.kick.com/login?redirect=https%3A%2F%2Fkick.com%2F";
/// A small kick.com document for the hidden page: same origin as the API,
/// without the site's player and scripts.
const WORKER_URL: &str = "https://kick.com/robots.txt";
const IDLE: Duration = Duration::from_secs(300);

thread_local! {
    static SIGN_IN: Cell<Option<isize>> = const { Cell::new(None) };
    static CLOSED: RefCell<Vec<isize>> = const { RefCell::new(Vec::new()) };
    static WORKER: RefCell<Option<Rc<Worker>>> = const { RefCell::new(None) };
    static STARTING: Cell<bool> = const { Cell::new(false) };
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Account {
    pub username: String,
    pub avatar: Option<String>,
}

impl Account {
    fn from_json(value: &Value) -> Option<Self> {
        // Signed out, Kick answers this route with an empty array.
        let username: String = value["username"].as_str()?.chars().filter(|c| !c.is_control()).take(40).collect();
        if username.is_empty() {
            return None;
        }
        let avatar = value["profile_pic"]
            .as_str()
            .or_else(|| value["profilepic"].as_str())
            .filter(|url| crate::kick::is_image_url(url))
            .map(str::to_owned);
        Some(Self { username, avatar })
    }
}

fn profile() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|path| PathBuf::from(path).join("VioletWireRust").join("KickWebView2"))
}

/// Kick and the sign-in providers its page offers.
fn allowed_sign_in(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('@') {
        return false;
    }
    let host = authority.split(':').next().unwrap_or_default().to_ascii_lowercase();
    is_kick_host(&host)
        || matches!(host.as_str(), "accounts.google.com" | "appleid.apple.com" | "challenges.cloudflare.com")
}

fn is_kick_host(host: &str) -> bool {
    host == "kick.com" || host.ends_with(".kick.com")
}

fn host_of(url: &str) -> String {
    url.strip_prefix("https://")
        .and_then(|rest| rest.split(['/', '?', '#', ':']).next())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

// ----- Windows --------------------------------------------------------------

struct Window(HWND);

impl Drop for Window {
    fn drop(&mut self) {
        // SAFETY: this thread created the window; destroying twice fails harmlessly.
        unsafe {
            let _ = DestroyWindow(self.0);
        }
    }
}

impl HasWindowHandle for Window {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let hwnd = NonZeroIsize::new(self.0.0 as isize).ok_or(HandleError::Unavailable)?;
        // SAFETY: every webview built on this handle is dropped before the window.
        Ok(unsafe { WindowHandle::borrow_raw(RawWindowHandle::Win32(Win32WindowHandle::new(hwnd))) })
    }
}

fn create_window(owner: Option<HWND>, title: &str, visible: bool) -> Result<HWND> {
    // SAFETY: standard window-class registration and creation on the UI thread.
    unsafe {
        let instance = GetModuleHandleW(None)?;
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(window_proc),
            hInstance: instance.into(),
            hCursor: LoadCursorW(None, IDC_ARROW)?,
            hbrBackground: HBRUSH(GetStockObject(BLACK_BRUSH).0),
            lpszClassName: w!("VioletWireKick"),
            ..Default::default()
        };
        RegisterClassExW(&class);
        let scale = owner.map_or(1., |owner| GetDpiForWindow(owner).max(96) as f32 / 96.);
        let (width, height) = ((560. * scale) as i32, (780. * scale) as i32);
        let (mut x, mut y) = (CW_USEDEFAULT, CW_USEDEFAULT);
        let mut bounds = RECT::default();
        if let Some(owner) = owner
            && GetWindowRect(owner, &mut bounds).is_ok()
        {
            x = bounds.left + ((bounds.right - bounds.left) - width) / 2;
            y = bounds.top + ((bounds.bottom - bounds.top) - height) / 2;
        }
        let style = if visible { WS_OVERLAPPEDWINDOW | WS_VISIBLE } else { WINDOW_STYLE(0) };
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("VioletWireKick"),
            &HSTRING::from(title),
            style,
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
        // The owning task drops the webview first, then destroys the window.
        CLOSED.with_borrow_mut(|closed| closed.push(hwnd.0 as isize));
        return LRESULT(0);
    }
    // SAFETY: default handling for every other message.
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

fn close_requested(window: &Window) -> bool {
    let id = window.0.0 as isize;
    // SAFETY: plain query on a handle this thread created.
    CLOSED.with_borrow_mut(|closed| {
        let asked = closed.contains(&id);
        closed.retain(|other| *other != id);
        asked
    }) || unsafe { !IsWindow(Some(window.0)).as_bool() }
}

/// `pending` receives sign-in popups, which the caller loads in place.
fn webview(
    context: &mut wry::WebContext,
    window: &Window,
    url: &str,
    sign_in: bool,
    pending: Rc<RefCell<Option<String>>>,
) -> Result<wry::WebView> {
    let builder = wry::WebViewBuilder::new_with_web_context(context)
        .with_url(url)
        .with_devtools(false)
        .with_clipboard(sign_in)
        .with_background_color((14, 14, 16, 255))
        .with_download_started_handler(|_, _| false)
        .with_new_window_req_handler(move |url, _| {
            if allowed_sign_in(&url) {
                *pending.borrow_mut() = Some(url);
            }
            wry::NewWindowResponse::Deny
        });
    let builder = if sign_in {
        builder.with_navigation_handler(|url| allowed_sign_in(&url))
    } else {
        // The hidden page only ever sits on kick.com.
        builder.with_navigation_handler(|url| is_kick_host(&host_of(&url)))
    };
    builder
        .build(window)
        .context("Could not open Kick. Microsoft Edge WebView2 may be missing.")
}

// ----- Script calls ---------------------------------------------------------

/// The `session_token` cookie, decoded: Kick's bearer (`id|secret`).
fn bearer(webview: &wry::WebView) -> Option<String> {
    let cookie = webview
        .cookies_for_url("https://kick.com")
        .ok()?
        .into_iter()
        .find(|cookie| cookie.name() == "session_token")?;
    let raw = cookie.value();
    let mut bytes = Vec::with_capacity(raw.len());
    let mut iter = raw.bytes();
    while let Some(b) = iter.next() {
        if b == b'%' {
            let hex = [iter.next()?, iter.next()?];
            bytes.push(u8::from_str_radix(std::str::from_utf8(&hex).ok()?, 16).ok()?);
        } else {
            bytes.push(b);
        }
    }
    let token = String::from_utf8(bytes).ok()?;
    (!token.is_empty() && token.len() < 1024 && token.bytes().all(|b| b.is_ascii_graphic())).then_some(token)
}

/// Runs `script` and waits for the value it returns.
async fn evaluate(webview: &wry::WebView, cx: &mut AsyncApp, script: &str) -> Result<Value> {
    let slot = Arc::new(Mutex::new(None::<String>));
    let fill = slot.clone();
    webview.evaluate_script_with_callback(script, move |result| {
        *fill.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(result);
    })?;
    for _ in 0..100 {
        if let Some(result) = slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take() {
            return Ok(serde_json::from_str(&result).unwrap_or(Value::Null));
        }
        cx.background_executor().timer(Duration::from_millis(30)).await;
    }
    bail!("Kick's page did not answer.")
}

/// A fetch made by the page itself, so it carries Kick's own cookies.
async fn page_fetch(
    webview: &wry::WebView,
    cx: &mut AsyncApp,
    id: u64,
    method: &str,
    url: &str,
    body: Option<&Value>,
    bearer: Option<&str>,
) -> Result<(i64, Value)> {
    let quote = |text: &str| serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    let start = format!(
        r#"(() => {{
  const store = (window.__violetwire ||= {{}});
  const headers = {{ "Accept": "application/json", "X-App-Platform": "web" }};
  const bearer = {bearer};
  if (bearer !== null) headers["Authorization"] = "Bearer " + bearer;
  const init = {{ method: {method}, headers, credentials: {credentials} }};
  const body = {body};
  if (body !== null) {{ headers["Content-Type"] = "application/json"; init.body = body; }}
  fetch({url}, init)
    .then(async (response) => {{
      let text = "";
      try {{ text = await response.text(); }} catch (error) {{}}
      store[{id}] = {{ s: response.status, t: text.slice(0, 2000000) }};
    }})
    .catch(() => {{ store[{id}] = {{ s: -1, t: "" }}; }});
  return 1;
}})()"#,
        // Kick's cookies and bearer go to kick.com only.
        bearer = bearer.filter(|_| url.starts_with('/')).map_or_else(|| "null".into(), quote),
        credentials = quote(if url.starts_with('/') { "include" } else { "omit" }),
        method = quote(method),
        body = body.map_or_else(|| "null".into(), |body| quote(&body.to_string())),
        url = quote(url),
    );
    evaluate(webview, cx, &start).await?;
    let read = format!(
        "(() => {{ const store = window.__violetwire; const r = store && store[{id}]; if (!r) return null; delete store[{id}]; return r; }})()"
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        cx.background_executor().timer(Duration::from_millis(80)).await;
        let result = evaluate(webview, cx, &read).await?;
        if result.is_null() {
            continue;
        }
        let status = result["s"].as_i64().unwrap_or(-1);
        let text = result["t"].as_str().unwrap_or_default();
        return Ok((status, serde_json::from_str(text).unwrap_or(Value::Null)));
    }
    bail!("Kick took too long to answer.")
}

// ----- Sign-in ---------------------------------------------------------------

/// Opens Kick's sign-in (or focuses the open one). `done` gets the account
/// once the viewer is signed in, or `None` if they closed the window.
pub fn sign_in(owner: Option<isize>, cx: &mut App, done: impl FnOnce(Result<Option<Account>>, &mut App) + 'static) {
    if let Some(open) = SIGN_IN.get() {
        // SAFETY: plain window calls on a handle this thread created.
        unsafe {
            if IsWindow(Some(HWND(open as _))).as_bool() {
                let _ = SetForegroundWindow(HWND(open as _));
                return;
            }
        }
        SIGN_IN.set(None);
    }
    cx.spawn(async move |cx: &mut AsyncApp| {
        let result = run_sign_in(owner, cx).await;
        SIGN_IN.set(None);
        let _ = cx.update(|cx| done(result, cx));
    })
    .detach();
}

async fn run_sign_in(owner: Option<isize>, cx: &mut AsyncApp) -> Result<Option<Account>> {
    let window = Window(create_window(owner.map(|owner| HWND(owner as _)), "Sign in to Kick", true)?);
    SIGN_IN.set(Some(window.0.0 as isize));
    let mut context = wry::WebContext::new(profile());
    let pending = Rc::new(RefCell::new(None::<String>));
    let view = webview(&mut context, &window, LOGIN_URL, true, pending.clone())?;
    let mut next = 1;
    let account = loop {
        cx.background_executor().timer(Duration::from_millis(700)).await;
        if close_requested(&window) {
            break None;
        }
        if let Some(url) = pending.borrow_mut().take() {
            let _ = view.load_url(&url);
        }
        // Wait for Kick to land back on kick.com with its session cookie.
        if host_of(&view.url().unwrap_or_default()) != "kick.com" {
            continue;
        }
        let Some(token) = bearer(&view) else { continue };
        next += 1;
        if let Ok((200, user)) = page_fetch(&view, cx, next, "GET", "/api/v1/user", None, Some(&token)).await
            && let Some(account) = Account::from_json(&user)
        {
            break Some(account);
        }
    };
    drop(view);
    drop(context);
    drop(window);
    Ok(account)
}

/// Opens a Kick page (a channel, to follow it there) in a window on the
/// signed-in profile. Following runs on Kick's own page: its follow button is
/// guarded by scripts that only Kick's page can run.
pub fn open_page(owner: Option<isize>, slug: &str, cx: &mut App, closed: impl FnOnce(&mut App) + 'static) {
    if !crate::kick::is_slug(slug) {
        return;
    }
    let url = format!("https://kick.com/{slug}");
    cx.spawn(async move |cx: &mut AsyncApp| -> Result<()> {
        let window = Window(create_window(owner.map(|owner| HWND(owner as _)), "Kick", true)?);
        let mut context = wry::WebContext::new(profile());
        let pending = Rc::new(RefCell::new(None::<String>));
        let view = webview(&mut context, &window, &url, true, pending.clone())?;
        while !close_requested(&window) {
            cx.background_executor().timer(Duration::from_millis(400)).await;
            if let Some(url) = pending.borrow_mut().take() {
                let _ = view.load_url(&url);
            }
        }
        drop(view);
        drop(context);
        drop(window);
        let _ = cx.update(closed);
        Ok(())
    })
    .detach();
}

// ----- The hidden page --------------------------------------------------------

struct Worker {
    // Dropped in this order: the webview, its context, then its window.
    view: wry::WebView,
    _context: wry::WebContext,
    _window: Window,
    last_used: Cell<Instant>,
    next: Cell<u64>,
}

async fn worker(cx: &mut AsyncApp) -> Result<Rc<Worker>> {
    loop {
        if let Some(worker) = WORKER.with_borrow(Clone::clone) {
            worker.last_used.set(Instant::now());
            return Ok(worker);
        }
        if !STARTING.get() {
            break;
        }
        cx.background_executor().timer(Duration::from_millis(100)).await;
    }
    STARTING.set(true);
    let made = start_worker(cx).await;
    STARTING.set(false);
    let worker = Rc::new(made?);
    WORKER.set(Some(worker.clone()));
    // Closed after a few idle minutes; the next request opens it again.
    cx.spawn(async move |cx: &mut AsyncApp| {
        loop {
            cx.background_executor().timer(Duration::from_secs(30)).await;
            let idle = WORKER.with_borrow(|worker| worker.as_ref().map(|worker| worker.last_used.get().elapsed()));
            match idle {
                Some(idle) if idle > IDLE => {
                    WORKER.set(None);
                    break;
                }
                Some(_) => {}
                None => break,
            }
        }
    })
    .detach();
    Ok(worker)
}

async fn start_worker(cx: &mut AsyncApp) -> Result<Worker> {
    let window = Window(create_window(None, "Kick", false)?);
    let mut context = wry::WebContext::new(profile());
    let view = webview(&mut context, &window, WORKER_URL, false, Rc::new(RefCell::new(None)))?;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        cx.background_executor().timer(Duration::from_millis(200)).await;
        let state = evaluate(&view, cx, "location.host + '|' + document.readyState").await.unwrap_or(Value::Null);
        if state == "kick.com|complete" {
            break;
        }
        if Instant::now() > deadline {
            bail!("Kick did not load.");
        }
    }
    Ok(Worker { view, _context: context, _window: window, last_used: Cell::new(Instant::now()), next: Cell::new(1) })
}

/// A Kick API call as the signed-in viewer: `url` is a kick.com path
/// (`/api/...`) or a `https://web.kick.com/api/...` address.
pub async fn request(cx: &mut AsyncApp, method: &str, url: &str, body: Option<&Value>) -> Result<(i64, Value)> {
    if !(url.starts_with("/api/") || url.starts_with("/emotes/") || url.starts_with("https://web.kick.com/api/"))
        || url.contains("..")
    {
        bail!("Not a Kick API address.");
    }
    if !matches!(method, "GET" | "POST" | "PUT" | "DELETE") {
        bail!("Unsupported request.");
    }
    let worker = worker(cx).await?;
    let token = bearer(&worker.view);
    let id = worker.next.get();
    worker.next.set(id + 1);
    let result = page_fetch(&worker.view, cx, id, method, url, body, token.as_deref()).await;
    worker.last_used.set(Instant::now());
    result
}

/// Signs out: Kick's profile is cleared, cookies and all.
pub async fn sign_out(cx: &mut AsyncApp) -> Result<()> {
    let worker = worker(cx).await?;
    worker.view.clear_all_browsing_data()?;
    WORKER.set(None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_in_stays_on_kick_and_its_providers() {
        assert!(allowed_sign_in(LOGIN_URL));
        assert!(allowed_sign_in("https://kick.com/"));
        assert!(allowed_sign_in("https://accounts.google.com/o/oauth2/auth"));
        assert!(!allowed_sign_in("http://kick.com/"));
        assert!(!allowed_sign_in("https://kick.com.evil.example/"));
        assert!(!allowed_sign_in("https://kick.com@evil.example/"));
        assert!(!allowed_sign_in("https://evil.example/?next=https://kick.com"));
    }

    #[test]
    fn reads_the_account() {
        let account = Account::from_json(&serde_json::json!({"username": "Viewer", "profile_pic": "https://files.kick.com/images/user/1/p.webp"})).unwrap();
        assert_eq!(account.username, "Viewer");
        assert!(account.avatar.is_some());
        assert!(Account::from_json(&serde_json::json!([])).is_none());
        assert!(Account::from_json(&serde_json::json!({"username": "x", "profile_pic": "https://evil.example/p.png"})).unwrap().avatar.is_none());
    }
}
