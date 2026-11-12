//! The same optional public recent-message sources as the Electron client.
//! No account token/cookies are sent. Live IRC works when both are unavailable.
use super::model::{self, Event, Message};
pub fn load(agent: &ureq::Agent, channel: &str, limit: usize) -> Vec<Message> {
    if !crate::format::is_login(channel) || limit == 0 {
        return Vec::new();
    }
    let limit = limit.min(500);
    for url in [
        format!(
            "https://logs.zonian.dev/rm/{channel}?limit={limit}&hide_moderation_messages=false&hide_moderated_messages=false"
        ),
        format!(
            "https://recent-messages.robotty.de/api/v2/recent-messages/{channel}?limit={limit}"
        ),
    ] {
        let Ok(mut response) = agent
            .get(&url)
            .config()
            .max_redirects(0)
            .timeout_global(Some(std::time::Duration::from_secs(5)))
            .build()
            .call()
        else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let Ok(bytes) = response
            .body_mut()
            .with_config()
            .limit(1024 * 1024)
            .read_to_vec()
        else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        let Some(lines) = value["messages"].as_array() else {
            continue;
        };
        let mut messages = decode(
            lines.iter().filter_map(|line| line.as_str()).take(1000),
            channel,
        );
        messages.sort_by_key(|message| message.sent_at.unwrap_or(0));
        if messages.len() > limit {
            messages.drain(..messages.len() - limit);
        }
        return messages;
    }
    Vec::new()
}
fn decode<'a>(lines: impl Iterator<Item = &'a str>, channel: &str) -> Vec<Message> {
    let mut messages = Vec::<Message>::new();
    let mut ids = std::collections::HashSet::new();
    for line in lines {
        match model::parse(line, channel) {
            Some(Event::Message(message)) => {
                if message.id.is_empty() || ids.insert(message.id.clone()) {
                    messages.push(message);
                }
            }
            Some(Event::Delete(id)) => {
                for message in &mut messages {
                    if message.id == id {
                        message.deleted = true;
                    }
                }
            }
            Some(Event::ClearUser(login)) => {
                for message in &mut messages {
                    if message.login == login {
                        message.deleted = true;
                    }
                }
            }
            Some(Event::Clear) => {
                messages.clear();
                ids.clear();
            }
            _ => {}
        }
    }
    messages
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_deduplicates_and_applies_moderation() {
        let lines = [
            "@id=a :viewer!u@h PRIVMSG #room :one",
            "@id=a :viewer!u@h PRIVMSG #room :one",
            "@id=b :viewer!u@h PRIVMSG #room :two",
            "@target-msg-id=a :tmi.twitch.tv CLEARMSG #room :one",
        ];
        let messages = decode(lines.into_iter(), "room");
        assert_eq!(messages.len(), 2);
        assert!(messages[0].deleted);
        assert!(!messages[1].deleted);
        let cleared = decode(
            lines.into_iter().chain([":tmi.twitch.tv CLEARCHAT #room"]),
            "room",
        );
        assert!(cleared.is_empty());
    }
}
