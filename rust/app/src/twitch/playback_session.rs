//! The Twitch website session used for stream lookups only, as in Electron's
//! "playback session". With it, Twitch serves Turbo users and a channel's
//! subscribers their ad-free stream. The app's own OAuth token cannot do this:
//! Twitch's playback endpoint accepts only its website sign-in.
//!
//! The user signs in on twitch.tv itself, in an InPrivate WebView2 window (see
//! `crate::playback_link`); the app never sees a password. The session token
//! lives in Windows Credential Manager, never in a file, a log, or argv.

use std::sync::{Mutex, PoisonError};

use anyhow::{Context as _, Result, bail};
use serde::{Deserialize, Serialize};

const SERVICE: &str = "VioletWire";
const ACCOUNT: &str = "twitch-playback-session";

#[derive(Clone, Serialize, Deserialize)]
struct Stored {
    token: String,
    login: Option<String>,
}

struct State {
    stored: Option<Stored>,
    /// Twitch refused the token; lookups go anonymous until relinked.
    expired: bool,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

#[derive(Clone, PartialEq, Eq)]
pub enum Status {
    Unlinked,
    Linked(Option<String>),
    Expired(Option<String>),
}

fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, ACCOUNT).context("Windows Credential Manager is unavailable.")
}

fn with_state<T>(read: impl FnOnce(&mut State) -> T) -> T {
    let mut state = STATE.lock().unwrap_or_else(PoisonError::into_inner);
    let state = state.get_or_insert_with(|| State {
        stored: entry()
            .ok()
            .and_then(|entry| entry.get_password().ok())
            .and_then(|saved| serde_json::from_str::<Stored>(&saved).ok())
            .filter(|stored| is_token(&stored.token)),
        expired: false,
    });
    read(state)
}

/// Twitch's website tokens are short and alphanumeric; anything else is not
/// one, and must never reach a header.
pub fn is_token(token: &str) -> bool {
    (20..=64).contains(&token.len()) && token.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

/// The token for a lookup, unless none is linked or Twitch refused it.
pub fn token() -> Option<String> {
    with_state(|state| {
        (!state.expired)
            .then(|| state.stored.as_ref().map(|stored| stored.token.clone()))
            .flatten()
    })
}

pub fn status() -> Status {
    with_state(|state| match &state.stored {
        None => Status::Unlinked,
        Some(stored) if state.expired => Status::Expired(stored.login.clone()),
        Some(stored) => Status::Linked(stored.login.clone()),
    })
}

/// Twitch answered 401 for `token`. Lookups continue anonymously.
pub fn mark_expired(token: &str) {
    with_state(|state| {
        if state.stored.as_ref().is_some_and(|stored| stored.token == token) {
            state.expired = true;
        }
    });
    crate::playback::resolver::forget_cached();
}

pub fn save(token: String, login: Option<String>) -> Result<()> {
    if !is_token(&token) {
        bail!("Twitch sent an unexpected session.");
    }
    let stored = Stored { token, login };
    let serialized = serde_json::to_string(&stored).context("Could not save the session.")?;
    entry()?
        .set_password(&serialized)
        .map_err(|_| anyhow::anyhow!("Could not save the session."))?;
    with_state(|state| {
        state.stored = Some(stored);
        state.expired = false;
    });
    crate::playback::resolver::forget_cached();
    Ok(())
}

pub fn unlink() -> Result<()> {
    with_state(|state| {
        state.stored = None;
        state.expired = false;
    });
    crate::playback::resolver::forget_cached();
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => bail!("Could not remove the saved session."),
    }
}

#[derive(Deserialize)]
struct Validation {
    login: Option<String>,
}

/// Asks Twitch whose session this is. `Ok(None)` when Twitch could not be
/// reached: the session can still work for playback.
pub fn validate(token: &str) -> Result<Option<String>> {
    let response = crate::http::agent()
        .get("https://id.twitch.tv/oauth2/validate")
        .header("Authorization", &format!("OAuth {token}"))
        .call();
    let Ok(mut response) = response else {
        return Ok(None);
    };
    match response.status().as_u16() {
        200 => Ok(response
            .body_mut()
            .with_config()
            .limit(16 * 1024)
            .read_json::<Validation>()
            .ok()
            .and_then(|validation| validation.login)
            .filter(|login| crate::format::is_login(login))),
        401 => bail!("Twitch did not accept that sign-in."),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::is_token;

    #[test]
    fn accepts_only_plain_tokens() {
        assert!(is_token("abcdefghijklmnopqrstuvwxyz0123"));
        assert!(!is_token("short"));
        assert!(!is_token("abcdefghijklmnopqrstuvwxyz 0123"));
        assert!(!is_token("abcdefghijklmnopqrstuvwxyz0123\r\nX-Evil: 1"));
    }
}
