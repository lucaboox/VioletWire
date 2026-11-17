//! Keeps the display on while a stream plays, as Chromium does for video.
//!
//! One Windows power request (a handle, unlike `SetThreadExecutionState`,
//! which belongs to the calling thread) is shared by every playing player:
//! it is set when the first starts and cleared when the last stops.

use std::sync::Mutex;

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Power::{
    POWER_REQUEST_TYPE, PowerClearRequest, PowerCreateRequest, PowerRequestDisplayRequired,
    PowerRequestSystemRequired, PowerSetRequest,
};
use windows::Win32::System::Threading::{
    POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
};
use windows::core::PWSTR;

/// `POWER_REQUEST_CONTEXT_VERSION` (in a feature this crate does not need).
const CONTEXT_VERSION: u32 = 0;
const REQUESTS: [POWER_REQUEST_TYPE; 2] = [PowerRequestDisplayRequired, PowerRequestSystemRequired];

/// How many guards are alive; the request follows zero and non-zero.
#[derive(Default)]
struct Users(usize);
impl Users {
    /// Whether this was the first user.
    fn enter(&mut self) -> bool {
        self.0 += 1;
        self.0 == 1
    }
    /// Whether this was the last user.
    fn leave(&mut self) -> bool {
        self.0 = self.0.saturating_sub(1);
        self.0 == 0
    }
}

struct State {
    users: Users,
    /// The request's handle as an integer, so the state can be a static.
    request: Option<isize>,
}
static STATE: Mutex<State> = Mutex::new(State { users: Users(0), request: None });

/// Held while a player has video running and not paused.
pub struct KeepAwake(());
impl KeepAwake {
    pub fn new() -> Self {
        let mut state = STATE.lock().unwrap_or_else(|poison| poison.into_inner());
        if state.users.enter() {
            // Failing to keep the screen on must never stop playback.
            state.request = request().ok().map(|handle| handle.0 as isize);
        }
        Self(())
    }
}
impl Drop for KeepAwake {
    fn drop(&mut self) {
        let mut state = STATE.lock().unwrap_or_else(|poison| poison.into_inner());
        if state.users.leave()
            && let Some(handle) = state.request.take()
        {
            let handle = HANDLE(handle as *mut _);
            unsafe {
                for kind in REQUESTS {
                    let _ = PowerClearRequest(handle, kind);
                }
                let _ = CloseHandle(handle);
            }
        }
    }
}

fn request() -> windows::core::Result<HANDLE> {
    let mut reason: Vec<u16> = "VioletWire is playing a stream".encode_utf16().chain([0]).collect();
    let context = REASON_CONTEXT {
        Version: CONTEXT_VERSION,
        Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
        Reason: REASON_CONTEXT_0 { SimpleReasonString: PWSTR(reason.as_mut_ptr()) },
    };
    unsafe {
        let handle = PowerCreateRequest(&context)?;
        for kind in REQUESTS {
            if let Err(error) = PowerSetRequest(handle, kind) {
                let _ = CloseHandle(handle);
                return Err(error);
            }
        }
        Ok(handle)
    }
}

#[cfg(test)]
mod tests {
    use super::Users;

    #[test]
    fn the_request_follows_the_first_and_last_user() {
        let mut users = Users::default();
        assert!(users.enter());
        assert!(!users.enter());
        assert!(!users.leave());
        assert!(users.leave());
        assert!(users.enter());
    }
}
