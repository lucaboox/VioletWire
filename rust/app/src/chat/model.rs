use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct Message {
    pub first_message: bool,
    pub sent_at: Option<u64>,
    pub reply: Option<Box<Reply>>,
    pub system: Option<String>,
    pub id: String,
    pub login: String,
    pub name: String,
    pub color: u32,
    pub text: String,
    pub emotes: Vec<EmoteRange>,
    pub badges: Vec<String>,
    pub action: bool,
    pub deleted: bool,
}
#[derive(Clone, Debug)]
pub struct Reply {
    pub id: String,
    pub name: String,
    pub text: String,
}
#[derive(Clone, Debug)]
pub struct EmoteRange {
    pub start: usize,
    pub end: usize,
    pub id: String,
}
#[derive(Debug)]
pub enum Event {
    Message(Message),
    Room(String),
    Delete(String),
    ClearUser(String),
    Clear,
    State(&'static str),
}

pub fn tag_text(raw: &str) -> String {
    let mut text = String::new();
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('s') => text.push(' '),
                Some(':') => text.push(';'),
                Some('\\') => text.push('\\'),
                Some('r' | 'n') => {}
                Some(c) => text.push(c),
                None => {}
            }
        } else {
            text.push(c);
        }
    }
    text
}
pub fn asset_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn parse(line: &str, channel: &str) -> Option<Event> {
    if line.len() > 16_384 {
        return None;
    }
    let (tags, rest) = if let Some(tagged) = line.strip_prefix('@') {
        tagged.split_once(' ')?
    } else {
        ("", line)
    };
    let tags: HashMap<&str, &str> = tags
        .split(';')
        .filter_map(|tag| tag.split_once('='))
        .collect();
    let (prefix, rest) = if let Some(prefixed) = rest.strip_prefix(':') {
        prefixed.split_once(' ')?
    } else {
        ("", rest)
    };
    let (head, body) = rest.split_once(" :").unwrap_or((rest, ""));
    let mut fields = head.split_whitespace();
    let command = fields.next()?;
    let room = fields.next().unwrap_or("");
    if room != format!("#{channel}") {
        return None;
    }
    match command {
        "ROOMSTATE" => Some(Event::Room(tags.get("room-id")?.to_string())),
        "CLEARMSG" => Some(Event::Delete(tags.get("target-msg-id")?.to_string())),
        "CLEARCHAT" if body.is_empty() => Some(Event::Clear),
        "CLEARCHAT" => Some(Event::ClearUser(body.to_ascii_lowercase())),
        "PRIVMSG" | "USERNOTICE" => {
            let login = if command == "USERNOTICE" {
                tags.get("login").copied().unwrap_or("twitch")
            } else {
                prefix.split('!').next()?
            }
            .to_ascii_lowercase();
            if !crate::format::is_login(&login) {
                return None;
            }
            let action = body.starts_with("\u{1}ACTION ") && body.ends_with('\u{1}');
            let text = if action {
                &body[8..body.len() - 1]
            } else {
                body
            };
            let text: String = text
                .chars()
                .map(|c| if c.is_control() { ' ' } else { c })
                .collect();
            let mut boundaries: Vec<usize> = text.char_indices().map(|(i, _)| i).collect();
            boundaries.push(text.len());
            let mut emotes = Vec::new();
            for group in tags.get("emotes").copied().unwrap_or("").split('/') {
                let Some((id, ranges)) = group.split_once(':') else {
                    continue;
                };
                if !asset_id(id) {
                    continue;
                }
                for range in ranges.split(',') {
                    let Some((a, b)) = range.split_once('-') else {
                        continue;
                    };
                    let (Ok(a), Ok(b)) = (a.parse::<usize>(), b.parse::<usize>()) else {
                        continue;
                    };
                    // Twitch tags index the inner text for /me actions, as in
                    // the Electron parser; the CTCP prefix isn't part of it.
                    if a <= b && b < boundaries.len().saturating_sub(1) {
                        emotes.push(EmoteRange {
                            start: boundaries[a],
                            end: boundaries[b + 1],
                            id: id.into(),
                        });
                    }
                }
            }
            emotes.sort_by_key(|e| e.start);
            let color = tags
                .get("color")
                .and_then(|c| c.strip_prefix('#'))
                .filter(|c| c.len() == 6)
                .and_then(|c| u32::from_str_radix(c, 16).ok())
                .filter(|c| ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255) > 180)
                .unwrap_or(0xb59bff);
            Some(Event::Message(Message {
                first_message: tags.get("first-msg") == Some(&"1"),
                sent_at: tags.get("tmi-sent-ts").and_then(|time| time.parse().ok()),
                reply: tags
                    .get("reply-parent-msg-id")
                    .filter(|id| asset_id(id))
                    .map(|id| {
                        Box::new(Reply {
                            id: (*id).into(),
                            name: tag_text(
                                tags.get("reply-parent-display-name")
                                    .copied()
                                    .or_else(|| tags.get("reply-parent-user-login").copied())
                                    .unwrap_or("viewer"),
                            ),
                            text: tag_text(
                                tags.get("reply-parent-msg-body").copied().unwrap_or(""),
                            )
                            .chars()
                            .take(500)
                            .collect(),
                        })
                    }),
                system: (command == "USERNOTICE").then(|| {
                    tag_text(
                        tags.get("system-msg")
                            .copied()
                            .unwrap_or("Channel notification"),
                    )
                }),
                id: tags.get("id").copied().unwrap_or("").into(),
                login: login.clone(),
                name: tags
                    .get("display-name")
                    .map(|s| tag_text(s))
                    .filter(|s| !s.is_empty())
                    .unwrap_or(login),
                color,
                text,
                emotes,
                badges: tags
                    .get("badges")
                    .copied()
                    .unwrap_or("")
                    .split(',')
                    .filter(|s| !s.is_empty() && s.len() < 100)
                    .map(str::to_owned)
                    .collect(),
                action,
                deleted: false,
            }))
        }
        _ => None,
    }
}

