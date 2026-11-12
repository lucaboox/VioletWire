//! One warm, anonymous resolver per app. Signed URLs stay on private pipes.
//! A bounded queue, cancellation, timeouts and a Job keep switches and exit tidy.
use super::{job::Job, tools};
use anyhow::{Context as _, Result, bail};
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::windows::process::CommandExt,
    process::{Child, Command, Stdio},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

const SCRIPT: &str = include_str!("streamlink-worker.py");
const LIMIT: u64 = 128 * 1024;
struct Request {
    login: String,
    quality: String,
    cancelled: Arc<AtomicBool>,
    reply: mpsc::SyncSender<Result<Resolved>>,
}

/// A playable address and what else the channel offers.
#[derive(Clone)]
pub struct Resolved {
    pub url: String,
    /// Streamlink's names, e.g. `1080p60`, `720p`, `audio_only`; empty when
    /// only the CLI fallback answered.
    pub qualities: Vec<String>,
    /// The quality actually chosen; `best` is the highest on offer.
    pub quality: String,
}
struct Service {
    requests: mpsc::SyncSender<Request>,
    stop: Arc<AtomicBool>,
}
static SERVICE: OnceLock<Service> = OnceLock::new();

pub struct Resolution {
    pub result: mpsc::Receiver<Result<Resolved>>,
    cancelled: Arc<AtomicBool>,
}
impl Drop for Resolution {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
    }
}
pub fn warm_up() {
    SERVICE.get_or_init(|| {
        let (send, receive) = mpsc::sync_channel::<Request>(4);
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        // Process discovery/imports happen off the UI thread, including at launch.
        let _ = std::thread::Builder::new()
            .name("vw-stream-resolver".into())
            .spawn(move || {
                let mut worker = Worker::start().ok();
                while !stopping.load(Ordering::Acquire) {
                    let request = match receive.recv_timeout(Duration::from_millis(100)) {
                        Ok(request) => request,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(_) => break,
                    };
                    if request.cancelled.load(Ordering::Acquire) {
                        continue;
                    }
                    let result = (|| {
                        if worker.is_none() {
                            worker = Worker::start().ok();
                        }
                        if let Some(warm) = &mut worker {
                            match warm.resolve(&request, &stopping) {
                                Ok(Some(resolved)) => return Ok(resolved),
                                Ok(None) => bail!("No playable stream was found."),
                                Err(_) => {
                                    worker = None;
                                }
                            }
                        }
                        if request.cancelled.load(Ordering::Acquire)
                            || stopping.load(Ordering::Acquire)
                        {
                            bail!("Stream lookup cancelled.");
                        }
                        // Retain the CLI compatibility path when the private worker fails.
                        let cold = Worker::cold(&request.login, &request.quality)?;
                        cold.next_url(&request.cancelled, &stopping, &request.quality)?
                            .context("No playable stream was found.")
                    })();
                    let _ = request.reply.try_send(result);
                }
                // Worker::drop terminates and reaps only our own child.
            });
        Service {
            requests: send,
            stop,
        }
    });
}
pub fn shutdown() {
    if let Some(service) = SERVICE.get() {
        service.stop.store(true, Ordering::Release);
    }
}
/// Compare with the previous CLI path without exposing the resolved address.
pub fn probe_cold(login: &str) -> Result<()> {
    if !crate::format::is_login(login) {
        bail!("Invalid Twitch channel.");
    }
    let worker = Worker::cold(login, "best")?;
    worker
        .next_url(&AtomicBool::new(false), &AtomicBool::new(false), "best")?
        .context("No playable stream was found.")?;
    Ok(())
}
pub fn resolve(login: &str, quality: &str) -> Result<Resolution> {
    if !crate::format::is_login(login) {
        bail!("Invalid Twitch channel.");
    }
    if !is_quality(quality) {
        bail!("Invalid stream quality.");
    }
    warm_up();
    let (send, result) = mpsc::sync_channel(1);
    let cancelled = Arc::new(AtomicBool::new(false));
    SERVICE
        .get()
        .unwrap()
        .requests
        .try_send(Request {
            login: login.to_ascii_lowercase(),
            quality: quality.to_owned(),
            cancelled: cancelled.clone(),
            reply: send,
        })
        .map_err(|_| anyhow::anyhow!("Stream resolver is busy."))?;
    Ok(Resolution { result, cancelled })
}

