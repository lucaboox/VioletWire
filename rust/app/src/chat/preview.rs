//! Link previews for chat (Electron's `LinkPreviewService` and
//! `generic-link-preview.ts`). Known providers (Twitch and Kick clips,
//! YouTube, direct image links) are always previewed on hover; any other
//! public page only when the viewer turned generic previews on. Everything a
//! linked site sends is untrusted: sizes are capped, only https is followed,
//! nothing is executed, and addresses on the local network are refused.

use std::collections::HashMap;
use std::net::{IpAddr, ToSocketAddrs};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail};
use gpui::RenderImage;
use serde_json::Value;

use crate::session::Session;

const CACHE_FOR: Duration = Duration::from_secs(600);
const MAX_CACHE: usize = 160;
const MAX_HTML: u64 = 512 * 1024;
const MAX_IMAGE: u64 = 4 * 1024 * 1024;

#[derive(Clone)]
pub struct Preview {
    /// "Twitch clip", "Kick clip", "YouTube", "Image" or the site's name.
    pub kind: String,
    pub title: String,
    pub detail: Option<String>,
    pub image: Option<Arc<RenderImage>>,
}

type Cache = HashMap<String, (Instant, Option<Preview>)>;
static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

/// The preview for `url`, or `None` when there is nothing to show.
pub fn resolve(url: &str, session: Option<&Session>, generic: bool) -> Option<Preview> {
    let key = format!("{generic}:{url}");
    if let Some((at, preview)) = CACHE.lock().unwrap_or_else(PoisonError::into_inner).as_ref().and_then(|cache| cache.get(&key))
        && at.elapsed() < CACHE_FOR
    {
        return preview.clone();
    }
    let preview = lookup(url, session, generic).ok().flatten();
    let mut cache = CACHE.lock().unwrap_or_else(PoisonError::into_inner);
    let cache = cache.get_or_insert_with(HashMap::new);
    if cache.len() >= MAX_CACHE {
        cache.retain(|_, (at, _)| at.elapsed() < CACHE_FOR);
        if cache.len() >= MAX_CACHE {
            cache.clear();
        }
    }
    cache.insert(key, (Instant::now(), preview.clone()));
    preview
}

struct Url<'a> {
    host: String,
    path: &'a str,
    query: &'a str,
}

fn parse(url: &str) -> Option<Url<'_>> {
    let rest = url.strip_prefix("https://")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.contains('@') || authority.is_empty() {
        return None;
    }
    let host = authority.split(':').next()?.to_ascii_lowercase();
    let after = &rest[end..];
    let after = after.split('#').next().unwrap_or_default();
    let (path, query) = after.split_once('?').unwrap_or((after, ""));
    Some(Url { host, path: if path.is_empty() { "/" } else { path }, query })
}

fn query_value<'a>(query: &'a str, name: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| pair.split_once('=').filter(|(key, _)| *key == name).map(|(_, value)| value))
}

