//! The data behind Electron's chat user card (`getChatUserProfile`): Twitch's
//! public profile, plus IVR's public "subage" record for following and
//! subscription details (Chatterino's source too; Helix only tells a user
//! about themselves). IVR is best effort: the card stays useful without it.
//! Everything here is untrusted text from other users and services.

use std::time::Duration;

use anyhow::{Context as _, Result};
use serde_json::Value;

use crate::session::Session;

#[derive(Clone, Debug, Default)]
pub struct Profile {
    pub display_name: String,
    pub image: Option<String>,
    pub description: String,
    pub created: Option<String>,
    /// `None` when IVR did not answer.
    pub following: Option<String>,
    pub subscription: Option<String>,
}

fn text(value: &Value, limit: usize) -> String {
    value
        .as_str()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control() || *c == ' ')
        .take(limit)
        .collect()
}

/// `2015-03-04T12:00:00Z` as `Mar 4, 2015`.
pub fn short_date(iso: &str) -> Option<String> {
    let (year, rest) = iso.get(..10)?.split_once('-')?;
    let (month, day) = rest.split_once('-')?;
    let month = match month {
        "01" => "Jan",
        "02" => "Feb",
        "03" => "Mar",
        "04" => "Apr",
        "05" => "May",
        "06" => "Jun",
        "07" => "Jul",
        "08" => "Aug",
        "09" => "Sep",
        "10" => "Oct",
        "11" => "Nov",
        "12" => "Dec",
        _ => return None,
    };
    let day: u8 = day.parse().ok()?;
    let year: u16 = year.parse().ok()?;
    Some(format!("{month} {day}, {year}"))
}

fn tier(tier: &str) -> &'static str {
    match tier {
        "3000" | "3" => "Tier 3",
        "2000" | "2" => "Tier 2",
        _ => "Tier 1",
    }
}

pub fn load(agent: &ureq::Agent, session: Option<&Session>, channel: &str, login: &str) -> Result<Profile> {
    let session = session.context("Sign in to see profile details.")?;
    let (user, ivr) = std::thread::scope(|scope| {
        let ivr = scope.spawn(|| ivr_subage(agent, channel, login));
        let user = super::assets::helix_json(
            agent,
            "https://api.twitch.tv/helix/users",
            session,
            &[("login", login)],
        );
        (user, ivr.join().ok().flatten())
    });
    let user = user.context("Profile details unavailable.")?;
    let user = user["data"].get(0).context("The Twitch user could not be found.")?;
    let image = text(&user["profile_image_url"], 400);
    let mut profile = Profile {
        display_name: text(&user["display_name"], 40),
        image: crate::twitch::helix::is_twitch_image_url(&image).then_some(image),
        description: text(&user["description"], 300),
        created: user["created_at"].as_str().and_then(short_date),
        following: None,
        subscription: None,
    };
    if let Some(ivr) = ivr {
        profile.following = Some(
            ivr["followedAt"]
                .as_str()
                .and_then(short_date)
                .unwrap_or_else(|| "Not following".to_owned()),
        );
        let months = ivr["cumulative"]["months"].as_u64().unwrap_or(0);
        profile.subscription = Some(if ivr["statusHidden"].as_bool().unwrap_or(false) {
            "Subscription status hidden".to_owned()
        } else if let Some(level) = ivr["meta"]["tier"].as_str() {
            format!("{} · {months} months", tier(level))
        } else if months > 0 {
            format!("Previously subscribed · {months} months")
        } else {
            "Not subscribed".to_owned()
        });
    }
    Ok(profile)
}

fn ivr_subage(agent: &ureq::Agent, channel: &str, login: &str) -> Option<Value> {
    if !crate::format::is_login(channel) || !crate::format::is_login(login) {
        return None;
    }
    let mut response = agent
        .get(format!("https://api.ivr.fi/v2/twitch/subage/{login}/{channel}"))
        .header("Accept", "application/json")
        .config()
        .timeout_global(Some(Duration::from_secs(5)))
        .max_redirects(0)
        .build()
        .call()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = response.body_mut().with_config().limit(64 * 1024).read_to_vec().ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::short_date;

    #[test]
    fn formats_twitch_dates() {
        assert_eq!(short_date("2015-03-04T12:00:00Z").as_deref(), Some("Mar 4, 2015"));
        assert_eq!(short_date("2015-13-04T12:00:00Z"), None);
        assert_eq!(short_date("nonsense"), None);
    }
}
