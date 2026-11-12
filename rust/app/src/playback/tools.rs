//! Finds the external programs playback uses: Streamlink (run through its own
//! bundled Python, so there is no launcher process in between) and FFmpeg.

use std::env;
use std::path::{Path, PathBuf};

use anyhow::{Result, bail};

pub struct Tools {
    /// Streamlink's bundled `python.exe`; run with `-m streamlink_cli`.
    pub streamlink_python: PathBuf,
    pub ffmpeg: PathBuf,
}

pub fn find() -> Result<Tools> {
    let roots = streamlink_roots();
    let Some(root) = roots.iter().find(|root| is_streamlink_root(root)) else {
        bail!(
            "Streamlink was not found. Install it from streamlink.github.io, \
             or set VIOLETWIRE_STREAMLINK_ROOT to its folder."
        );
    };
    let ffmpeg = env::var_os("VIOLETWIRE_FFMPEG_PATH")
        .map(PathBuf::from)
        .into_iter()
        .chain(
            roots
                .iter()
                .map(|root| root.join("ffmpeg").join("ffmpeg.exe")),
        )
        .chain(search_path("ffmpeg.exe"))
        .find(|path| path.is_file());
    let Some(ffmpeg) = ffmpeg else {
        bail!(
            "FFmpeg was not found. Streamlink's Windows installer includes it, or set VIOLETWIRE_FFMPEG_PATH."
        );
    };
    Ok(Tools {
        streamlink_python: root.join("Python").join("python.exe"),
        ffmpeg,
    })
}

pub fn streamlink_python() -> Result<PathBuf> {
    streamlink_roots()
        .iter()
        .find(|root| is_streamlink_root(root))
        .map(|root| root.join("Python").join("python.exe"))
        .ok_or_else(|| anyhow::anyhow!("Streamlink was not found."))
}

fn streamlink_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(root) = env::var_os("VIOLETWIRE_STREAMLINK_ROOT") {
        roots.push(PathBuf::from(root));
    }
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        roots.push(Path::new(&local).join("Programs").join("Streamlink"));
    }
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(programs) = env::var_os(variable) {
            roots.push(Path::new(&programs).join("Streamlink"));
        }
    }
    roots
}

fn is_streamlink_root(root: &Path) -> bool {
    root.join("Python").join("python.exe").is_file()
        && root
            .join("pkgs")
            .join("streamlink_cli")
            .join("__main__.py")
            .is_file()
}

fn search_path(program: &str) -> Option<PathBuf> {
    env::split_paths(&env::var_os("PATH")?)
        .map(|directory| directory.join(program))
        .find(|candidate| candidate.is_file())
}
