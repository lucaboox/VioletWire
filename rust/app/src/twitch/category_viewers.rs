//! How many people are watching each Twitch category right now.
//!
//! Helix lists categories but has never said how many are watching one.
//! Twitch's own site gets the number from its GraphQL API, so this asks that
//! API the same way the Electron client does: anonymously, with the site's
//! public client ID (which the bundled Streamlink also uses). No account token
//! is sent. Any failure leaves the counts out; the categories still show.

use std::collections::HashMap;
use std::time::Duration;

use serde::Deserialize;

const WEB_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const GQL_URL: &str = "https://gql.twitch.tv/gql";
/// Twitch refuses more aliased root fields than this in one query.
const PER_REQUEST: usize = 15;
const MAX_CATEGORIES: usize = 100;

#[derive(Deserialize)]
struct Response {
    data: Option<HashMap<String, Option<Entry>>>,
}

#[derive(Deserialize)]
struct Entry {
    id: String,
    #[serde(rename = "viewersCount")]
    viewers: Option<u64>,
}

fn is_category_id(id: &str) -> bool {
    (1..=12).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

/// One GraphQL request per group of fifteen categories.
fn requests(ids: &[&str]) -> Vec<(serde_json::Value, Vec<String>)> {
    let mut valid: Vec<&str> = Vec::new();
    for id in ids {
        if is_category_id(id) && !valid.contains(id) {
            valid.push(id);
        }
    }
    valid.truncate(MAX_CATEGORIES);
    valid
        .chunks(PER_REQUEST)
        .map(|group| {
            let declarations: Vec<String> =
                (0..group.len()).map(|index| format!("$c{index}: ID!")).collect();
            let fields: Vec<String> = (0..group.len())
                .map(|index| format!("c{index}: game(id: $c{index}) {{ id viewersCount }}"))
                .collect();
            let variables: serde_json::Map<String, serde_json::Value> = group
                .iter()
                .enumerate()
                .map(|(index, id)| (format!("c{index}"), serde_json::Value::from(*id)))
                .collect();
            (
                serde_json::json!({
                    "query": format!(
                        "query CategoryViewers({}) {{ {} }}",
                        declarations.join(", "),
                        fields.join(" ")
                    ),
                    "variables": variables,
                }),
                group.iter().map(|id| (*id).to_owned()).collect(),
            )
        })
        .collect()
}

pub fn fetch(ids: &[&str]) -> HashMap<String, u64> {
    // Its own short-timeout agent: the Browse page waits on this.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_millis(2_500)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut counts = HashMap::new();
    for (body, asked) in requests(ids) {
        let Ok(mut response) = agent
            .post(GQL_URL)
            .header("Client-ID", WEB_CLIENT_ID)
            .send_json(&body)
        else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let Ok(parsed) = response.body_mut().read_json::<Response>() else {
            continue;
        };
        for entry in parsed.data.unwrap_or_default().into_values().flatten() {
            if asked.contains(&entry.id)
                && let Some(viewers) = entry.viewers
            {
                counts.insert(entry.id, viewers);
            }
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_valid_ids_fifteen_to_a_request() {
        let ids: Vec<String> = (1..=20).map(|n| n.to_string()).collect();
        let mut refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        refs.push("../bad");
        refs.push("1");
        let built = requests(&refs);
        assert_eq!(built.len(), 2);
        assert_eq!(built[0].1.len(), 15);
        assert_eq!(built[1].1.len(), 5);
        let query = built[0].0["query"].as_str().unwrap();
        assert!(query.contains("c14: game(id: $c14) { id viewersCount }"));
        assert_eq!(built[0].0["variables"]["c0"], "1");
    }
}
