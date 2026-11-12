//! Signed-in session work. Every function here blocks on the network, so the
//! UI calls them through GPUI's background executor.

use anyhow::Result;

use crate::twitch::auth::{self, Identity, Token};
use crate::twitch::helix::{FollowedChannel, Helix, Unauthorized};
use crate::twitch::token_store;

/// Renew a token this long before Twitch would expire it.
const RENEW_MARGIN_SECONDS: u64 = 300;

#[derive(Clone)]
pub struct Session {
    pub token: Token,
    pub identity: Identity,
    pub epoch: u64,
}

pub enum Failure {
    /// Twitch no longer accepts this sign-in.
    SignedOut,
    /// Network or server trouble; the sign-in is still good.
    Other(anyhow::Error),
}

impl From<anyhow::Error> for Failure {
    fn from(error: anyhow::Error) -> Self {
        if error.is::<Unauthorized>() {
            Failure::SignedOut
        } else {
            Failure::Other(error)
        }
    }
}

/// The saved sign-in, checked with Twitch and renewed if needed.
/// `Ok(None)` means there is nothing usable and the user should sign in.
pub fn restore(agent: &ureq::Agent) -> Result<Option<Session>> {
    let epoch = token_store::epoch();
    let Some(token) = token_store::load()? else {
        return Ok(None);
    };
    if !token.expires_within(RENEW_MARGIN_SECONDS)
        && let Some(identity) = auth::validate(agent, &token.access_token)?
    {
        return Ok(Some(Session { token, identity, epoch }));
    }
    let Some(token) = renew(agent, &token, epoch)? else {
        token_store::clear()?;
        return Ok(None);
    };
    match auth::validate(agent, &token.access_token)? {
        Some(identity) => Ok(Some(Session { token, identity, epoch })),
        None => {
            token_store::clear()?;
            Ok(None)
        }
    }
}

/// Checks a newly approved token and stores it for the next launch.
pub fn begin(agent: &ureq::Agent, token: Token, epoch: u64) -> Result<Session> {
    let identity = auth::validate(agent, &token.access_token)?
        .ok_or_else(|| anyhow::anyhow!("Twitch did not accept the new sign-in. Try again."))?;
    token_store::save(epoch, &token)?;
    Ok(Session { token, identity, epoch })
}

pub struct Followed {
    pub channels: Vec<FollowedChannel>,
    /// A renewed token the UI must keep using from now on.
    pub renewed: Option<Token>,
}

/// The followed list, renewing the token first if it is about to expire, or
/// once if Twitch refuses it.
pub fn followed(agent: &ureq::Agent, session: &Session) -> Result<Followed, Failure> {
    let mut token = session.token.clone();
    let mut renewed = None;
    if token.expires_within(RENEW_MARGIN_SECONDS) {
        token = renew(agent, &token, session.epoch)?.ok_or(Failure::SignedOut)?;
        renewed = Some(token.clone());
    }
    let user_id = &session.identity.user_id;
    match Helix::new(agent, &token.access_token).followed_channels(user_id) {
        Ok(channels) => Ok(Followed { channels, renewed }),
        Err(error) if error.is::<Unauthorized>() && renewed.is_none() => {
            let token = renew(agent, &token, session.epoch)?.ok_or(Failure::SignedOut)?;
            let channels = Helix::new(agent, &token.access_token).followed_channels(user_id)?;
            Ok(Followed { channels, renewed: Some(token) })
        }
        Err(error) => Err(error.into()),
    }
}

/// Revokes the token with Twitch and removes it from this PC. The caller has
/// already ended the epoch, so nothing in flight can save it back.
pub fn sign_out(agent: &ureq::Agent, token: &Token) -> Result<()> {
    auth::revoke(agent, &token.access_token);
    token_store::clear()
}

/// Refresh and save in one step: Twitch rotates the refresh token, so the new
/// one must reach Credential Manager before anything can refresh again.
fn renew(agent: &ureq::Agent, token: &Token, epoch: u64) -> Result<Option<Token>> {
    let Some(refresh_token) = token.refresh_token.as_deref() else {
        return Ok(None);
    };
    let Some(fresh) = auth::refresh(agent, refresh_token)? else {
        return Ok(None);
    };
    if !token_store::save(epoch, &fresh)? {
        // Signed out while renewing.
        return Ok(None);
    }
    Ok(Some(fresh))
}
