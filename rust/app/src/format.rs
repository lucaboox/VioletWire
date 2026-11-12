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
    fn checks_logins() {
        assert!(is_login("ufdtech"));
        assert!(is_login("jason_the_ween"));
        assert!(!is_login("../settings"));
        assert!(!is_login(""));
    }
}
