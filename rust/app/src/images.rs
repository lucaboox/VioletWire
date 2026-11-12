//! Downloads Twitch CDN images for GPUI. GPUI's own URL loader needs an HTTP
//! client the app does not install, so images arrive as decoded-on-demand
//! bytes instead.

use std::sync::Arc;

use anyhow::{Context as _, Result, bail};
use gpui::{Image, ImageFormat, RenderImage};
use image::{
    AnimationDecoder, Frame,
    codecs::{gif::GifDecoder, webp::WebPDecoder},
};

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
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => Some(ImageFormat::Webp),
        _ => None,
    }
}

pub fn fetch_chat(agent: &ureq::Agent, url: &str, animated: bool) -> Result<Arc<RenderImage>> {
    if !crate::chat::is_image_url(url) {
        bail!("Invalid emote image host.");
    }
    let mut response = agent
        .get(url)
        .config()
        .max_redirects(0)
        .timeout_global(Some(std::time::Duration::from_secs(8)))
        .build()
        .call()
        .context("Emote download failed.")?;
    if !response.status().is_success() {
        bail!("Emote is unavailable.");
    }
    let bytes = response
        .body_mut()
        .with_config()
        .limit(512 * 1024)
        .read_to_vec()?;
    decode_chat(&bytes, animated)
}

fn decode_chat(bytes: &[u8], animated: bool) -> Result<Arc<RenderImage>> {
    let format = sniff(bytes).context("Unsupported emote image.")?;
    let (width, height) = image::ImageReader::new(std::io::Cursor::new(&bytes))
        .with_guessed_format()?
        .into_dimensions()?;
    if width == 0
        || height == 0
        || width > 1536
        || height > 256
        || u64::from(width) * u64::from(height) > 65_536
    {
        bail!("Emote dimensions are too large.");
    }
    let cursor = std::io::Cursor::new(bytes);
    let frames: Box<dyn Iterator<Item = image::ImageResult<Frame>>> = match format {
        ImageFormat::Gif => Box::new(GifDecoder::new(cursor)?.into_frames()),
        ImageFormat::Webp => Box::new(WebPDecoder::new(cursor)?.into_frames()),
        _ => Box::new(std::iter::once(
            image::load_from_memory(bytes).map(|image| Frame::new(image.into_rgba8())),
        )),
    };
    // Decode only once off the UI thread. Preserve GIF/WebP animation, while
    // capping decoded memory as well as the compressed download. Oversized
    // animations become a still image instead of occupying an unbounded atlas.
    let (mut decoded, mut size) = (Vec::new(), 0usize);
    for frame in frames {
        let mut frame = frame?;
        size += frame.buffer().len();
        if size > 2 * 1024 * 1024 || decoded.len() >= 120 {
            decoded.truncate(1);
            break;
        }
        for pixel in frame.buffer_mut().chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }
        decoded.push(frame);
        if !animated {
            break;
        }
    }
    if decoded.is_empty() {
        bail!("Emote has no image frames.");
    }
    Ok(Arc::new(RenderImage::new(decoded)))
}

pub fn decoded_bytes(image: &RenderImage) -> usize {
    (0..image.frame_count())
        .filter_map(|index| image.as_bytes(index))
        .map(<[u8]>::len)
        .sum()
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

    #[test]
    fn emotes_preserve_animation_timing_and_convert_bgra() {
        let mut bytes = Vec::new();
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
            for color in [[255, 0, 0, 255], [0, 255, 0, 255]] {
                encoder
                    .encode_frame(Frame::from_parts(
                        image::RgbaImage::from_pixel(2, 2, image::Rgba(color)),
                        0,
                        0,
                        image::Delay::from_numer_denom_ms(100, 1),
                    ))
                    .unwrap();
            }
        }
        let image = decode_chat(&bytes, true).unwrap();
        assert_eq!(image.frame_count(), 2);
        assert_eq!(image.delay(0).numer_denom_ms(), (100, 1));
        assert_eq!(&image.as_bytes(0).unwrap()[..4], &[0, 0, 255, 255]);
        assert_eq!(decoded_bytes(&image), 32);
        assert_eq!(decode_chat(&bytes, false).unwrap().frame_count(), 1);
    }

    #[test]
    fn emotes_reject_large_decoded_dimensions() {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::RgbaImage::new(1600, 1)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        assert!(decode_chat(bytes.get_ref(), true).is_err());
    }
    #[test]
    fn accepts_wide_emotes_with_a_bounded_pixel_count() {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::RgbaImage::new(400, 56)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let emote = decode_chat(bytes.get_ref(), true).unwrap();
        assert_eq!(emote.size(0).width.0, 400);
        assert_eq!(decoded_bytes(&emote), 400 * 56 * 4);
    }
}