fn id_like(text: &str, min: usize, max: usize) -> Option<&str> {
    ((min..=max).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
        .then_some(text)
}

fn segments(path: &str) -> Vec<&str> {
    path.split('/').filter(|segment| !segment.is_empty()).collect()
}

fn twitch_clip(url: &Url) -> Option<String> {
    if url.host == "clips.twitch.tv" {
        return segments(url.path).first().and_then(|id| id_like(id, 4, 160)).map(str::to_owned);
    }
    if !matches!(url.host.as_str(), "twitch.tv" | "www.twitch.tv" | "m.twitch.tv") {
        return None;
    }
    let parts = segments(url.path);
    let from_path = parts.iter().position(|part| part.eq_ignore_ascii_case("clip")).and_then(|at| parts.get(at + 1)).copied();
    from_path.or_else(|| query_value(url.query, "clip")).and_then(|id| id_like(id, 4, 160)).map(str::to_owned)
}

fn kick_clip(url: &Url) -> Option<String> {
    if !matches!(url.host.as_str(), "kick.com" | "www.kick.com") {
        return None;
    }
    let parts = segments(url.path);
    let from_path = parts
        .iter()
        .position(|part| part.eq_ignore_ascii_case("clip") || part.eq_ignore_ascii_case("clips"))
        .and_then(|at| parts.get(at + 1))
        .copied();
    from_path.or_else(|| query_value(url.query, "clip")).and_then(|id| id_like(id, 4, 160)).map(str::to_owned)
}

fn youtube_video(url: &Url) -> Option<String> {
    let host = url.host.trim_start_matches("www.").trim_start_matches("m.");
    let parts = segments(url.path);
    let id = match host {
        "youtu.be" => parts.first().copied(),
        "youtube.com" if url.path == "/watch" => query_value(url.query, "v"),
        "youtube.com" if matches!(parts.first(), Some(&("shorts" | "live" | "embed"))) => parts.get(1).copied(),
        _ => None,
    };
    id.and_then(|id| id_like(id, 6, 20)).map(str::to_owned)
}

/// A link that is itself a picture (Electron's `getLinkImagePreviewUrl`).
pub fn image_link(url: &str) -> Option<String> {
    let parsed = parse(url)?;
    if matches!(parsed.host.as_str(), "imgur.com" | "www.imgur.com" | "m.imgur.com") {
        let name = segments(parsed.path);
        let [file] = name.as_slice() else { return None };
        let (id, extension) = file.split_once('.').unwrap_or((file, "jpg"));
        let extension = extension.to_ascii_lowercase().replace("jpeg", "jpg");
        return (id_like(id, 5, 16).is_some() && id.bytes().all(|b| b.is_ascii_alphanumeric())
            && matches!(extension.as_str(), "png" | "jpg" | "gif" | "webp"))
        .then(|| format!("https://i.imgur.com/{id}.{extension}"));
    }
    if matches!(parsed.host.as_str(), "gyazo.com" | "www.gyazo.com") {
        let parts = segments(parsed.path);
        let [id] = parts.as_slice() else { return None };
        return (id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())).then(|| format!("https://i.gyazo.com/{id}.jpg"));
    }
    let lower = parsed.path.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp"]
        .iter()
        .any(|extension| lower.ends_with(extension))
        .then(|| url.split('#').next().unwrap_or(url).to_owned())
}

fn lookup(url: &str, session: Option<&Session>, generic: bool) -> Result<Option<Preview>> {
    let Some(parsed) = parse(url) else { return Ok(None) };
    if let Some(id) = twitch_clip(&parsed) {
        let Some(session) = session else { return Ok(None) };
        let agent = crate::http::agent();
        let Some(value) = super::assets::helix_json(&agent, "https://api.twitch.tv/helix/clips", session, &[("id", id.as_str())]) else {
            return Ok(None);
        };
        let clip = &value["data"][0];
        let Some(title) = text(&clip["title"], 200) else { return Ok(None) };
        return Ok(Some(Preview {
            kind: "Twitch clip".into(),
            title,
            detail: Some(join(&[
                text(&clip["broadcaster_name"], 40),
                clip["view_count"].as_u64().map(|views| format!("{} views", crate::format::compact_count(views))),
                clip["duration"].as_f64().map(|seconds| format!("{seconds:.0}s")),
            ])),
            image: thumbnail(&clip["thumbnail_url"]),
        }));
    }
    if let Some(id) = kick_clip(&parsed) {
        let value = crate::playback::kick::get(&format!("https://kick.com/api/v2/clips/{id}/play"))
            .or_else(|_| crate::playback::kick::get(&format!("https://kick.com/api/v2/clips/{id}")))?;
        let clip = &value["clip"];
        let image = clip["thumbnail_url"]
            .as_str()
            .filter(|url| parse(url).is_some_and(|url| url.host == "clips.kick.com"))
            .and_then(|url| fetch_image(url).ok());
        return Ok(Some(Preview {
            kind: "Kick clip".into(),
            title: text(&clip["title"], 200).unwrap_or_else(|| "Kick clip".into()),
            detail: Some(join(&[
                text(&clip["channel"]["slug"], 40),
                clip["views"].as_u64().map(|views| format!("{} views", crate::format::compact_count(views))),
                clip["duration"].as_f64().map(|seconds| format!("{seconds:.0}s")),
            ])),
            image,
        }));
    }
    if let Some(id) = youtube_video(&parsed) {
        let oembed = format!(
            "https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D{id}"
        );
        let mut response = crate::http::agent().get(&oembed).call()?;
        if !response.status().is_success() {
            return Ok(None);
        }
        let value: Value = response.body_mut().with_config().limit(64 * 1024).read_json()?;
        let Some(title) = text(&value["title"], 200) else { return Ok(None) };
        return Ok(Some(Preview {
            kind: "YouTube".into(),
            title,
            detail: text(&value["author_name"], 100),
            image: thumbnail(&value["thumbnail_url"]),
        }));
    }
    if let Some(image) = image_link(url) {
        let picture = fetch_image(&image).ok();
        return Ok(picture.map(|picture| Preview {
            kind: "Image".into(),
            title: parsed.host.clone(),
            detail: None,
            image: Some(picture),
        }));
    }
    if generic {
        return generic_preview(url).map(Some);
    }
    Ok(None)
}