struct Worker {
    child: Child,
    lines: mpsc::Receiver<String>,
    ready: bool,
    _job: Job,
}
impl Worker {
    fn start() -> Result<Self> {
        let mut command = Command::new(tools::streamlink_python()?);
        command.args(["-u", "-c", SCRIPT]);
        Self::spawn(command, false)
    }
    fn cold(login: &str, quality: &str) -> Result<Self> {
        let mut command = Command::new(tools::streamlink_python()?);
        command
            .args([
                "-m",
                "streamlink_cli",
                "--stream-url",
                "--loglevel",
                "error",
                "--twitch-low-latency",
            ])
            .arg(format!("https://www.twitch.tv/{login}"))
            .arg(if quality == "best" {
                "best".to_owned()
            } else {
                format!("{quality},best")
            });
        Self::spawn(command, true)
    }
    fn spawn(mut command: Command, ready: bool) -> Result<Self> {
        let job = Job::new()?;
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000)
            .spawn()
            .context("Could not start the stream resolver.")?;
        if let Err(error) = job.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        let stdout = child.stdout.take().context("Resolver pipe unavailable.")?;
        let (send, lines) = mpsc::sync_channel(2);
        std::thread::Builder::new()
            .name("vw-resolver-pipe".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                loop {
                    let mut line = String::new();
                    if !matches!(
                        reader.by_ref().take(LIMIT + 1).read_line(&mut line),
                        Ok(1..)
                    ) || line.len() as u64 > LIMIT
                        || !line.ends_with('\n')
                    {
                        break;
                    }
                    if send.send(line).is_err() {
                        break;
                    }
                }
            })?;
        Ok(Self {
            child,
            lines,
            ready,
            _job: job,
        })
    }
    fn resolve(&mut self, request: &Request, stop: &AtomicBool) -> Result<Option<Resolved>> {
        if !self.ready {
            let line = self.receive(&request.cancelled, stop)?;
            let value: serde_json::Value = serde_json::from_str(&line)
                .map_err(|_| anyhow::anyhow!("Invalid resolver response."))?;
            if value["ready"] != true {
                bail!("Resolver unavailable.");
            }
            self.ready = true;
        }
        let stdin = self.child.stdin.as_mut().context("Resolver pipe closed.")?;
        writeln!(
            stdin,
            "{}",
            serde_json::json!({"login": request.login, "quality": request.quality})
        )?;
        stdin.flush()?;
        self.next_url(&request.cancelled, stop, &request.quality)
    }
    fn receive(&self, cancelled: &AtomicBool, stop: &AtomicBool) -> Result<String> {
        wait_line(&self.lines, cancelled, stop, Duration::from_secs(10))
    }
    fn next_url(
        &self,
        cancelled: &AtomicBool,
        stop: &AtomicBool,
        requested: &str,
    ) -> Result<Option<Resolved>> {
        parse_response(&self.receive(cancelled, stop)?, requested)
    }
}
fn wait_line(
    lines: &mpsc::Receiver<String>,
    cancelled: &AtomicBool,
    stop: &AtomicBool,
    timeout: Duration,
) -> Result<String> {
    let deadline = Instant::now() + timeout;
    loop {
        if cancelled.load(Ordering::Acquire) || stop.load(Ordering::Acquire) {
            bail!("Stream lookup cancelled.");
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            bail!("Stream lookup timed out.");
        }
        match lines.recv_timeout(remaining.min(Duration::from_millis(50))) {
            Ok(line) => return Ok(line),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => bail!("Stream resolver stopped."),
        }
    }
}
/// Streamlink quality names: `best`, `1080p60`, `audio_only`.
pub fn is_quality(text: &str) -> bool {
    (1..=16).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

// The URL is signed: never print it.
impl std::fmt::Debug for Resolved {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Resolved")
            .field("quality", &self.quality)
            .field("qualities", &self.qualities)
            .finish_non_exhaustive()
    }
}

