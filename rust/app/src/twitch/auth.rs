//! Official Twitch Device Code sign-in. No password, no browser cookies, no
//! client secret: the user approves VioletWire on twitch.tv in their browser.

use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, bail};
use serde::{Deserialize, Serialize};

use crate::http::short_message;

/// Twitch documents Client IDs as public identifiers. This is VioletWire's
/// public Device Code client, shared with the Electron build.
pub const CLIENT_ID: &str = "muthgxeegar3t0hj2qwm0ozocqbt8o";

pub const SCOPES: &[&str] = &[
    "user:read:follows",
    "user:read:subscriptions",
    "clips:edit",
    "user:read:chat",
    "user:write:chat",
    "user:read:emotes",
    "user:manage:chat_color",
    "user:read:moderated_channels",
    "moderator:manage:banned_users",
    "moderator:manage:chat_messages",
    "moderator:manage:announcements",
    "moderator:manage:chat_settings",
    "moderator:manage:warnings",
    "moderator:manage:shield_mode",
];

#[derive(Clone, Serialize, Deserialize)]
pub struct Token {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Unix seconds.
    pub expires_at: u64,
    #[serde(default)]
    pub scopes: Vec<String>,
}

// Never print a token, even by accident in a debug log.
impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Token")
            .field("expires_at", &self.expires_at)
            .field("scopes", &self.scopes.len())
            .finish_non_exhaustive()
    }
}

impl Token {
    /// True when the token expires within `margin` seconds.
    pub fn expires_within(&self, margin: u64) -> bool {
        self.expires_at <= now() + margin
    }
}

#[derive(Debug, Deserialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

pub enum Poll {
    Pending,
    SlowDown,
    Approved(Token),
}

#[derive(Debug, Clone)]
pub struct Identity {
    pub user_id: String,
    pub login: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
    #[serde(default)]
    scope: Vec<String>,
}

impl From<TokenResponse> for Token {
    fn from(value: TokenResponse) -> Self {
        Token {
            access_token: value.access_token,
            refresh_token: value.refresh_token,
            expires_at: now() + value.expires_in,
            scopes: value.scope,
        }
    }
}

#[derive(Deserialize)]
struct ErrorResponse {
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
struct ValidateResponse {
    client_id: String,
    login: String,
    user_id: String,
}

pub fn start_device_flow(agent: &ureq::Agent) -> Result<DeviceCode> {
    let scopes = SCOPES.join(" ");
    let mut response = agent
        .post("https://id.twitch.tv/oauth2/device")
        .send_form([("client_id", CLIENT_ID), ("scopes", scopes.as_str())])
        .context("Could not reach Twitch.")?;
    if !response.status().is_success() {
        bail!(error_text(&mut response, "Twitch would not start sign-in."));
    }
    response
        .body_mut()
        .read_json()
        .context("Twitch sent an unexpected sign-in reply.")
}

pub fn poll_device_flow(agent: &ureq::Agent, device_code: &str) -> Result<Poll> {
    let scopes = SCOPES.join(" ");
    let mut response = agent
        .post("https://id.twitch.tv/oauth2/token")
        .send_form([
            ("client_id", CLIENT_ID),
            ("scopes", scopes.as_str()),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .context("Could not reach Twitch.")?;
    if response.status().is_success() {
        let token: TokenResponse = response
            .body_mut()
            .read_json()
            .context("Twitch sent an unexpected token.")?;
        return Ok(Poll::Approved(token.into()));
    }
    let message = error_text(&mut response, "Twitch sign-in failed.");
    let lower = message.to_ascii_lowercase();
    if lower.contains("authorization_pending") {
        Ok(Poll::Pending)
    } else if lower.contains("slow_down") {
        Ok(Poll::SlowDown)
    } else {
        bail!(message)
    }
}

/// Twitch rotates refresh tokens, so the caller must save the result before
/// anything else can refresh again. `Ok(None)` means Twitch refused the
/// refresh token and the user has to sign in again; `Err` is a network or
/// server problem worth retrying later.
pub fn refresh(agent: &ureq::Agent, refresh_token: &str) -> Result<Option<Token>> {
    let mut response = agent
        .post("https://id.twitch.tv/oauth2/token")
        .send_form([
            ("client_id", CLIENT_ID),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ])
        .context("Could not reach Twitch.")?;
    match response.status().as_u16() {
        200..=299 => {
            let token: TokenResponse = response
                .body_mut()
                .read_json()
                .context("Twitch sent an unexpected token.")?;
            Ok(Some(token.into()))
        }
        400 | 401 => Ok(None),
        _ => bail!(error_text(&mut response, "Twitch could not renew the session.")),
    }
}

/// `Ok(None)` means Twitch no longer accepts the token (or it belongs to a
/// different client), so it should be refreshed or discarded.
pub fn validate(agent: &ureq::Agent, access_token: &str) -> Result<Option<Identity>> {
    let mut response = agent
        .get("https://id.twitch.tv/oauth2/validate")
        .header("Authorization", format!("OAuth {access_token}"))
        .call()
        .context("Could not reach Twitch.")?;
    if response.status().as_u16() == 401 {
        return Ok(None);
    }
    if !response.status().is_success() {
        bail!(error_text(&mut response, "Twitch could not check the session."));
    }
    let reply: ValidateResponse = response
        .body_mut()
        .read_json()
        .context("Twitch sent an unexpected session check.")?;
    if reply.client_id != CLIENT_ID {
        return Ok(None);
    }
    Ok(Some(Identity {
        user_id: reply.user_id,
        login: reply.login,
    }))
}

/// Best effort: a failed revoke still signs out locally.
pub fn revoke(agent: &ureq::Agent, access_token: &str) {
    let _ = agent
        .post("https://id.twitch.tv/oauth2/revoke")
        .send_form([("client_id", CLIENT_ID), ("token", access_token)]);
}

/// Only open sign-in pages on Twitch's own HTTPS hosts.
pub fn is_twitch_activation_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    host == "www.twitch.tv" || host == "twitch.tv" || host == "id.twitch.tv"
}

fn error_text(response: &mut ureq::http::Response<ureq::Body>, fallback: &str) -> String {
    response
        .body_mut()
        .read_json::<ErrorResponse>()
        .ok()
        .map(|error| short_message(&error.message))
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_only_twitch_activation_pages() {
        assert!(is_twitch_activation_url("https://www.twitch.tv/activate?device-code=ABCD"));
        assert!(is_twitch_activation_url("https://id.twitch.tv/activate"));
        assert!(!is_twitch_activation_url("http://www.twitch.tv/activate"));
        assert!(!is_twitch_activation_url("https://www.twitch.tv.example.com/activate"));
        assert!(!is_twitch_activation_url("https://evil.example/?https://www.twitch.tv"));
        assert!(!is_twitch_activation_url("file:///c:/windows"));
    }

    #[test]
    fn token_debug_output_hides_secrets() {
        let token = Token {
            access_token: "private-access".into(),
            refresh_token: Some("private-refresh".into()),
            expires_at: 1,
            scopes: vec![],
        };
        let printed = format!("{token:?}");
        assert!(!printed.contains("private"));
    }
}
