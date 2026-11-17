//! Updates from the project's GitHub releases (Electron's `UpdateService`
//! uses electron-updater against the same releases). A release carries the
//! Rust app only when it has a `violetwire-rust.json` manifest naming the
//! installer and its SHA-256; Electron-only releases are passed over. The
//! installer is downloaded, checked against that hash, and started; the app
//! then quits so it can be replaced.

use std::io::Read as _;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context as _, Result, bail};
use serde_json::Value;
use sha2::{Digest as _, Sha256};

const REPOSITORY: &str = "lucaboox/VioletWire";
pub const MANIFEST: &str = "violetwire-rust.json";
const MAX_INSTALLER: u64 = 400 * 1024 * 1024;

pub fn current() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[derive(Clone, Debug)]
pub struct Update {
    pub version: String,
    file: String,
    url: String,
    sha256: String,
}

/// Major, minor, patch, and any pre-release label and number.
type Version = (u64, u64, u64, Option<(String, u64)>);

/// `0.3.4-alpha.25` as comparable parts; a release outranks its pre-releases.
fn parse(version: &str) -> Option<Version> {
    let version = version.trim().trim_start_matches('v');
    let (core, pre) = version.split_once('-').map_or((version, None), |(core, pre)| (core, Some(pre)));
    let mut numbers = core.split('.').map(|part| part.parse::<u64>().ok());
    let (major, minor, patch) = (numbers.next()??, numbers.next()??, numbers.next()??);
    if numbers.next().is_some() {
        return None;
    }
    let pre = match pre {
        None => None,
        Some(pre) => {
            let (label, number) = pre.rsplit_once('.').unwrap_or((pre, "0"));
            Some((label.to_ascii_lowercase(), number.parse().ok()?))
        }
    };
    Some((major, minor, patch, pre))
}

pub fn newer(candidate: &str, current: &str) -> bool {
    let (Some(a), Some(b)) = (parse(candidate), parse(current)) else { return false };
    if (a.0, a.1, a.2) != (b.0, b.1, b.2) {
        return (a.0, a.1, a.2) > (b.0, b.1, b.2);
    }
    match (&a.3, &b.3) {
        (None, Some(_)) => true,
        (Some(_), None) | (None, None) => false,
        (Some(x), Some(y)) => x > y,
    }
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(20)))
        .user_agent(concat!("VioletWire/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

fn get_json(agent: &ureq::Agent, url: &str, limit: u64) -> Result<Value> {
    let mut response = agent
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .call()
        .context("Could not reach GitHub.")?;
    if !response.status().is_success() {
        bail!("GitHub answered {}.", response.status().as_u16());
    }
    Ok(response.body_mut().with_config().limit(limit).read_json()?)
}

/// Asset downloads are on github.com and redirect to GitHub's storage.
fn asset_url(url: &str) -> bool {
    url.starts_with(&format!("https://github.com/{REPOSITORY}/releases/download/"))
}

/// The newest release with a Rust build, if it is newer than this one.
/// Pre-releases count while this build is one, as electron-updater does.
pub fn check() -> Result<Option<Update>> {
    let agent = agent();
    let releases = get_json(&agent, &format!("https://api.github.com/repos/{REPOSITORY}/releases?per_page=50"), 2 * 1024 * 1024)?;
    let prerelease_ok = current().contains('-');
    for release in releases.as_array().into_iter().flatten() {
        if release["draft"].as_bool().unwrap_or(true) || (release["prerelease"].as_bool().unwrap_or(false) && !prerelease_ok) {
            continue;
        }
        let assets = release["assets"].as_array().cloned().unwrap_or_default();
        let named = |name: &str| {
            assets
                .iter()
                .find(|asset| asset["name"] == name)
                .and_then(|asset| asset["browser_download_url"].as_str())
                .filter(|url| asset_url(url))
                .map(str::to_owned)
        };
        let Some(manifest_url) = named(MANIFEST) else { continue };
        let manifest = get_json(&agent, &manifest_url, 64 * 1024)?;
        let version = manifest["version"].as_str().unwrap_or_default().to_owned();
        let file = manifest["file"].as_str().unwrap_or_default().to_owned();
        let sha256 = manifest["sha256"].as_str().unwrap_or_default().to_ascii_lowercase();
        let file_ok = file.ends_with(".exe")
            && !file.contains(['/', '\\', ':'])
            && file.bytes().all(|b| b.is_ascii_graphic());
        if parse(&version).is_none() || !file_ok || sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let Some(url) = named(&file) else { continue };
        if !newer(&version, current()) {
            return Ok(None);
        }
        return Ok(Some(Update { version, file, url, sha256 }));
    }
    Ok(None)
}

/// Downloads the installer, checks it, and returns its path.
pub fn download(update: &Update) -> Result<PathBuf> {
    let directory = std::env::temp_dir().join("VioletWireUpdate");
    std::fs::create_dir_all(&directory)?;
    let path = directory.join(&update.file);
    let mut response = agent()
        .get(&update.url)
        .config()
        .timeout_global(Some(Duration::from_secs(600)))
        .build()
        .call()
        .context("Could not download the update.")?;
    if !response.status().is_success() {
        bail!("GitHub answered {}.", response.status().as_u16());
    }
    let mut bytes = Vec::new();
    response
        .body_mut()
        .with_config()
        .limit(MAX_INSTALLER)
        .reader()
        .read_to_end(&mut bytes)
        .context("The update download failed.")?;
    let digest = Sha256::digest(&bytes);
    let actual: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    if actual != update.sha256 {
        bail!("The downloaded update did not match its checksum, so it was not installed.");
    }
    std::fs::write(&path, &bytes)?;
    Ok(path)
}

/// Starts the checked installer (quietly, relaunching VioletWire after).
pub fn install(installer: &std::path::Path) -> Result<()> {
    std::process::Command::new(installer)
        .args(["/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/RELAUNCH"])
        .spawn()
        .context("Could not start the installer.")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Downloads a real release asset and checks the hash is enforced:
    /// `cargo test -p violetwire -- --ignored downloads_and_checks`.
    #[test]
    #[ignore = "uses the network"]
    fn downloads_and_checks_release_assets() {
        let url = format!("https://github.com/{REPOSITORY}/releases/download/v0.3.4-alpha.25/latest.yml");
        let bytes = agent().get(&url).call().unwrap().body_mut().read_to_vec().unwrap();
        let sha256: String = Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect();
        let update = |sha256: String| Update { version: "0.0.0".into(), file: "latest.yml".into(), url: url.clone(), sha256 };
        let path = download(&update(sha256)).expect("the right hash is accepted");
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let error = download(&update("0".repeat(64))).expect_err("a wrong hash is refused");
        assert!(error.to_string().contains("checksum"));
    }

    #[test]
    fn compares_versions_like_semver() {
        assert!(newer("0.3.4-alpha.26", "0.3.4-alpha.25"));
        assert!(newer("0.3.4", "0.3.4-alpha.25"));
        assert!(newer("0.3.5-alpha.1", "0.3.4"));
        assert!(newer("v1.0.0", "0.9.9"));
        assert!(!newer("0.3.4-alpha.25", "0.3.4-alpha.25"));
        assert!(!newer("0.3.4-alpha.9", "0.3.4-alpha.25"));
        assert!(!newer("0.3.3", "0.3.4-alpha.1"));
        assert!(!newer("nonsense", "0.1.0"));
        assert!(asset_url("https://github.com/lucaboox/VioletWire/releases/download/v1/x.exe"));
        assert!(!asset_url("https://evil.example/lucaboox/VioletWire/releases/download/x.exe"));
    }
}
