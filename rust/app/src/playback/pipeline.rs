//! First playback path: Streamlink writes the live MPEG-TS to a pipe, FFmpeg
//! decodes it (hardware decoding when available) into constant-rate BGRA video
//! on its stdout and float PCM on a loopback socket, and VioletWire shows each
//! frame as a GPUI image paced by the audio clock.
//!
//! This is the "CPU frames" option from the README: simple and on stock GPUI,
//! at the cost of copying every frame. The relay and GPU-texture work replaces
//! the transport and the copies later.

use std::io::{BufRead, BufReader, Read};
use std::net::{Ipv4Addr, TcpListener};
use std::os::windows::process::CommandExt;
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail};
use gpui::RenderImage;

use super::audio::Output;
use super::job::Job;
use super::shared::{Shared, VideoFrame, lock};
use super::tools;
use crate::format::is_login;

/// Streams keep their own resolution up to this; larger ones are scaled down.
const MAX_WIDTH: u32 = 1920;
const MAX_HEIGHT: u32 = 1080;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const AUDIO_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

pub struct Pipeline {
    shared: Arc<Shared>,
    // Declaration order is drop order: stop the sound, then kill the processes.
    _sound: cpal::Stream,
    _job: Job,
    _children: Children,
}

/// Kills direct children if setup fails before they are inside the job.
struct Children(Vec<Child>);

