//! Small display helpers.

/// 950 -> "950", 12_345 -> "12.3K", 1_200_000 -> "1.2M".
pub fn compact_count(count: u64) -> String {
    fn scaled(value: f64, suffix: &str) -> String {
        let text = format!("{value:.1}");
        format!("{}{suffix}", text.strip_suffix(".0").unwrap_or(&text))
    }
    match count {
        0..=999 => count.to_string(),
        1_000..=999_949 => scaled(count as f64 / 1_000.0, "K"),
        _ => scaled(count as f64 / 1_000_000.0, "M"),
    }
}

/// Seconds since the Unix epoch for a Helix `2026-11-12T15:04:05Z` time.
pub fn unix_from_rfc3339(text: &str) -> Option<u64> {
    let number = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // Howard Hinnant's days-from-civil.
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    u64::try_from(days * 86_400 + hour * 3_600 + minute * 60 + second).ok()
}

/// "3h 07m" or "42m".
pub fn uptime(started_at: &str, now: u64) -> Option<String> {
    let elapsed = now.checked_sub(unix_from_rfc3339(started_at)?)?;
    let (hours, minutes) = (elapsed / 3_600, elapsed % 3_600 / 60);
    Some(if hours > 0 {
        format!("{hours}h {minutes:02}m")
    } else {
        format!("{minutes}m")
    })
}

/// Electron's labels: `best` → "Auto", `1080p60` → "1080p · 60 FPS".
pub fn quality_label(name: &str) -> String {
    match name {
        "best" => return "Auto".into(),
        "worst" => return "Lowest".into(),
        "source" => return "Source".into(),
        "audio_only" => return "Audio only".into(),
        _ => {}
    }
    match name.split_once('p') {
        Some((lines, rate))
            if lines.len() >= 2 && lines.bytes().all(|b| b.is_ascii_digit()) =>
        {
            if rate.is_empty() {
                format!("{lines}p")
            } else if rate.bytes().all(|b| b.is_ascii_digit()) {
                format!("{lines}p · {rate} FPS")
            } else {
                name.into()
            }
        }
        _ => name.into(),
    }
}

/// Source first, then by height and frame rate, audio only last — the
/// Electron menu's order.
pub fn sort_qualities(names: &mut [String]) {
    fn rank(name: &str) -> (u8, u32, u32) {
        match name {
            "source" => (0, 0, 0),
            "audio_only" => (2, 0, 0),
            _ => {
                let (lines, rate) = name.split_once('p').unwrap_or((name, ""));
                let lines = lines.parse::<u32>().unwrap_or(0);
                let rate = rate.parse::<u32>().unwrap_or(30);
                (1, u32::MAX - lines, u32::MAX - rate)
            }
        }
    }
    names.sort_by_key(|name| rank(name));
}

/// A card's chips, as in Electron: the language code, then up to three of
/// the channel's tags, skipping ones that repeat the language.
pub fn visible_tags(language: &str, tags: &[String]) -> Vec<String> {
    const NAMES: &[(&str, &str)] = &[
        ("de", "german"), ("en", "english"), ("es", "spanish"), ("fr", "french"),
        ("it", "italian"), ("ja", "japanese"), ("ko", "korean"), ("pl", "polish"),
        ("pt", "portuguese"), ("ru", "russian"), ("tr", "turkish"), ("zh", "chinese"),
    ];
    let code = language.trim().to_ascii_lowercase();
    let name = NAMES.iter().find(|(c, _)| *c == code).map(|(_, n)| *n);
    let mut chips: Vec<String> = Vec::new();
    if !code.is_empty() && code != "other" {
        chips.push(code.to_ascii_uppercase());
    }
    let mut seen: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag.trim();
        let normalized = tag.to_lowercase();
        if normalized.is_empty()
            || normalized == code
            || Some(normalized.as_str()) == name
            || seen.contains(&normalized)
        {
            continue;
        }
        seen.push(normalized);
        chips.push(tag.to_owned());
        if seen.len() == 3 {
            break;
        }
    }
    chips
}

/// Twitch logins are 1–25 ASCII letters, digits or underscores.
pub fn is_login(text: &str) -> bool {
    (1..=25).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compacts_viewer_counts() {
        assert_eq!(compact_count(950), "950");
        assert_eq!(compact_count(1_000), "1K");
        assert_eq!(compact_count(12_345), "12.3K");
        assert_eq!(compact_count(999_999), "1M");
        assert_eq!(compact_count(1_250_000), "1.2M");
    }

    #[test]
    fn reads_helix_times() {
        assert_eq!(unix_from_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(unix_from_rfc3339("2000-03-01T00:00:00Z"), Some(951_868_800));
        assert_eq!(unix_from_rfc3339("2026-11-12T15:04:05Z"), Some(1_794_495_845));
        assert_eq!(unix_from_rfc3339("not a time"), None);
    }

    #[test]
    fn formats_uptime() {
        let start = unix_from_rfc3339("2026-11-12T10:00:00Z").unwrap();
        assert_eq!(uptime("2026-11-12T10:00:00Z", start + 42 * 60).as_deref(), Some("42m"));
        assert_eq!(uptime("2026-11-12T10:00:00Z", start + 3 * 3_600 + 7 * 60).as_deref(), Some("3h 07m"));
        assert_eq!(uptime("2026-11-12T10:00:00Z", start - 5), None);
    }

    #[test]
    fn labels_and_orders_qualities_like_electron() {
        assert_eq!(quality_label("best"), "Auto");
        assert_eq!(quality_label("1080p60"), "1080p · 60 FPS");
        assert_eq!(quality_label("720p"), "720p");
        assert_eq!(quality_label("audio_only"), "Audio only");
        let mut names: Vec<String> = ["160p", "audio_only", "720p60", "1080p60", "720p", "source"]
            .map(String::from)
            .to_vec();
        sort_qualities(&mut names);
        assert_eq!(names, ["source", "1080p60", "720p60", "720p", "160p", "audio_only"]);
    }

    #[test]
    fn hides_tags_that_repeat_the_language() {
        let tags: Vec<String> = ["English", "DropsEnabled", "en", "Furry", "furry", "Chill"]
            .map(String::from)
            .to_vec();
        assert_eq!(visible_tags("en", &tags), ["EN", "DropsEnabled", "Furry", "Chill"]);
        assert_eq!(visible_tags("", &[]), Vec::<String>::new());
    }

    #[test]
    fn checks_logins() {
        assert!(is_login("ufdtech"));
        assert!(is_login("jason_the_ween"));
        assert!(!is_login("../settings"));
        assert!(!is_login(""));
    }
}