fn parse_response(line: &str, requested: &str) -> Result<Option<Resolved>> {
    if line.starts_with("https://") {
        // The CLI fallback prints only the address.
        return valid_url(line.trim()).map(|url| {
            Some(Resolved {
                url,
                qualities: Vec::new(),
                quality: requested.to_owned(),
            })
        });
    }
    let value: serde_json::Value =
        serde_json::from_str(line).map_err(|_| anyhow::anyhow!("Invalid resolver response."))?;
    let url = match value.get("url") {
        Some(serde_json::Value::Null) => return Ok(None),
        Some(serde_json::Value::String(url)) => valid_url(url)?,
        _ => bail!("Invalid resolver response."),
    };
    let qualities = value
        .get("qualities")
        .and_then(serde_json::Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(serde_json::Value::as_str)
                .filter(|name| is_quality(name))
                .take(24)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let quality = value
        .get("quality")
        .and_then(serde_json::Value::as_str)
        .filter(|name| is_quality(name))
        .unwrap_or(requested)
        .to_owned();
    Ok(Some(Resolved {
        url,
        qualities,
        quality,
    }))
}
fn valid_url(url: &str) -> Result<String> {
    if url.len() > 64 * 1024 || url.chars().any(char::is_control) {
        bail!("Invalid stream address.");
    }
    let uri = url
        .parse::<ureq::http::Uri>()
        .map_err(|_| anyhow::anyhow!("Invalid stream address."))?;
    if uri.scheme_str() != Some("https") || uri.host().is_none_or(str::is_empty) {
        bail!("Invalid stream address.");
    }
    Ok(url.to_owned())
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn worker_failures_are_distinct_from_offline_and_hide_response_text() {
        assert!(parse_response(r#"{"url":null}"#, "best").unwrap().is_none());
        let resolved = parse_response(
            r#"{"url":"https://example.com/live","qualities":["1080p60","720p","bad name","audio_only"],"quality":"720p"}"#,
            "best",
        )
        .unwrap()
        .unwrap();
        assert_eq!(resolved.qualities, ["1080p60", "720p", "audio_only"]);
        assert_eq!(resolved.quality, "720p");
        for reply in [
            r#"{"error":true}"#,
            "invalid-private-value",
            r#"{"url":"file:///private-value"}"#,
        ] {
            let error = parse_response(reply, "best").unwrap_err().to_string();
            assert!(!error.contains("private-value"));
        }
    }
    #[test]
    fn pipe_wait_obeys_cancellation_shutdown_timeout_and_disconnect() {
        let (send, receive) = mpsc::channel();
        let yes = AtomicBool::new(true);
        let no = AtomicBool::new(false);
        assert!(wait_line(&receive, &yes, &no, Duration::from_secs(1)).is_err());
        assert!(wait_line(&receive, &no, &yes, Duration::from_secs(1)).is_err());
        assert!(wait_line(&receive, &no, &no, Duration::ZERO).is_err());
        send.send("ready".into()).unwrap();
        assert_eq!(
            wait_line(&receive, &no, &no, Duration::from_secs(1)).unwrap(),
            "ready"
        );
        drop(send);
        assert!(wait_line(&receive, &no, &no, Duration::from_secs(1)).is_err());
    }
    #[test]
    fn rejects_untrusted_lookup_inputs() {
        assert!(resolve("../invalid", "best").is_err());
        assert!(resolve("valid", "best --extra").is_err());
        for url in [
            "file:///private",
            "http://example.com/a",
            "https://example.com/\n",
            "https://",
        ] {
            assert!(valid_url(url).is_err());
        }
        assert!(valid_url("https://example.com/live.m3u8?private=value").is_ok());
    }
}