fn text(value: &Value, limit: usize) -> Option<String> {
    let text: String = value.as_str()?.chars().filter(|c| !c.is_control()).take(limit).collect();
    let text = text.trim().to_owned();
    (!text.is_empty()).then_some(text)
}

fn join(parts: &[Option<String>]) -> String {
    parts.iter().flatten().cloned().collect::<Vec<_>>().join(" · ")
}

fn thumbnail(value: &Value) -> Option<Arc<RenderImage>> {
    fetch_image(value.as_str()?).ok()
}

// ----- Fetching from linked sites -----------------------------------------

/// Not an address on this machine or the local network.
fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_multicast()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || a == 0
                || (a == 100 && (64..128).contains(&b))
                || (a == 198 && (b == 18 || b == 19))
                || a >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return public(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || first == 0x2001 && v6.segments()[1] == 0x0db8
                || first == 0x0064)
        }
    }
}

/// An https GET of a public address, following at most three redirects,
/// each checked again. (The address is checked when resolved; the request
/// itself resolves once more, a narrow window this accepts.)
fn public_get(url: &str, limit: u64, accept: &str) -> Result<(Vec<u8>, String)> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .timeout_global(Some(Duration::from_secs(5)))
        .user_agent(concat!("VioletWire/", env!("CARGO_PKG_VERSION"), " link preview"))
        .build()
        .into();
    let mut current = url.to_owned();
    for _ in 0..4 {
        let parsed = parse(&current).context("Only https links are previewed.")?;
        if parsed.host == "localhost" || parsed.host.ends_with(".localhost") || parsed.host.ends_with(".local") || parsed.host.ends_with(".internal") {
            bail!("Local addresses are not previewed.");
        }
        let host = parsed.host.trim_start_matches('[').trim_end_matches(']').to_owned();
        let addresses: Vec<_> = (host.as_str(), 443).to_socket_addrs()?.collect();
        if addresses.is_empty() || !addresses.iter().all(|address| public(address.ip())) {
            bail!("Private addresses are not previewed.");
        }
        let mut response = agent.get(&current).header("Accept", accept).call()?;
        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            let location = response.headers().get("location").and_then(|value| value.to_str().ok()).context("Bad redirect.")?;
            current = if location.starts_with("https://") {
                location.to_owned()
            } else if location.starts_with('/') && !location.starts_with("//") {
                format!("https://{}{location}", parsed.host)
            } else {
                bail!("Only https links are previewed.");
            };
            continue;
        }
        if !(200..300).contains(&status) {
            bail!("The site answered {status}.");
        }
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let bytes = response.body_mut().with_config().limit(limit).read_to_vec()?;
        return Ok((bytes, content_type));
    }
    bail!("Too many redirects.")
}

fn fetch_image(url: &str) -> Result<Arc<RenderImage>> {
    let (bytes, _) = public_get(url, MAX_IMAGE, "image/*")?;
    crate::images::decode_preview(&bytes)
}

/// A meta tag's content: `<meta property|name="key" content="...">`.
fn meta(html: &str, keys: &[&str]) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    for key in keys {
        let mut from = 0;
        while let Some(at) = lower[from..].find("<meta") {
            let start = from + at;
            let end = lower[start..].find('>').map_or(lower.len(), |end| start + end);
            let tag = &html[start..end];
            let tag_lower = &lower[start..end];
            let names = [attribute(tag, tag_lower, "property"), attribute(tag, tag_lower, "name")];
            if names.iter().flatten().any(|name| name.eq_ignore_ascii_case(key))
                && let Some(content) = attribute(tag, tag_lower, "content")
            {
                return Some(unescape(&content));
            }
            from = end;
        }
    }
    None
}

