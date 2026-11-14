use super::assets::{Provider, ProviderEmote};
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct Message {
    pub first_message: bool,
    pub sent_at: Option<u64>,
    pub reply: Option<Box<Reply>>,
    pub system: Option<String>,
    pub id: String,
    pub login: String,
    /// The sender's numeric ID (Kick needs it to reply); may be empty.
    pub user_id: String,
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
    pub login: String,
    pub user_id: String,
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

/// A numeric ID, or empty.
pub fn digits(value: Option<&str>) -> String {
    value
        .filter(|id| (1..=20).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit()))
        .unwrap_or_default()
        .to_owned()
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
                            user_id: digits(tags.get("reply-parent-user-id").copied()),
                            login: tags
                                .get("reply-parent-user-login")
                                .filter(|login| crate::format::is_login(login))
                                .map(|login| login.to_ascii_lowercase())
                                .unwrap_or_default(),
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
                user_id: digits(tags.get("user-id").copied()),
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

/// Electron's emote effects that a still image can show (`emote-effects.ts`).
/// The animated ones (party, shake, rainbow, hyper, jam, bounce) are dropped.
pub mod effect {
    pub const FLIP_X: u8 = 1;
    pub const FLIP_Y: u8 = 2;
    pub const WIDE: u8 = 4;
    pub const ZERO_SPACE: u8 = 8;
    pub const CURSED: u8 = 16;
    pub const ROTATE_LEFT: u8 = 32;
    pub const ROTATE_RIGHT: u8 = 64;
}

fn effects_of(modifier: &str, emote: &ProviderEmote) -> u8 {
    use effect::*;
    let named = match modifier {
        "w!" | "ffzW" => WIDE,
        "h!" | "ffzX" => FLIP_X,
        "v!" | "ffzY" => FLIP_Y,
        "z!" => ZERO_SPACE,
        "c!" | "ffzCursed" => CURSED,
        "l!" => ROTATE_LEFT,
        "r!" => ROTATE_RIGHT,
        _ => 0,
    };
    let flags = emote.modifier_flags;
    let mut bits = named;
    if flags & 2 != 0 {
        bits |= FLIP_X;
    }
    if flags & 4 != 0 {
        bits |= FLIP_Y;
    }
    if flags & 8 != 0 {
        bits |= WIDE;
    }
    if flags & 16_384 != 0 {
        bits |= CURSED;
    }
    bits
}

#[derive(Clone)]
pub struct EmotePart {
    pub name: String,
    pub url: String,
    pub provider: Provider,
    /// The emote's 1x size, when the provider says; Twitch's own are not
    /// scaled.
    pub logical: Option<(f32, f32)>,
    /// Drawn over the emote before it.
    pub overlay: bool,
    pub effects: u8,
}

#[derive(Clone)]
pub enum Part {
    Text(String),
    /// `@name`, drawn bold as in Electron.
    Mention(String),
    Emote(EmotePart),
}

fn twitch_url(id: &str) -> String {
    if let Some(id) = id.strip_prefix("kick-") {
        return format!("https://files.kick.com/emotes/{id}/fullsize");
    }
    format!("https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/2.0")
}

/// Electron's `withoutRedundantReplyMention`: a reply's leading `@parent` is
/// already shown by the reply line. Returns the bytes to skip.
fn reply_prefix(message: &Message) -> usize {
    let Some(reply) = &message.reply else {
        return 0;
    };
    let lower = message.text.to_lowercase();
    for name in [&reply.login, &reply.name] {
        if name.is_empty() {
            continue;
        }
        let prefix = format!("@{}", name.to_lowercase());
        if lower == prefix {
            return message.text.len();
        }
        if lower.starts_with(&format!("{prefix} ")) && message.text.is_char_boundary(prefix.len() + 1)
        {
            return prefix.len() + 1;
        }
    }
    0
}

pub fn parts(message: &Message, providers: &HashMap<String, ProviderEmote>) -> Vec<Part> {
    let skip = reply_prefix(message);
    let mut output = Vec::new();
    let mut cursor = skip;
    let mut any_emote = false;
    for emote in &message.emotes {
        if emote.start < cursor
            || emote.end <= emote.start
            || emote.end > message.text.len()
            || !message.text.is_char_boundary(emote.start)
            || !message.text.is_char_boundary(emote.end)
        {
            continue;
        }
        words(&message.text[cursor..emote.start], providers, any_emote, &mut output);
        output.push(Part::Emote(EmotePart {
            name: message.text[emote.start..emote.end].into(),
            url: twitch_url(&emote.id),
            provider: Provider::Twitch,
            logical: None,
            overlay: false,
            effects: 0,
        }));
        any_emote = true;
        cursor = emote.end;
    }
    if cursor < message.text.len() {
        words(&message.text[cursor..], providers, any_emote, &mut output);
    }
    output
}

fn push_text(output: &mut Vec<Part>, text: &str) {
    if text.is_empty() {
        return;
    }
    if let Some(Part::Text(last)) = output.last_mut() {
        last.push_str(text);
    } else {
        output.push(Part::Text(text.to_owned()));
    }
}

fn push_word(output: &mut Vec<Part>, word: &str) {
    let name = word.trim_start_matches('@');
    let login = name.trim_end_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_');
    if word.starts_with('@') && word.len() > 1 && crate::format::is_login(login) {
        output.push(Part::Mention(word.to_owned()));
    } else {
        push_text(output, word);
    }
}

/// Splits text into words and the whitespace between them, keeping both.
fn tokens(text: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut start = 0;
    let mut space = None;
    for (index, c) in text.char_indices() {
        let is_space = c.is_whitespace();
        if space.is_some_and(|was| was != is_space) {
            tokens.push(&text[start..index]);
            start = index;
        }
        space = Some(is_space);
    }
    if start < text.len() {
        tokens.push(&text[start..]);
    }
    tokens
}

fn is_space(token: &str) -> bool {
    token.chars().all(char::is_whitespace)
}

/// Electron's `plainTextSegments`. `preceded` says an emote already stands to
/// the left (a Twitch emote earlier in the message), so a zero-width emote has
/// something to stack on.
fn words(
    text: &str,
    providers: &HashMap<String, ProviderEmote>,
    preceded: bool,
    output: &mut Vec<Part>,
) {
    let tokens = tokens(text);
    let mut pending: Vec<(&str, &ProviderEmote)> = Vec::new();
    let mut any_emote = preceded;
    let emote_part = |name: &str, emote: &ProviderEmote, overlay: bool, effects: u8| {
        Part::Emote(EmotePart {
            name: name.to_owned(),
            url: emote.url.clone(),
            provider: emote.provider,
            logical: Some((emote.width, emote.height)),
            overlay,
            effects,
        })
    };
    let flush = |pending: &mut Vec<(&str, &ProviderEmote)>, output: &mut Vec<Part>| {
        if !pending.is_empty() {
            let names: Vec<&str> = pending.iter().map(|(name, _)| *name).collect();
            push_text(output, &format!("{} ", names.join(" ")));
            pending.clear();
        }
    };
    let pending_effects = |pending: &[(&str, &ProviderEmote)]| {
        pending
            .iter()
            .fold(0, |bits, (name, emote)| bits | effects_of(name, emote))
    };
    for (index, token) in tokens.iter().enumerate() {
        if is_space(token) {
            if pending.is_empty() {
                push_text(output, token);
            }
            continue;
        }
        let emote = providers.get(*token);
        if let Some(emote) = emote.filter(|emote| emote.zero_width) {
            // Drawn over the emote before it, without the space between; with
            // nothing to stack on, it is an ordinary emote.
            if any_emote
                && let Some(Part::Text(last)) = output.last()
                && is_space(last)
            {
                output.pop();
            }
            output.push(emote_part(token, emote, any_emote, pending_effects(&pending)));
            pending.clear();
            any_emote = true;
            continue;
        }
        if let Some(emote) = emote.filter(|emote| emote.modifier) {
            let next = tokens[index + 1..].iter().find(|token| !is_space(token));
            let next_emote = next.and_then(|next| providers.get(*next));
            let prefix = emote.provider == Provider::Bttv
                || token.ends_with('!')
                || next_emote.is_some_and(|next| !next.modifier);
            if prefix {
                pending.push((token, emote));
                continue;
            }
            // A suffix modifier changes the emote just before it.
            let last_emote = output.iter().rposition(|part| matches!(part, Part::Emote(_)));
            if let Some(at) = last_emote
                && output[at + 1..]
                    .iter()
                    .all(|part| matches!(part, Part::Text(text) if is_space(text)))
            {
                output.truncate(at + 1);
                if let Some(Part::Emote(part)) = output.last_mut() {
                    part.effects |= effects_of(token, emote);
                }
                continue;
            }
            push_text(output, token);
            continue;
        }
        if let Some(emote) = emote {
            output.push(emote_part(token, emote, false, pending_effects(&pending)));
            pending.clear();
            any_emote = true;
            continue;
        }
        flush(&mut pending, output);
        push_word(output, token);
    }
    flush(&mut pending, output);
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
                .any(|p| matches!(p, Part::Emote(e) if e.name == "Kappa"))
        );
    }
    fn emote(provider: Provider, zero_width: bool, modifier: bool, flags: u32) -> ProviderEmote {
        ProviderEmote {
            url: "https://cdn.7tv.app/emote/a/2x.webp".into(),
            provider,
            width: 32.,
            height: 32.,
            zero_width,
            modifier,
            modifier_flags: flags,
            channel: false,
        }
    }
    fn message(text: &str) -> Message {
        let Event::Message(m) = parse(&format!(":v!v@h PRIVMSG #room :{text}"), "room").unwrap()
        else {
            panic!()
        };
        m
    }
    #[test]
    fn stacks_zero_width_emotes_and_applies_modifiers() {
        let providers = HashMap::from([
            ("PepeLaugh".to_owned(), emote(Provider::SevenTv, false, false, 0)),
            ("RainTime".to_owned(), emote(Provider::SevenTv, true, false, 0)),
            ("h!".to_owned(), emote(Provider::Bttv, false, true, 0)),
            ("ffzX".to_owned(), emote(Provider::Ffz, false, true, 2)),
        ]);
        let got = parts(&message("PepeLaugh RainTime"), &providers);
        assert_eq!(got.len(), 2, "the space before an overlay goes");
        assert!(matches!(&got[1], Part::Emote(e) if e.overlay));
        // Alone, a zero-width emote is an ordinary one.
        let got = parts(&message("RainTime"), &providers);
        assert!(matches!(&got[0], Part::Emote(e) if !e.overlay));
        // BTTV modifiers come first; FFZ ones can follow.
        let got = parts(&message("h! PepeLaugh"), &providers);
        assert!(matches!(&got[..], [Part::Emote(e)] if e.effects & effect::FLIP_X != 0));
        let got = parts(&message("PepeLaugh ffzX hi"), &providers);
        assert!(matches!(&got[0], Part::Emote(e) if e.effects & effect::FLIP_X != 0));
        assert!(matches!(&got[1], Part::Text(text) if text == " hi"));
        // A modifier with nothing to change is just text.
        let got = parts(&message("h! hello"), &providers);
        assert!(matches!(&got[0], Part::Text(text) if text.starts_with("h! hello")));
    }
    #[test]
    fn drops_a_replys_leading_mention_and_bolds_others() {
        let Event::Message(m) = parse(
            "@reply-parent-msg-id=p;reply-parent-user-login=streamer;reply-parent-display-name=Streamer :v!v@h PRIVMSG #room :@Streamer hi @someone",
            "room",
        )
        .unwrap() else {
            panic!()
        };
        let got = parts(&m, &HashMap::new());
        assert!(matches!(&got[0], Part::Text(text) if text == "hi "));
        assert!(matches!(&got[1], Part::Mention(text) if text == "@someone"));
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
