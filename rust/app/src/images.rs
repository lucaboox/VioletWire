//! Downloads Twitch CDN images for GPUI. GPUI's own URL loader needs an HTTP
//! client the app does not install, so images arrive as decoded-on-demand
//! bytes instead.

use std::sync::Arc;

use anyhow::{Context as _, Result, bail};
use gpui::{Image, ImageFormat};

use crate::twitch::helix::is_twitch_image_url;

const MAX_IMAGE_BYTES: u64 = 4 * 1024 * 1024;

pub fn fetch(agent: &ureq::Agent, url: &str) -> Result<Arc<Image>> {
    if !is_twitch_image_url(url) {
        bail!("Refused an image outside Twitch's CDN.");
    }
    let mut response = agent.get(url).call().context("Image request failed.")?;
    if !response.status().is_success() {
        bail!("Image request returned {}.", response.status().as_u16());
    }
    let bytes = response
        .body_mut()
        .with_config()
        .limit(MAX_IMAGE_BYTES)
        .read_to_vec()
        .context("Image download failed.")?;
    // Trust the bytes, not the URL extension or Content-Type.
    let format = sniff(&bytes).context("Unsupported image format.")?;
    Ok(Arc::new(Image::from_bytes(format, bytes)))
}

fn sniff(bytes: &[u8]) -> Option<ImageFormat> {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => Some(ImageFormat::Png),
        [0xFF, 0xD8, 0xFF, ..] => Some(ImageFormat::Jpeg),
        [b'G', b'I', b'F', b'8', ..] => Some(ImageFormat::Gif),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some(ImageFormat::Webp),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_formats_by_their_bytes() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n"), Some(ImageFormat::Png));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some(ImageFormat::Jpeg));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some(ImageFormat::Webp));
        assert_eq!(sniff(b"<svg"), None);
    }
}