fn attribute(tag: &str, lower: &str, name: &str) -> Option<String> {
    let mut from = 0;
    while let Some(at) = lower[from..].find(name) {
        let start = from + at;
        from = start + name.len();
        if start > 0 && !lower.as_bytes()[start - 1].is_ascii_whitespace() {
            continue;
        }
        let rest = lower[from..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else { continue };
        let offset = lower.len() - rest.len();
        let rest_original = tag[offset..].trim_start();
        let quote = rest_original.chars().next()?;
        if quote == '"' || quote == '\'' {
            let body = &rest_original[1..];
            return body.find(quote).map(|end| body[..end].to_owned());
        }
        return rest_original.split_whitespace().next().map(str::to_owned);
    }
    None
}

fn unescape(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn generic_preview(url: &str) -> Result<Preview> {
    let (bytes, content_type) = public_get(url, MAX_HTML, "text/html,application/xhtml+xml")?;
    if !content_type.is_empty() && !content_type.starts_with("text/html") && !content_type.starts_with("application/xhtml") {
        bail!("Not a web page.");
    }
    let html = String::from_utf8_lossy(&bytes);
    let title = meta(&html, &["og:title", "twitter:title"]).or_else(|| {
        let lower = html.to_ascii_lowercase();
        let start = lower.find("<title")?;
        let start = start + lower[start..].find('>')? + 1;
        let end = start + lower[start..].find("</title")?;
        Some(unescape(html[start..end].trim()))
    });
    let clean = |text: String, limit: usize| -> String {
        text.chars().filter(|c| !c.is_control()).take(limit).collect::<String>().trim().to_owned()
    };
    let title = clean(title.context("The page has no title.")?, 200);
    if title.is_empty() {
        bail!("The page has no title.");
    }
    let site = meta(&html, &["og:site_name", "twitter:site"]).map(|site| clean(site, 60));
    let description = meta(&html, &["og:description", "twitter:description", "description"]).map(|text| clean(text, 300));
    let image = meta(&html, &["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"])
        .filter(|image| image.starts_with("https://"))
        .and_then(|image| fetch_image(&image).ok());
    let host = parse(url).map(|url| url.host).unwrap_or_default();
    Ok(Preview {
        kind: site.filter(|site| !site.is_empty()).unwrap_or(host),
        title,
        detail: description.filter(|text| !text.is_empty()),
        image,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_known_links() {
        let clip = |url: &str| twitch_clip(&parse(url).unwrap());
        assert_eq!(clip("https://clips.twitch.tv/FunnyClip-abc_123").as_deref(), Some("FunnyClip-abc_123"));
        assert_eq!(clip("https://www.twitch.tv/xqc/clip/Some-Clip").as_deref(), Some("Some-Clip"));
        assert_eq!(clip("https://www.twitch.tv/xqc"), None);
        assert_eq!(kick_clip(&parse("https://kick.com/xqc/clips/clip_01ABC").unwrap()).as_deref(), Some("clip_01ABC"));
        assert_eq!(kick_clip(&parse("https://kick.com/xqc?clip=clip_01ABC").unwrap()).as_deref(), Some("clip_01ABC"));
        let video = |url: &str| youtube_video(&parse(url).unwrap());
        assert_eq!(video("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(video("https://youtu.be/dQw4w9WgXcQ").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(video("https://youtube.com/shorts/abcdefgh").as_deref(), Some("abcdefgh"));
        assert_eq!(image_link("https://imgur.com/AbCdE12").as_deref(), Some("https://i.imgur.com/AbCdE12.jpg"));
        assert_eq!(image_link("https://example.com/a/cat.PNG").as_deref(), Some("https://example.com/a/cat.PNG"));
        assert_eq!(image_link("https://example.com/page"), None);
        assert!(parse("http://example.com/").is_none());
        assert!(parse("https://user@example.com/").is_none());
    }

    #[test]
    fn refuses_local_addresses() {
        for address in ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:192.168.1.1"] {
            assert!(!public(address.parse().unwrap()), "{address}");
        }
        for address in ["1.1.1.1", "142.250.72.14", "2606:4700::1111"] {
            assert!(public(address.parse().unwrap()), "{address}");
        }
    }

    #[test]
    fn reads_page_metadata() {
        let html = r#"<html><head><title>Fallback</title>
            <meta property="og:title" content="The &amp; Title">
            <meta name='description' content='About it'>
            <meta content="https://img.example/x.png" property="og:image"></head></html>"#;
        assert_eq!(meta(html, &["og:title"]).as_deref(), Some("The & Title"));
        assert_eq!(meta(html, &["og:description", "description"]).as_deref(), Some("About it"));
        assert_eq!(meta(html, &["og:image"]).as_deref(), Some("https://img.example/x.png"));
        assert_eq!(meta(html, &["twitter:title"]), None);
    }
}
