//! Kick lookups run through Streamlink's Kick plugin (`kick-helper.py`),
//! which deals with Kick's browser check. One helper process stays up and
//! answers one request at a time, so a check is solved once and its cookies
//! serve the rest, and Python starts only once.
use super::{job::Job, tools};
use anyhow::{Context as _, Result, bail};
use serde_json::Value;
use std::{
    io::{BufRead as _, BufReader, Read as _, Write as _},
    os::windows::process::CommandExt as _,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Mutex, PoisonError, mpsc},
    time::Duration,
};

const SCRIPT: &str = include_str!("kick-helper.py");
const LIMIT: u64 = 4 * 1024 * 1024;

struct Helper {
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<String>,
    next: u64,
    _job: Job,
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

static HELPER: Mutex<Option<Helper>> = Mutex::new(None);

impl Helper {
    fn start() -> Result<Self> {
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
        let stdin = child.stdin.take().context("Streamlink pipe unavailable.")?;
        let stdout = child.stdout.take().context("Streamlink pipe unavailable.")?;
        let (send, lines) = mpsc::sync_channel(4);
        std::thread::Builder::new().name("vw-kick-helper".into()).spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match reader.by_ref().take(LIMIT).read_line(&mut line) {
                    Ok(1..) if line.ends_with('\n') => {}
                    _ => break,
                }
                if send.send(line).is_err() {
                    break;
                }
            }
        })?;
        let mut helper = Self { child, stdin, lines, next: 0, _job: job };
        let ready: Value = serde_json::from_str(
            &helper.lines.recv_timeout(Duration::from_secs(20)).context("Streamlink did not start.")?,
        )?;
        if ready["ready"] != true {
            bail!("Streamlink did not start.");
        }
        helper.next = 1;
        Ok(helper)
    }

    fn ask(&mut self, mut request: Value) -> Result<Value> {
        let id = self.next;
        self.next += 1;
        request["id"] = id.into();
        writeln!(self.stdin, "{request}")?;
        self.stdin.flush()?;
        // A first browser check can take a while.
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            let line = self.lines.recv_timeout(left).map_err(|_| anyhow::anyhow!("Kick took too long to answer."))?;
            let value: Value = serde_json::from_str(&line).context("Streamlink sent an unexpected Kick answer.")?;
            // An answer to an abandoned request is skipped.
            if value["id"] == id {
                return Ok(value);
            }
        }
    }
}

/// Runs one lookup through the helper, starting it if needed.
fn query(request: Value) -> Result<Value> {
    let mut helper = HELPER.lock().unwrap_or_else(PoisonError::into_inner);
    if helper.as_mut().is_none_or(|helper| helper.child.try_wait().ok().flatten().is_some()) {
        *helper = Some(Helper::start()?);
    }
    let answer = helper.as_mut().map(|running| running.ask(request));
    let mut value = match answer {
        Some(Ok(value)) => value,
        Some(Err(error)) => {
            // A stuck or broken helper is replaced next time.
            *helper = None;
            return Err(error);
        }
        None => bail!("Streamlink is unavailable."),
    };
    drop(helper);
    match value["error"].as_str() {
        None => Ok(value["data"].take()),
        Some("offline") => bail!("This Kick channel is offline."),
        Some("PluginError") => bail!("Kick refused the lookup. Try again later."),
        Some(_) => bail!("Could not reach Kick."),
    }
}

/// A Kick API GET (`https://kick.com/...` or `https://web.kick.com/...`).
pub fn get(url: &str) -> Result<Value> {
    if !(url.starts_with("https://kick.com/") || url.starts_with("https://web.kick.com/")) {
        bail!("Not a Kick address.");
    }
    query(serde_json::json!({"kind": "get", "url": url}))
}

/// Stops the helper (at exit).
pub fn shutdown() {
    HELPER.lock().unwrap_or_else(PoisonError::into_inner).take();
}

/// The channel's qualities and playlist addresses.
pub fn streams(slug: &str) -> Result<Vec<super::twitch::Variant>> {
    if !crate::kick::is_slug(slug) {
        bail!("Invalid Kick channel.");
    }
    let value = query(serde_json::json!({"kind": "streams", "slug": slug}))?;
    if value.as_object().is_none_or(serde_json::Map::is_empty) {
        bail!("This Kick channel is offline.");
    }
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
        (
            name == "audio_only",
            std::cmp::Reverse(height.parse::<u32>().unwrap_or(0)),
            std::cmp::Reverse(fps.parse::<u32>().unwrap_or(30)),
        )
    };
    variants.sort_by_key(|variant| rank(&variant.name));
    if variants.is_empty() {
        bail!("Kick's playlist listed no qualities.");
    }
    Ok(variants)
}

/// Percent-encodes a query value.
pub fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}