impl Drop for Children {
    fn drop(&mut self) {
        for child in &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Pipeline {
    pub fn start(login: &str) -> Result<Self> {
        if !is_login(login) {
            bail!("That is not a Twitch channel name.");
        }
        let tools = tools::find()?;
        let output = Output::default_device()?;
        let shared = Arc::new(Shared::new(output.sample_rate(), output.channels()));

        // FFmpeg connects here to deliver audio. Loopback only.
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).context("Could not open the audio channel.")?;
        let audio_url = format!("tcp://127.0.0.1:{}", listener.local_addr()?.port());

        let job = Job::new()?;
        let mut children = Children(Vec::new());

        // Anonymous for now: a token would have to travel by stdin, never argv.
        let mut streamlink = Command::new(&tools.streamlink_python)
            .args(["-m", "streamlink_cli", "--stdout", "--loglevel", "error"])
            .args(["--twitch-low-latency", "--hls-live-edge", "2"])
            .arg(format!("twitch.tv/{login}"))
            .arg("best")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .context("Could not start Streamlink.")?;
        let transport = streamlink.stdout.take();
        let streamlink_errors = streamlink.stderr.take();
        children.0.push(streamlink);
        job.assign(&children.0[0])?;

        let mut ffmpeg = Command::new(&tools.ffmpeg)
            .args(ffmpeg_arguments(&audio_url, shared.sample_rate, shared.channels))
            .stdin(transport.map(Stdio::from).context("Streamlink has no output.")?)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .context("Could not start FFmpeg.")?;
        let frames = ffmpeg.stdout.take().context("FFmpeg has no output.")?;
        let ffmpeg_errors = ffmpeg.stderr.take();
        children.0.push(ffmpeg);
        job.assign(&children.0[1])?;

        spawn("vw-video", {
            let shared = shared.clone();
            move || read_video(&shared, frames)
        })?;
        spawn("vw-audio", {
            let shared = shared.clone();
            move || read_audio(&shared, &listener)
        })?;
        if let Some(errors) = ffmpeg_errors {
            let shared = shared.clone();
            spawn("vw-ffmpeg-log", move || read_ffmpeg_log(&shared, errors))?;
        }
        if let Some(errors) = streamlink_errors {
            let shared = shared.clone();
            spawn("vw-streamlink-log", move || read_streamlink_log(&shared, errors))?;
        }

        let sound = output.start(shared.clone())?;
        Ok(Self {
            shared,
            _sound: sound,
            _job: job,
            _children: children,
        })
    }

    pub fn take_due_frame(&self) -> Option<Arc<RenderImage>> {
        self.shared.take_due_frame()
    }

    /// A snapshot that can tell, on each display refresh, whether the view
    /// has anything new to draw.
    pub fn watch(&self) -> Watch {
        Watch {
            playing: self.shared.playing(),
            ended: self.shared.video_ended(),
            shared: self.shared.clone(),
        }
    }

    pub fn is_playing(&self) -> bool {
        self.shared.playing()
    }

    /// Why playback stopped, once it has.
    pub fn ended(&self) -> Option<String> {
        if !self.shared.video_ended() {
            return None;
        }
        if let Some(error) = lock(&self.shared.streamlink_error).clone() {
            return Some(error);
        }
        // FFmpeg reports recoverable decode errors while joining a live
        // stream; only blame it when nothing ever played.
        if !self.shared.playing() {
            return Some(
                lock(&self.shared.ffmpeg_error)
                    .clone()
                    .unwrap_or_else(|| "The stream could not be started.".to_string()),
            );
        }
        Some("The stream ended.".to_string())
    }
}

pub struct Watch {
    shared: Arc<Shared>,
    playing: bool,
    ended: bool,
}

impl Watch {
    pub fn changed(&self) -> bool {
        self.shared.stopped()
            || self.shared.frame_due()
            || self.shared.playing() != self.playing
            || self.shared.video_ended() != self.ended
    }
}

impl Drop for Pipeline {
    fn drop(&mut self) {
        // Wakes any waiting reader; the job then kills the processes, which
        // closes the pipes the readers are blocked on.
        self.shared.stop();
    }
}

fn spawn(name: &str, work: impl FnOnce() + Send + 'static) -> Result<()> {
    thread::Builder::new()
        .name(name.to_string())
        .spawn(work)
        .map(drop)
        .context("Could not start a playback thread.")
}

fn ffmpeg_arguments(audio_url: &str, sample_rate: u32, channels: usize) -> Vec<String> {
    // FFmpeg's filter parser removes the quotes; they keep the commas inside
    // min() from splitting the filter chain.
    let video_filter = format!(
        "scale='min({MAX_WIDTH},iw)':'min({MAX_HEIGHT},ih)':force_original_aspect_ratio=decrease:flags=bilinear"
    );
    let audio_filter = format!("aresample={sample_rate}:async=1:first_pts=0");
    [
        "-hide_banner", "-nostats", "-loglevel", "info",
        // Start quickly on a live stream.
        "-fflags", "nobuffer", "-probesize", "1000000", "-analyzeduration", "1000000",
        "-hwaccel", "auto",
        "-i", "pipe:0",
        // Video: constant rate, so frame N belongs at N / fps.
        "-map", "0:v:0", "-vf", &video_filter, "-fps_mode", "cfr",
        "-pix_fmt", "bgra", "-f", "rawvideo", "pipe:1",
        // Audio: the sound card's rate and channels, gaps filled from zero.
        "-map", "0:a:0", "-af", &audio_filter, "-ac", &channels.to_string(),
        "-flush_packets", "1", "-f", "f32le", audio_url,
    ]
    .iter()
    .map(|argument| argument.to_string())
    .collect()
}

fn read_video(shared: &Shared, mut frames: ChildStdout) {
    // The frame size comes from FFmpeg's log, which it prints before the
    // first frame.
    let (width, height) = loop {
        if let Some(size) = shared.frame_size() {
            break size;
        }
        if shared.stopped() || shared.log_closed() {
            shared.end_video();
            return;
        }
        thread::sleep(Duration::from_millis(10));
    };
    let frame_bytes = width as usize * height as usize * 4;
    let mut index = 0u64;
    loop {
        let mut pixels = vec![0u8; frame_bytes];
        if frames.read_exact(&mut pixels).is_err() || shared.stopped() {
            break;
        }
        // GPUI's images are BGRA, which is what FFmpeg was asked for; the
        // RGBA buffer type is only a container here.
        let Some(buffer) = image::RgbaImage::from_raw(width, height, pixels) else {
            break;
        };
        let image = Arc::new(RenderImage::new(vec![image::Frame::new(buffer)]));
        if !shared.push_video(VideoFrame { index, image }) {
            break;
        }
        index += 1;
    }
    shared.end_video();
}

fn read_audio(shared: &Shared, listener: &TcpListener) {
    let Ok(()) = listener.set_nonblocking(true) else {
        return;
    };
    let deadline = Instant::now() + AUDIO_CONNECT_TIMEOUT;
    let mut socket = loop {
        match listener.accept() {
            Ok((socket, peer)) if peer.ip().is_loopback() => break socket,
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if shared.stopped() || Instant::now() >= deadline {
                    return;
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return,
        }
    };
    if socket.set_nonblocking(false).is_err() {
        return;
    }
    let mut bytes = vec![0u8; 32 * 1024];
    let mut pending: Vec<u8> = Vec::new();
    let mut samples: Vec<f32> = Vec::new();
    loop {
        let read = match socket.read(&mut bytes) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        pending.extend_from_slice(&bytes[..read]);
        let whole = pending.len() / 4 * 4;
        samples.clear();
        samples.extend(
            pending[..whole]
                .chunks_exact(4)
                .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])),
        );
        pending.drain(..whole);
        if !shared.push_audio(&samples) {
            break;
        }
    }
}

