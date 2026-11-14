//! Electron's changelog (`shared/changelog.ts`, `github-release-notes.ts`):
//! the bundled CHANGELOG.md, merged with the notes on the project's GitHub
//! releases, which can be newer. Release notes are untrusted text: they are
//! only ever shown as plain text.

use std::time::Duration;

use anyhow::{Context as _, Result, bail};
use serde_json::Value;

const BUNDLED: &str = include_str!("../../../CHANGELOG.md");
const RELEASES: &str = "https://api.github.com/repos/lucaboox/VioletWire/releases?per_page=20";

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub version: String,
    pub date: Option<String>,
    pub additions: Vec<String>,
    pub improvements: Vec<String>,
    pub fixes: Vec<String>,
}

impl Entry {
    pub fn unreleased(&self) -> bool {
        self.version.eq_ignore_ascii_case("unreleased")
    }

    fn is_empty(&self) -> bool {
        self.additions.is_empty() && self.improvements.is_empty() && self.fixes.is_empty()
    }
}

/// `- item` lines, with indented continuation lines joined on.
fn list(section: &str) -> Vec<String> {
    let mut items: Vec<String> = Vec::new();
    for line in section.lines() {
        if let Some(item) = line.strip_prefix("- ").or_else(|| line.strip_prefix("-\t")) {
            items.push(item.trim().to_owned());
        } else if line.starts_with("  ")
            && !line.trim().is_empty()
            && let Some(last) = items.last_mut()
        {
            last.push(' ');
            last.push_str(line.trim());
        }
    }
    items.into_iter().map(|item| item.chars().take(4_000).collect()).collect()
}

fn section<'a>(body: &'a str, heading: &str) -> &'a str {
    let mut found = None;
    let mut offset = 0;
    for line in body.split_inclusive('\n') {
        let trimmed = line.trim_end();
        if let Some(title) = trimmed.strip_prefix("### ") {
            if found.is_some() {
                return &body[found.unwrap_or(0)..offset];
            }
            if title.trim().eq_ignore_ascii_case(heading) {
                found = Some(offset + line.len());
            }
        }
        offset += line.len();
    }
    found.map_or("", |start| &body[start.min(body.len())..])
}

pub fn parse(markdown: &str) -> Vec<Entry> {
    let mut headings = Vec::new();
    let mut offset = 0;
    for line in markdown.split_inclusive('\n') {
        let trimmed = line.trim_end();
        if let Some(rest) = trimmed.strip_prefix("## [")
            && let Some((version, after)) = rest.split_once(']')
        {
            let date = after.trim().strip_prefix("- ").map(|date| date.trim().to_owned()).filter(|date| !date.is_empty());
            headings.push((offset, offset + line.len(), version.trim().to_owned(), date));
        }
        offset += line.len();
    }
    headings
        .iter()
        .enumerate()
        .map(|(index, (_, body_start, version, date))| {
            let end = headings.get(index + 1).map_or(markdown.len(), |next| next.0);
            let body = &markdown[*body_start..end];
            Entry {
                version: version.chars().take(64).collect(),
                date: date.clone(),
                additions: list(section(body, "Additions")),
                improvements: list(section(body, "Improvements")),
                fixes: list(section(body, "Fixes")),
            }
        })
        .collect()
}

pub fn bundled() -> Vec<Entry> {
    parse(BUNDLED)
}

/// Electron's `mergeChangelogEntries`: the releases' notes first, the bundled
/// file for anything they lack, newest version first, and the bundled
/// "Unreleased" section on top.
pub fn merge(primary: Vec<Entry>, fallback: Vec<Entry>) -> Vec<Entry> {
    let unreleased = fallback.iter().find(|entry| entry.unreleased() && !entry.is_empty()).cloned();
    let mut releases: Vec<Entry> = primary.into_iter().filter(|entry| !entry.unreleased()).collect();
    for entry in fallback {
        if !entry.unreleased() && !releases.iter().any(|known| known.version.eq_ignore_ascii_case(&entry.version)) {
            releases.push(entry);
        }
    }
    releases.sort_by(|a, b| {
        if crate::updates::newer(&a.version, &b.version) {
            std::cmp::Ordering::Less
        } else if crate::updates::newer(&b.version, &a.version) {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    unreleased.into_iter().chain(releases).collect()
}

/// The GitHub releases' notes as changelog markdown. The Rust app's own
/// `rust-v` releases carry no notes of their own, so they are passed over.
pub fn fetch() -> Result<Vec<Entry>> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(15)))
        .user_agent(concat!("VioletWire/", env!("CARGO_PKG_VERSION")))
        .build()
        .into();
    let mut response = agent
        .get(RELEASES)
        .header("Accept", "application/vnd.github+json")
        .call()
        .context("Could not reach GitHub.")?;
    if !response.status().is_success() {
        bail!("GitHub answered {}.", response.status().as_u16());
    }
    let releases: Value = response.body_mut().with_config().limit(1_000_000).read_json()?;
    let mut markdown = String::new();
    for release in releases.as_array().into_iter().flatten().take(30) {
        let tag = release["tag_name"].as_str().unwrap_or_default();
        if release["draft"].as_bool().unwrap_or(true) || tag.starts_with("rust-") {
            continue;
        }
        let version = tag.trim_start_matches(['v', 'V']);
        if version.is_empty() || version.len() > 64 || version.contains([']', '\n', '\r']) {
            continue;
        }
        let body = release["body"].as_str().unwrap_or_default().trim();
        if body.is_empty() || markdown.len() + body.len() > 750_000 {
            continue;
        }
        let date = release["published_at"].as_str().and_then(|date| date.get(..10)).unwrap_or_default();
        markdown.push_str(&format!("## [{version}]{}\n\n{body}\n\n", if date.is_empty() { String::new() } else { format!(" - {date}") }));
    }
    Ok(parse(&markdown).into_iter().filter(|entry| !entry.is_empty()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_merges_like_electron() {
        let markdown = "# Changelog\n\n## [Unreleased]\n\n### Fixes\n\n- Soon.\n\n## [0.3.4-alpha.2] - 2026-11-12\n\n### Additions\n\n- One thing\n  that wraps.\n- Two.\n\n### Fixes\n\n- Fixed.\n\n## [0.3.4-alpha.1] - 2026-11-01\n\n### Improvements\n\n- Better.\n";
        let entries = parse(markdown);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[1].version, "0.3.4-alpha.2");
        assert_eq!(entries[1].date.as_deref(), Some("2026-11-12"));
        assert_eq!(entries[1].additions, vec!["One thing that wraps.", "Two."]);
        assert_eq!(entries[1].fixes, vec!["Fixed."]);
        assert_eq!(entries[2].improvements, vec!["Better."]);
        let remote = parse("## [0.3.4-alpha.3] - 2026-11-13\n\n### Fixes\n\n- Newest.\n");
        let merged = merge(remote, entries);
        let versions: Vec<_> = merged.iter().map(|entry| entry.version.as_str()).collect();
        assert_eq!(versions, ["Unreleased", "0.3.4-alpha.3", "0.3.4-alpha.2", "0.3.4-alpha.1"]);
        assert!(!bundled().is_empty());
    }
}