pub fn mentioned(text: &str, login: &str) -> bool {
    if !crate::format::is_login(login) {
        return false;
    }
    let text = text.to_ascii_lowercase();
    let mention = format!("@{}", login.to_ascii_lowercase());
    text.match_indices(&mention).any(|(at, _)| {
        text[at + mention.len()..]
            .chars()
            .next()
            .is_none_or(|c| !c.is_ascii_alphanumeric() && c != '_')
    })
}

pub fn local_time(millis: u64) -> Option<String> {
    use windows::Win32::{
        Foundation::{FILETIME, SYSTEMTIME},
        System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime},
    };
    let ticks = millis
        .checked_mul(10_000)?
        .checked_add(116_444_736_000_000_000)?;
    let file = FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    };
    let (mut utc, mut local) = (SYSTEMTIME::default(), SYSTEMTIME::default());
    unsafe {
        FileTimeToSystemTime(&file, &mut utc).ok()?;
        SystemTimeToTzSpecificLocalTime(None, &utc, &mut local).ok()?;
    }
    Some(format!("{:02}:{:02}", local.wHour, local.wMinute))
}

#[derive(Clone)]
pub enum Part {
    Text(String),
    Emote { name: String, url: String },
}
pub fn parts(message: &Message, providers: &HashMap<String, String>) -> Vec<Part> {
    let mut output = Vec::new();
    let mut cursor = 0;
    for emote in &message.emotes {
        if emote.start < cursor
            || emote.end <= emote.start
            || emote.end > message.text.len()
            || !message.text.is_char_boundary(emote.start)
            || !message.text.is_char_boundary(emote.end)
        {
            continue;
        }
        words(&message.text[cursor..emote.start], providers, &mut output);
        output.push(Part::Emote {
            name: message.text[emote.start..emote.end].into(),
            url: format!(
                "https://static-cdn.jtvnw.net/emoticons/v2/{}/default/dark/2.0",
                emote.id
            ),
        });
        cursor = emote.end;
    }
    words(&message.text[cursor..], providers, &mut output);
    output
}
fn words(text: &str, providers: &HashMap<String, String>, output: &mut Vec<Part>) {
    for word in text.split_inclusive(char::is_whitespace) {
        let name = word.trim_end();
        if let Some(url) = providers.get(name) {
            output.push(Part::Emote {
                name: name.into(),
                url: url.clone(),
            });
            if word.len() > name.len() {
                output.push(Part::Text(word[name.len()..].into()));
            }
        } else {
            output.push(Part::Text(word.into()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn action_emotes_use_inner_text_offsets() {
        let Event::Message(message)=parse("@display-name=Viewer;emotes=25:0-4 :viewer!u@h PRIVMSG #room :\u{1}ACTION Kappa waves\u{1}","room").unwrap() else {panic!()};
        assert!(message.action);
        assert_eq!(message.text, "Kappa waves");
        assert_eq!(
            &message.text[message.emotes[0].start..message.emotes[0].end],
            "Kappa"
        );
    }
    #[test]
    fn reads_reply_first_message_and_notice_metadata() {
        let Event::Message(message)=parse("@id=x;first-msg=1;tmi-sent-ts=1720000000000;reply-parent-msg-id=parent-id;reply-parent-display-name=Parent;reply-parent-msg-body=hello\\sworld :viewer!u@h PRIVMSG #room :A reply","room").unwrap() else {panic!()};
        assert!(message.first_message);
        assert_eq!(message.sent_at, Some(1720000000000));
        let reply = message.reply.unwrap();
        assert_eq!(reply.id, "parent-id");
        assert_eq!(reply.text, "hello world");
        let Event::Message(notice) = parse(
            "@login=viewer;system-msg=Viewer\\ssubscribed! :tmi.twitch.tv USERNOTICE #room :Hello",
            "room",
        )
        .unwrap() else {
            panic!()
        };
        assert_eq!(notice.system.as_deref(), Some("Viewer subscribed!"));
        assert_eq!(notice.text, "Hello");
    }
    #[test]
    fn mentions_respect_login_boundaries_and_local_time_is_bounded() {
        assert!(mentioned("hello @ViEwEr!", "viewer"));
        assert!(!mentioned("hello @viewer_extra", "viewer"));
        assert!(!mentioned("hello viewer", "viewer"));
        assert_eq!(local_time(1720000000000).unwrap().len(), 5);
        assert!(local_time(u64::MAX).is_none());
    }
    #[test]
    fn reads_unicode_emotes_and_preserves_display_case() {
        let e=parse("@id=x;display-name=Ludwig;color=#aabbcc;emotes=25:2-6 :ludwig!ludwig@host PRIVMSG #room :👋 Kappa hi","room").unwrap();
        let Event::Message(m) = e else { panic!() };
        assert_eq!(m.name, "Ludwig");
        assert_eq!(&m.text[m.emotes[0].start..m.emotes[0].end], "Kappa");
        assert!(
            parts(&m, &HashMap::new())
                .iter()
                .any(|p| matches!(p,Part::Emote{name,..} if name=="Kappa"))
        );
    }
    #[test]
    fn ignores_other_rooms_and_invalid_ranges() {
        assert!(parse(":x!x@h PRIVMSG #other :hello", "room").is_none());
        let Event::Message(m) =
            parse("@emotes=25:99-100 :user!u@h PRIVMSG #room :hello", "room").unwrap()
        else {
            panic!()
        };
        assert!(m.emotes.is_empty());
    }
    #[test]
    fn unescapes_and_handles_moderation() {
        assert_eq!(tag_text("Hello\\sWorld\\:yes"), "Hello World;yes");
        assert!(
            matches!(parse("@target-msg-id=x :tmi.twitch.tv CLEARMSG #room :gone","room"),Some(Event::Delete(id)) if id=="x")
        );
        assert!(matches!(
            parse(":tmi.twitch.tv CLEARCHAT #room :User", "room"),
            Some(Event::ClearUser(_))
        ));
    }
}
