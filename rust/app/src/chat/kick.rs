//! Kick chat, read-only: the public Pusher feed Kick's own site listens to.
//! Nothing is sent but the subscription and keep-alives, and no account is
//! involved. Every field is untrusted viewer data.
use super::model::{EmoteRange, Event, Message, Reply};
use serde_json::Value;
use std::{
    io::ErrorKind,
    net::{TcpStream, ToSocketAddrs},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::SyncSender,
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::Message as Frame;

/// Kick's published Pusher key, used when its connection lookup is down.
const FALLBACK: (&str, &str) = ("34bf7a0ff419a2a775b9", "us2");

pub fn spawn(slug: String, cancelled: Arc<AtomicBool>, tx: SyncSender<Event>) {
    thread::spawn(move || {
        let agent = crate::kick::agent();
        let mut attempt = 0;
        let mut channel = None;
        while !cancelled.load(Ordering::Acquire) {
            let _ = tx.try_send(Event::State(if attempt == 0 { "Connecting" } else { "Reconnecting" }));
            if channel.is_none() {
                channel = crate::kick::channel(&slug).ok();
                if let Some(channel) = &channel {
                    let _ = tx.try_send(Event::Room(format!("kick:{}", channel.user_id)));
                }
            }
            if let Some(channel) = &channel {
                let _ = run(&agent, channel, &cancelled, &tx);
            }
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
}

fn run(
    agent: &ureq::Agent,
    channel: &crate::kick::Channel,
    stop: &AtomicBool,
    tx: &SyncSender<Event>,
) -> anyhow::Result<()> {
    anyhow::ensure!(channel.chatroom_id > 0, "Kick channel has no chat room");
    let (key, cluster) = crate::kick::chat_connection(agent, channel.id)
        .unwrap_or_else(|_| (FALLBACK.0.to_owned(), FALLBACK.1.to_owned()));
    let host = format!("ws-{cluster}.pusher.com");
    let addr = (host.as_str(), 443)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| anyhow::anyhow!("No chat address"))?;
    let socket = TcpStream::connect_timeout(&addr, Duration::from_secs(5))?;
    socket.set_read_timeout(Some(Duration::from_secs(5)))?;
    socket.set_write_timeout(Some(Duration::from_secs(5)))?;
    let tls = native_tls::TlsConnector::new()?.connect(&host, socket)?;
    let url = format!("wss://{host}/app/{key}?protocol=7&client=js&version=8.4.0&flash=false");
    let (mut socket, _) = tungstenite::client(url.as_str(), tls).map_err(|_| anyhow::anyhow!("Kick chat refused the connection"))?;
    socket.get_ref().get_ref().set_read_timeout(Some(Duration::from_millis(500)))?;
    let subscribe = serde_json::json!({
        "event": "pusher:subscribe",
        "data": {"auth": "", "channel": format!("chatrooms.{}.v2", channel.chatroom_id)},
    });
    socket.send(Frame::text(subscribe.to_string()))?;
    let mut last = Instant::now();
    let mut pinged = false;
    while !stop.load(Ordering::Acquire) {
        let frame = match socket.read() {
            Ok(frame) => frame,
            Err(tungstenite::Error::Io(error))
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
            {
                // Pusher's activity timeout is 120 s: ping after a quiet minute.
                if last.elapsed() > Duration::from_secs(60) && !pinged {
                    socket.send(Frame::text(r#"{"event":"pusher:ping","data":{}}"#))?;
                    pinged = true;
                }
                if last.elapsed() > Duration::from_secs(150) {
                    break;
                }
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        last = Instant::now();
        pinged = false;
        let text = match frame {
            Frame::Text(text) => text,
            Frame::Close(_) => break,
            _ => continue,
        };
        if text.len() > 256 * 1024 {
            continue;
        }
        let Ok(envelope) = serde_json::from_str::<Value>(text.as_str()) else { continue };
        let event = envelope["event"].as_str().unwrap_or_default();
        // Pusher sends its payloads as JSON inside a string.
        let data: Value = match &envelope["data"] {
            Value::String(inner) => serde_json::from_str(inner).unwrap_or(Value::Null),
            other => other.clone(),
        };
        match event {
            "pusher:ping" => socket.send(Frame::text(r#"{"event":"pusher:pong","data":{}}"#))?,
            "pusher_internal:subscription_succeeded" => {
                let _ = tx.try_send(Event::State("Connected"));
            }
            "pusher:error" => anyhow::bail!("Kick chat closed the connection"),
            "App\\Events\\ChatMessageEvent" => {
                if let Some(message) = message(&data, channel) {
                    let _ = tx.try_send(Event::Message(message));
                }
            }
            "App\\Events\\MessageDeletedEvent" => {
                if let Some(id) = data["message"]["id"].as_str().filter(|id| super::model::asset_id(id)) {
                    let _ = tx.try_send(Event::Delete(id.to_owned()));
                }
            }
            "App\\Events\\UserBannedEvent" => {
                if let Some(login) = data["user"]["slug"].as_str().filter(|slug| crate::kick::is_slug(slug)) {
                    let _ = tx.try_send(Event::ClearUser(login.to_owned()));
                }
            }
            "App\\Events\\ChatroomClearEvent" => {
                let _ = tx.try_send(Event::Clear);
            }
            _ => {}
        }
    }
    let _ = socket.close(None);
    Ok(())
}

fn clean(value: &Value, limit: usize) -> String {
    value
        .as_str()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(limit)
        .collect()
}

/// `[emote:ID:NAME]` codes become the name, with a range for the image.
fn text_and_emotes(content: &str) -> (String, Vec<EmoteRange>) {
    let mut text = String::with_capacity(content.len());
    let mut emotes = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("[emote:") {
        text.push_str(&rest[..start]);
        let after = &rest[start + 7..];
        let parsed = after.find(']').and_then(|end| {
            let (id, name) = after[..end].split_once(':')?;
            (id.len() <= 12
                && !id.is_empty()
                && id.bytes().all(|b| b.is_ascii_digit())
                && !name.is_empty()
                && name.len() <= 64
                && !name.contains(char::is_whitespace))
            .then_some((id, name, end))
        });
        match parsed {
            Some((id, name, end)) => {
                let at = text.len();
                text.push_str(name);
                emotes.push(EmoteRange { start: at, end: text.len(), id: format!("kick-{id}") });
                rest = &after[end + 1..];
            }
            None => {
                text.push_str("[emote:");
                rest = after;
            }
        }
    }
    text.push_str(rest);
    (text, emotes)
}

fn color(value: &Value) -> u32 {
    value
        .as_str()
        .and_then(|hex| hex.strip_prefix('#'))
        .filter(|hex| hex.len() == 6)
        .and_then(|hex| u32::from_str_radix(hex, 16).ok())
        .unwrap_or(0xa78bfa)
}

/// Milliseconds since 1970 from Kick's `2026-11-14T02:02:30+00:00`.
fn sent_at(value: &Value) -> Option<u64> {
    let text = value.as_str()?;
    let number = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // Howard Hinnant's days-from-civil.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second;
    u64::try_from(seconds).ok().map(|seconds| seconds * 1000)
}

fn message(data: &Value, channel: &crate::kick::Channel) -> Option<Message> {
    let id = data["id"].as_str().filter(|id| super::model::asset_id(id))?.to_owned();
    let sender = &data["sender"];
    let login = clean(&sender["slug"], 40).to_ascii_lowercase();
    if !crate::kick::is_slug(&login) {
        return None;
    }
    let name = Some(clean(&sender["username"], 40)).filter(|name| !name.is_empty()).unwrap_or_else(|| login.clone());
    let identity = &sender["identity"];
    let mut badges = Vec::new();
    // The channel's subscriber badge for the viewer's months.
    if let Some(months) = identity["badges"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|badge| badge["type"] == "subscriber")
        .and_then(|badge| badge["count"].as_u64())
        && let Some((_, url)) = channel.subscriber_badges.iter().find(|(needed, _)| *needed <= months)
    {
        badges.push(url.clone());
    }
    // Kick's own badges the viewer chose to show.
    badges.extend(
        identity["badges_v2"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|badge| badge["selected"].as_bool().unwrap_or(false))
            .filter_map(|badge| Some(clean(&badge["image_url"], 400)).filter(|url| crate::kick::is_image_url(url)))
            .take(4),
    );
    let (text, emotes) = text_and_emotes(&clean(&data["content"], 2000));
    let reply = (data["type"] == "reply").then(|| {
        let metadata = &data["metadata"];
        let login = clean(&metadata["original_sender"]["slug"], 40).to_ascii_lowercase();
        let name = clean(&metadata["original_sender"]["username"], 40);
        let (parent, _) = text_and_emotes(&clean(&metadata["original_message"]["content"], 500));
        Box::new(Reply {
            id: clean(&metadata["original_message"]["id"], 64),
            name: if name.is_empty() { login.clone() } else { name },
            login,
            text: parent,
        })
    });
    Some(Message {
        first_message: false,
        sent_at: sent_at(&data["created_at"]),
        reply,
        system: None,
        id,
        login,
        name,
        color: color(&identity["color"]),
        text,
        emotes,
        badges,
        action: false,
        deleted: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel() -> crate::kick::Channel {
        crate::kick::Channel {
            id: 1,
            slug: "room".into(),
            name: "Room".into(),
            avatar: None,
            user_id: 2,
            chatroom_id: 3,
            live: None,
            subscriber_badges: vec![(6, "https://files.kick.com/b/6".into()), (1, "https://files.kick.com/b/1".into())],
        }
    }

    #[test]
    fn emote_codes_become_ranges() {
        let (text, emotes) = text_and_emotes("hi [emote:37226:KEKW] [emote:x:bad] ok");
        assert_eq!(text, "hi KEKW [emote:x:bad] ok");
        assert_eq!((emotes[0].start, emotes[0].end, emotes[0].id.as_str()), (3, 7, "kick-37226"));
        assert_eq!(emotes.len(), 1);
    }

    #[test]
    fn reads_a_chat_message() {
        let data = serde_json::json!({
            "id": "c734bbab-9768-4f6d-b863-e37b962ab761", "content": "[emote:1:Nod] hey", "type": "message",
            "created_at": "1970-01-02T00:00:01+00:00",
            "sender": {"slug": "some-one", "username": "Some_One", "identity": {"color": "#FF9D00",
                "badges": [{"type": "subscriber", "count": 3}],
                "badges_v2": [{"image_url": "https://ext.cdn.kick.com/chat/badges/a.png", "selected": true},
                              {"image_url": "https://evil.example/b.png", "selected": true},
                              {"image_url": "https://ext.cdn.kick.com/chat/badges/c.png", "selected": false}]}}
        });
        let message = message(&data, &channel()).unwrap();
        assert_eq!(message.login, "some-one");
        assert_eq!(message.color, 0xff9d00);
        assert_eq!(message.text, "Nod hey");
        assert_eq!(message.sent_at, Some(86_401_000));
        assert_eq!(message.badges, ["https://files.kick.com/b/1", "https://ext.cdn.kick.com/chat/badges/a.png"]);
    }
}
