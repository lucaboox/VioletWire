//! The Twitch token lives in Windows Credential Manager, encrypted for the
//! signed-in Windows user. It is never written to a file, a log, or argv.
//!
//! Each sign-in is an epoch. Signing out starts a new one, so a refresh that
//! was already in flight cannot save its token back after the user left.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context as _, Result, bail};

use super::auth::Token;

const SERVICE: &str = "VioletWire";
const ACCOUNT: &str = "twitch-oauth";

static LOCK: Mutex<()> = Mutex::new(());
static EPOCH: AtomicU64 = AtomicU64::new(0);

fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, ACCOUNT).context("Windows Credential Manager is unavailable.")
}

pub fn epoch() -> u64 {
    EPOCH.load(Ordering::SeqCst)
}

/// Ends the current epoch at once; the stored entry is removed by [`clear`].
pub fn end_epoch() -> u64 {
    EPOCH.fetch_add(1, Ordering::SeqCst) + 1
}

pub fn load() -> Result<Option<Token>> {
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match entry()?.get_password() {
        Ok(saved) => match serde_json::from_str(&saved) {
            Ok(token) => Ok(Some(token)),
            // An unreadable entry is useless; drop it and ask for sign-in.
            Err(_) => {
                let _ = entry()?.delete_credential();
                Ok(None)
            }
        },
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => bail!("Could not read the saved Twitch sign-in."),
    }
}

/// Saves only while `epoch` is still current. Returns false when the user
/// signed out in the meantime.
pub fn save(epoch: u64, token: &Token) -> Result<bool> {
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if epoch != self::epoch() {
        return Ok(false);
    }
    let serialized = serde_json::to_string(token).context("Could not save the Twitch sign-in.")?;
    entry()?
        .set_password(&serialized)
        .map_err(|_| anyhow::anyhow!("Could not save the Twitch sign-in."))?;
    Ok(true)
}

pub fn clear() -> Result<()> {
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => bail!("Could not remove the saved Twitch sign-in."),
    }
}
