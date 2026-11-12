//! One shared HTTP agent. Calls are blocking, so they run on GPUI's background
//! executor, never on the UI thread.

use std::time::Duration;

/// A non-2xx status is a normal answer from Twitch (pending sign-in, an expired
/// token), so it comes back as a response instead of an error.
pub fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(20)))
        .user_agent(concat!("VioletWire/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

/// Server error text is untrusted and may be long; keep a short single line.
pub fn short_message(text: &str) -> String {
    let line: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(200)
        .collect();
    line.trim().to_string()
}
