//! Kick lookups run through Streamlink's Kick plugin (`kick-helper.py`),
//! which deals with Kick's browser check. Lookups run one at a time so a
//! check is solved once and its cookies serve the rest.
use super::{job::Job, tools};
use anyhow::{Context as _, Result, bail};
use serde_json::Value;
use std::{
    io::{BufRead as _, BufReader, Read as _, Write as _},
    os::windows::process::CommandExt as _,
    process::{Command, Stdio},
    sync::{Mutex, PoisonError, mpsc},
    time::Duration,
};

const SCRIPT: &str = include_str!("kick-helper.py");
const LIMIT: u64 = 4 * 1024 * 1024;
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

/// Runs one lookup; `request` holds a validated slug and the kind.
pub fn query(request: &Value) -> Result<Value> {
    let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(PoisonError::into_inner);
    let job = Job::new()?;
    let mut child = Command::new(tools::streamlink_python()?)
        .args(["-u", "-c", SCRIPT])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000)
        .spawn()
        .context("Could not start Streamlink for Kick.")?;
    if let Err(error) = job.assign(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    {
        let mut stdin = child.stdin.take().context("Streamlink pipe unavailable.")?;
        writeln!(stdin, "{request}")?;
    }
    let stdout = child.stdout.take().context("Streamlink pipe unavailable.")?;
    let (send, line) = mpsc::sync_channel(1);
    std::thread::Builder::new().name("vw-kick-helper".into()).spawn(move || {
        let mut text = String::new();
        let read = BufReader::new(stdout).take(LIMIT).read_line(&mut text);
        let _ = send.send(read.map(|_| text));
    })?;
    // A first browser check can take a while.
    let answer = line.recv_timeout(Duration::from_secs(60));
    let _ = child.kill();
    let _ = child.wait();
    let text = match answer {
        Ok(Ok(text)) if text.ends_with('\n') => text,
        Err(_) => bail!("Kick took too long to answer."),
        _ => bail!("Streamlink gave no Kick answer."),
    };
    let mut value: Value = serde_json::from_str(&text).context("Streamlink sent an unexpected Kick answer.")?;
    match value["error"].as_str() {
        None => Ok(value["data"].take()),
        Some("offline") => bail!("This Kick channel is offline."),
        Some("PluginError") => bail!("Kick refused the lookup. Try again later."),
        Some(_) => bail!("Could not look this Kick channel up."),
    }
}

/// The channel's qualities and playlist addresses.
pub fn streams(slug: &str) -> Result<Vec<super::twitch::Variant>> {
    if !crate::kick::is_slug(slug) {
        bail!("Invalid Kick channel.");
    }
    let value = query(&serde_json::json!({"kind": "streams", "slug": slug}))?;
    let mut variants: Vec<super::twitch::Variant> = value
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(name, _)| super::resolver::is_quality(name))
        .filter_map(|(name, url)| {
            let url = url.as_str()?;
            let host = url.strip_prefix("https://")?.split(['/', '?']).next()?;
            host.ends_with(".live-video.net").then(|| super::twitch::Variant {
                name: name.clone(),
                url: url.to_owned(),
                bandwidth: 0,
            })
        })
        .collect();
    // `1080p60` above `1080p` above `720p60`; audio only last.
    let rank = |name: &str| {
        let (height, fps) = name.split_once('p').unwrap_or((name, ""));
        (name == "audio_only", std::cmp::Reverse(height.parse::<u32>().unwrap_or(0)), std::cmp::Reverse(fps.parse::<u32>().unwrap_or(30)))
    };
    variants.sort_by_key(|variant| rank(&variant.name));
    if variants.is_empty() {
        bail!("Kick's playlist listed no qualities.");
    }
    Ok(variants)
}
