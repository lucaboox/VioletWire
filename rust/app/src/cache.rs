//! Electron's emote caches on disk (`emote-image-store.ts` and the persisted
//! third-party emote sets): emote images by URL (an emote's image never
//! changes for one URL) and the emote lists each channel loads, so reopening
//! a channel shows its emotes at once and draws them without downloading.
//!
//! Files live under `%LOCALAPPDATA%\VioletWireRust\cache`, named by a hash of
//! the URL. They hold only public emote images and emote metadata.

use std::path::PathBuf;
use std::time::SystemTime;

#[derive(Clone, Copy)]
pub enum Kind {
    Images,
    EmoteSets,
}

impl Kind {
    fn folder(self) -> &'static str {
        match self {
            Self::Images => "images",
            Self::EmoteSets => "emote-sets",
        }
    }
    /// Oldest files go first beyond this.
    fn limit(self) -> u64 {
        match self {
            Self::Images => 512 * 1024 * 1024,
            Self::EmoteSets => 64 * 1024 * 1024,
        }
    }
}

fn root() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|path| PathBuf::from(path).join("VioletWireRust").join("cache"))
}

/// FNV-1a: stable across runs and builds, unlike `DefaultHasher`.
fn name(key: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in key.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn path(kind: Kind, key: &str) -> Option<PathBuf> {
    Some(root()?.join(kind.folder()).join(name(key)))
}

pub fn read(kind: Kind, key: &str) -> Option<Vec<u8>> {
    std::fs::read(path(kind, key)?).ok()
}

pub fn write(kind: Kind, key: &str, bytes: &[u8]) {
    let Some(path) = path(kind, key) else { return };
    let Some(folder) = path.parent() else { return };
    let _ = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(folder)?;
        let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
        std::fs::write(&temporary, bytes)?;
        std::fs::rename(temporary, &path)
    })();
}

/// Total bytes on disk.
pub fn size() -> u64 {
    [Kind::Images, Kind::EmoteSets]
        .into_iter()
        .filter_map(|kind| Some(root()?.join(kind.folder())))
        .filter_map(|folder| std::fs::read_dir(folder).ok())
        .flatten()
        .filter_map(|entry| entry.ok()?.metadata().ok())
        .map(|metadata| metadata.len())
        .sum()
}

pub fn clear() {
    if let Some(root) = root() {
        let _ = std::fs::remove_dir_all(root);
    }
}

/// Drops the least recently written files beyond each kind's limit. Run once
/// at start-up, off the UI thread.
pub fn prune() {
    for kind in [Kind::Images, Kind::EmoteSets] {
        let Some(folder) = root().map(|root| root.join(kind.folder())) else { continue };
        let Ok(entries) = std::fs::read_dir(folder) else { continue };
        let mut files: Vec<(SystemTime, u64, PathBuf)> = entries
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let metadata = entry.metadata().ok()?;
                Some((metadata.modified().ok()?, metadata.len(), entry.path()))
            })
            .collect();
        let mut total: u64 = files.iter().map(|(_, size, _)| size).sum();
        files.sort_by_key(|(modified, _, _)| *modified);
        for (_, size, path) in files {
            if total <= kind.limit() {
                break;
            }
            if std::fs::remove_file(path).is_ok() {
                total = total.saturating_sub(size);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::name;

    #[test]
    fn names_are_stable_and_distinct() {
        assert_eq!(name("https://cdn.7tv.app/emote/a/2x.webp"), name("https://cdn.7tv.app/emote/a/2x.webp"));
        assert_ne!(name("a"), name("b"));
        assert_eq!(name("").len(), 16);
    }
}
