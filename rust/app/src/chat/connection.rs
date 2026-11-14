//! Anonymous, TLS-verified IRC reads. No account token is sent to IRC.
use super::model::{self, Event};
use std::{
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};
pub struct Connection {
    pub events: Receiver<Event>,
    stop: Arc<AtomicBool>,
}
impl Connection {
    /// `history` is how many recent Kick messages to show first; Twitch's
    /// history loads separately (`history.rs`).
    pub fn new(login: &str, history: usize) -> Self {
        let (stop, channel) = (Arc::new(AtomicBool::new(false)), login.to_owned());
        let (tx, events) = mpsc::sync_channel(1000);
        let cancelled = stop.clone();
        if let Some(slug) = crate::kick::slug(login) {
            super::kick::spawn(slug.to_owned(), history, cancelled, tx);
            return Self { events, stop };
        }
        thread::spawn(move || {
            let mut attempt = 0;
            while !cancelled.load(Ordering::Acquire) {
                let _ = tx.try_send(Event::State(if attempt == 0 {
                    "Connecting"
                } else {
                    "Reconnecting"
                }));
                let _ = run(&channel, &cancelled, &tx);
                if cancelled.load(Ordering::Acquire) {
                    break;
                }
                attempt = (attempt + 1).min(5);
                let deadline = Instant::now() + Duration::from_secs(1 << attempt);
                while Instant::now() < deadline && !cancelled.load(Ordering::Acquire) {
                    thread::sleep(Duration::from_millis(100));
                }
            }
        });
        Self { events, stop }
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}
fn run(channel: &str, stop: &AtomicBool, tx: &SyncSender<Event>) -> anyhow::Result<()> {
    if !crate::format::is_login(channel) {
        anyhow::bail!("Invalid channel");
    }
    let addr = ("irc.chat.twitch.tv", 6697)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| anyhow::anyhow!("No chat address"))?;
    let socket = TcpStream::connect_timeout(&addr, Duration::from_secs(5))?;
    socket.set_read_timeout(Some(Duration::from_secs(5)))?;
    socket.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut stream = native_tls::TlsConnector::new()?.connect("irc.chat.twitch.tv", socket)?;
    stream
        .get_ref()
        .set_read_timeout(Some(Duration::from_millis(500)))?;
    let nick = format!("justinfan{}", crate::twitch::auth::now() % 90000 + 10000);
    write!(
        stream,
        "CAP REQ :twitch.tv/tags twitch.tv/commands\r\nPASS SCHMOOPIIE\r\nNICK {nick}\r\nJOIN #{channel}\r\n"
    )?;
    stream.flush()?;
    let (mut pending, mut bytes) = (Vec::<u8>::new(), [0u8; 8192]);
    let mut last = Instant::now();
    while !stop.load(Ordering::Acquire) {
        match stream.read(&mut bytes) {
            Ok(0) => break,
            Ok(n) => {
                last = Instant::now();
                pending.extend_from_slice(&bytes[..n]);
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if last.elapsed() > Duration::from_secs(180) {
                    break;
                }
                continue;
            }
            Err(e) => return Err(e.into()),
        }
        if pending.len() > 65_536 {
            anyhow::bail!("Chat frame too large");
        }
        while let Some(end) = pending.windows(2).position(|pair| pair == b"\r\n") {
            let line = String::from_utf8(pending[..end].to_vec());
            pending.drain(..end + 2);
            let Ok(line) = line else { continue };
            if let Some(payload) = line.strip_prefix("PING ") {
                write!(stream, "PONG {payload}\r\n")?;
                stream.flush()?;
                continue;
            }
            if command(&line) == "366" {
                let _ = tx.try_send(Event::State("Connected"));
            }
            if command(&line) == "RECONNECT" {
                return Ok(());
            }
            if let Some(modes) = model::room_modes(&line, channel) {
                let _ = tx.try_send(Event::Modes(modes));
            }
            if let Some(event) = model::parse(&line, channel) {
                let _ = tx.try_send(event);
            }
        }
    }
    Ok(())
}

// Match only the IRC header, never words in a viewer's message.
fn command(line: &str) -> &str {
    let line = if line.starts_with('@') {
        line.split_once(' ').map_or("", |(_, rest)| rest)
    } else {
        line
    };
    let line = if line.starts_with(':') {
        line.split_once(' ').map_or("", |(_, rest)| rest)
    } else {
        line
    };
    line.split(' ').next().unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn viewer_text_cannot_spoof_connection_commands() {
        assert_eq!(
            command("@id=x :viewer!v@h PRIVMSG #room : RECONNECT 366 hello"),
            "PRIVMSG"
        );
        assert_eq!(command(":tmi.twitch.tv RECONNECT"), "RECONNECT");
        assert_eq!(command(":tmi.twitch.tv 366 justinfan #room :End"), "366");
    }
}