fn read_ffmpeg_log(shared: &Shared, errors: ChildStderr) {
    let mut in_output = false;
    for line in BufReader::new(errors).lines() {
        let Ok(line) = line else { break };
        if line.starts_with("Output #") {
            in_output = true;
        }
        if in_output && line.contains("Video: rawvideo") {
            // Size first: the video reader starts as soon as it is known.
            if let Some((width, height)) = parse_size(&line) {
                shared.set_frame_size(width, height);
            }
            if let Some(fps) = parse_fps(&line) {
                shared.set_fps(fps);
            }
        }
        if line.contains("rror") || line.contains("Invalid") {
            *lock(&shared.ffmpeg_error) = Some(format!("FFmpeg: {}", redact(&line)));
        }
    }
    shared.close_log();
}

/// The `1920x1080` in FFmpeg's output stream line. Skips `0x41524742`-style
/// codec tags, which are not sizes.
fn parse_size(line: &str) -> Option<(u32, u32)> {
    line.split([' ', ','])
        .filter_map(|token| token.split_once('x'))
        .filter_map(|(width, height)| Some((width.parse::<u32>().ok()?, height.parse::<u32>().ok()?)))
        .find(|(width, height)| (16..=MAX_WIDTH).contains(width) && (16..=MAX_HEIGHT).contains(height))
}

fn read_streamlink_log(shared: &Shared, errors: ChildStderr) {
    for line in BufReader::new(errors).lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if !line.is_empty() {
            *lock(&shared.streamlink_error) = Some(format!("Streamlink: {}", redact(line)));
        }
    }
}

/// `…, 1280x720 [SAR 1:1 DAR 16:9], q=2-31, 1769472 kb/s, 59.94 fps, 59.94 tbn`
fn parse_fps(line: &str) -> Option<f64> {
    line.split(", ")
        .find_map(|part| part.trim().strip_suffix(" fps"))
        .and_then(|number| number.trim().parse().ok())
}

/// Stream URLs carry signed tokens; never show or keep them.
fn redact(line: &str) -> String {
    let text: String = line
        .split_whitespace()
        .map(|word| if word.contains("://") { "[link]" } else { word })
        .collect::<Vec<_>>()
        .join(" ");
    crate::http::short_message(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_output_frame_rate() {
        let line = "  Stream #0:0: Video: rawvideo (BGRA / 0x41524742), bgra(pc, gbr/bt709/bt709, progressive), \
                    1280x720 [SAR 1:1 DAR 16:9], q=2-31, 1769472 kb/s, 59.94 fps, 59.94 tbn";
        assert_eq!(parse_fps(line), Some(59.94));
        assert_eq!(parse_fps("Stream #0:1: Audio: pcm_f32le, 48000 Hz, stereo"), None);
        assert_eq!(parse_size(line), Some((1280, 720)));
        assert_eq!(parse_size("Video: rawvideo (BGRA / 0x41524742), bgra"), None);
    }

    #[test]
    fn hides_urls_from_messages() {
        let message = redact("error: Unable to open URL: https://usher.ttvnw.net/x.m3u8?sig=abc&token=secret (403)");
        assert!(!message.contains("secret"));
        assert!(message.contains("[link]"));
    }

    #[test]
    fn asks_ffmpeg_for_the_device_format() {
        let arguments = ffmpeg_arguments("tcp://127.0.0.1:5000", 44_100, 2);
        assert!(arguments.iter().any(|argument| argument == "aresample=44100:async=1:first_pts=0"));
        assert!(arguments.windows(2).any(|pair| pair[0] == "-ac" && pair[1] == "2"));
        assert_eq!(arguments.last().map(String::as_str), Some("tcp://127.0.0.1:5000"));
    }
}
