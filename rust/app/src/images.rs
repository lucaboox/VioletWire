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
    if !is_twitch_image_url(url) && !crate::kick::is_image_url(url) {
        bail!("Refused an image outside Twitch's and Kick's CDNs.");
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

/// Kick's built-in chat badges, drawn from Kick's own artwork (Electron's
/// `KickBadgeGlyph`); its API never exposes them as images.
const KICK_GLYPHS: [(&str, &str); 4] = [
    ("verified", include_str!("../assets/kick-badges/verified.svg")),
    ("sub_gifter", include_str!("../assets/kick-badges/sub_gifter.svg")),
    ("moderator", include_str!("../assets/kick-badges/moderator.svg")),
    ("vip", include_str!("../assets/kick-badges/vip.svg")),
];

pub fn kick_glyph(kind: &str) -> Option<&'static str> {
    KICK_GLYPHS.iter().find(|(name, _)| *name == kind).map(|(_, svg)| *svg)
}

/// An SVG badge, rasterised at twice its 18 px size.
fn svg_image(bytes: &[u8]) -> Result<Arc<RenderImage>> {
    use resvg::{tiny_skia, usvg};
    let tree = usvg::Tree::from_data(bytes, &usvg::Options::default()).context("Unreadable badge.")?;
    let side = 36u32;
    let size = tree.size();
    let scale = side as f32 / size.width().max(size.height()).max(1.);
    let mut pixmap = tiny_skia::Pixmap::new(side, side).context("Badge too large.")?;
    resvg::render(&tree, tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    let mut buffer = Vec::with_capacity((side * side * 4) as usize);
    for pixel in pixmap.pixels() {
        let color = pixel.demultiply();
        // GPUI's images are BGRA.
        buffer.extend_from_slice(&[color.blue(), color.green(), color.red(), color.alpha()]);
    }
    let image = image::RgbaImage::from_raw(side, side, buffer).context("Badge too large.")?;
    Ok(Arc::new(RenderImage::new(vec![Frame::new(image)])))
}

fn looks_like_svg(bytes: &[u8]) -> bool {
    let start = String::from_utf8_lossy(&bytes[..bytes.len().min(256)]);
    let start = start.trim_start_matches('\u{feff}').trim_start();
    start.starts_with("<svg") || (start.starts_with("<?xml") && start.contains("<svg"))
}

pub fn fetch_chat(agent: &ureq::Agent, url: &str, animated: bool) -> Result<Arc<RenderImage>> {
    if let Some(kind) = url.strip_prefix("kick-badge:") {
        return svg_image(kick_glyph(kind).context("Unknown Kick badge.")?.as_bytes());
    }
    if !crate::chat::is_image_url(url) {
        bail!("Invalid emote image host.");
    }
    // Emote and badge images never change for one URL: keep them on disk.
    if let Some(bytes) = crate::cache::read(crate::cache::Kind::Images, url)
        && let Ok(image) = decode_chat(&bytes, animated)
    {
        return Ok(image);
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
    let image = decode_chat(&bytes, animated)?;
    crate::cache::write(crate::cache::Kind::Images, url, &bytes);
    Ok(image)
}

fn decode_chat(bytes: &[u8], animated: bool) -> Result<Arc<RenderImage>> {
    if looks_like_svg(bytes) {
        return svg_image(bytes);
    }
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
        ImageFormat::Webp => {
            let mut decoder = WebPDecoder::new(cursor)?;
            if decoder.has_animation() {
                // image-webp leaves disposal disabled without an explicit
                // background. Emotes clear disposed regions to transparency.
                decoder.set_background_color(image::Rgba([0, 0, 0, 0]))?;
            }
            Box::new(decoder.into_frames())
        }
        _ => Box::new(std::iter::once(
            image::load_from_memory(bytes).map(|image| Frame::new(image.into_rgba8())),
        )),
    };
    // Decode only once off the UI thread. Preserve GIF/WebP animation, while
    // capping decoded memory as well as the compressed download. Oversized
    // animations become a still image instead of occupying an unbounded atlas.
    let (mut decoded, mut size) = (Vec::new(), 0usize);
    for frame in frames {
        let frame = frame?;
        size += frame.buffer().len();
        if size > 8 * 1024 * 1024 || decoded.len() >= 300 {
            decoded.truncate(1);
            break;
        }
        // Browsers play a GIF frame of 10 ms or less at 100 ms; GPUI would
        // spin through it at the display rate.
        let (numerator, denominator) = frame.delay().numer_denom_ms();
        let delay = if numerator <= 10 * denominator.max(1) {
            image::Delay::from_numer_denom_ms(100, 1)
        } else {
            frame.delay()
        };
        let (left, top) = (frame.left(), frame.top());
        let mut buffer = frame.into_buffer();
        for pixel in buffer.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }
        let frame = Frame::from_parts(buffer, left, top, delay);
        decoded.push(frame);
        if !animated {
            break;
        }
    }
    if decoded.is_empty() {
        // A still WebP yields no frames from the animation decoder: it was
        // every static 7TV emote.
        let mut still = image::load_from_memory(bytes)
            .context("Emote has no image frames.")?
            .into_rgba8();
        for pixel in still.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }
        decoded.push(Frame::new(still));
    }
    Ok(Arc::new(RenderImage::new(decoded)))
}

/// A flipped or rotated copy of an emote, for Electron's emote modifiers
/// (`h!`, `v!`, `l!`, `r!` and FFZ's flip flags). Every frame keeps its delay.
pub fn transformed(
    image: &RenderImage,
    flip_x: bool,
    flip_y: bool,
    rotate: i8,
) -> Option<Arc<RenderImage>> {
    let mut frames = Vec::with_capacity(image.frame_count());
    for index in 0..image.frame_count() {
        let size = image.size(index);
        let (width, height) = (
            u32::try_from(size.width.0).ok()?,
            u32::try_from(size.height.0).ok()?,
        );
        let buffer = image::RgbaImage::from_raw(width, height, image.as_bytes(index)?.to_vec())?;
        let mut buffer = match rotate {
            1 => image::imageops::rotate90(&buffer),
            -1 => image::imageops::rotate270(&buffer),
            _ => buffer,
        };
        if flip_x {
            image::imageops::flip_horizontal_in_place(&mut buffer);
        }
        if flip_y {
            image::imageops::flip_vertical_in_place(&mut buffer);
        }
        frames.push(Frame::from_parts(buffer, 0, 0, image.delay(index)));
    }
    (!frames.is_empty()).then(|| Arc::new(RenderImage::new(frames)))
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
    fn animated_webp(canvas: (u32, u32), frames: &[(image::RgbaImage, u32, u32, bool)]) -> Vec<u8> {
        fn uint24(out: &mut Vec<u8>, value: u32) {
            out.extend_from_slice(&value.to_le_bytes()[..3]);
        }
        fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], bytes: &[u8]) {
            out.extend_from_slice(kind);
            out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            out.extend_from_slice(bytes);
            if !bytes.len().is_multiple_of(2) {
                out.push(0);
            }
        }
        let mut body = b"WEBP".to_vec();
        let mut header = vec![0x12, 0, 0, 0]; // Animation and alpha.
        uint24(&mut header, canvas.0 - 1);
        uint24(&mut header, canvas.1 - 1);
        chunk(&mut body, b"VP8X", &header);
        chunk(&mut body, b"ANIM", &[0; 6]);
        for (pixels, left, top, dispose) in frames {
            let mut encoded = Vec::new();
            image::codecs::webp::WebPEncoder::new_lossless(&mut encoded)
                .encode(
                    pixels.as_raw(),
                    pixels.width(),
                    pixels.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .unwrap();
            let mut frame = Vec::new();
            uint24(&mut frame, left / 2);
            uint24(&mut frame, top / 2);
            uint24(&mut frame, pixels.width() - 1);
            uint24(&mut frame, pixels.height() - 1);
            uint24(&mut frame, 50);
            frame.push(u8::from(*dispose)); // Alpha blend; optional disposal.
            frame.extend_from_slice(&encoded[12..]);
            chunk(&mut body, b"ANMF", &frame);
        }
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&(body.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&body);
        bytes
    }
    fn pixel(image: &RenderImage, frame: usize, x: usize, y: usize) -> &[u8] {
        let offset = (y * image.size(frame).width.0 as usize + x) * 4;
        &image.as_bytes(frame).unwrap()[offset..offset + 4]
    }
    fn assert_opaque_color(actual: &[u8], expected: [u8; 3]) {
        assert_eq!(actual[3], 255);
        // WebP's integer alpha blending can round an opaque channel down by 1.
        assert!(
            actual[..3]
                .iter()
                .zip(expected)
                .all(|(actual, expected)| actual.abs_diff(expected) <= 1),
            "unexpected color {actual:?}"
        );
    }
    #[test]
    fn animated_webp_disposal_clears_old_pixels_without_erasing_kept_regions() {
        let mut base = image::RgbaImage::new(4, 2);
        base.put_pixel(3, 0, image::Rgba([0, 0, 255, 255]));
        let mut red = image::RgbaImage::new(2, 2);
        red.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
        let mut green = image::RgbaImage::new(2, 2);
        green.put_pixel(0, 0, image::Rgba([0, 255, 0, 255]));
        let bytes = animated_webp(
            (4, 2),
            &[(base, 0, 0, false), (red, 0, 0, true), (green, 2, 0, false)],
        );
        let image = decode_chat(&bytes, true).unwrap();
        assert_eq!(image.frame_count(), 3);
        assert_opaque_color(pixel(&image, 1, 0, 0), [0, 0, 255]);
        assert_eq!(
            pixel(&image, 2, 0, 0),
            &[0, 0, 0, 0],
            "disposed red pixels must not ghost into the next frame"
        );
        assert_opaque_color(pixel(&image, 2, 2, 0), [0, 255, 0]);
        assert_opaque_color(pixel(&image, 2, 3, 0), [255, 0, 0]);
        assert_eq!(image.delay(2).numer_denom_ms(), (50, 1));
    }
    #[test]
    fn animated_webp_keep_preserves_pixels_needed_by_delta_frames() {
        let mut red = image::RgbaImage::new(4, 2);
        red.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
        let mut green = image::RgbaImage::new(4, 2);
        green.put_pixel(2, 0, image::Rgba([0, 255, 0, 255]));
        let image = decode_chat(
            &animated_webp((4, 2), &[(red, 0, 0, false), (green, 0, 0, false)]),
            true,
        )
        .unwrap();
        assert_opaque_color(pixel(&image, 1, 0, 0), [0, 0, 255]);
        assert_opaque_color(pixel(&image, 1, 2, 0), [0, 255, 0]);
    }
    #[test]
    fn animated_webp_full_frame_disposal_removes_transparent_trails() {
        let mut red = image::RgbaImage::new(4, 2);
        red.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
        let mut green = image::RgbaImage::new(4, 2);
        green.put_pixel(2, 0, image::Rgba([0, 255, 0, 255]));
        let image = decode_chat(
            &animated_webp((4, 2), &[(red, 0, 0, true), (green, 0, 0, true)]),
            true,
        )
        .unwrap();
        assert_eq!(pixel(&image, 1, 0, 0), &[0, 0, 0, 0]);
        assert_opaque_color(pixel(&image, 1, 2, 0), [0, 255, 0]);
    }
    #[test]
    fn draws_kick_badge_glyphs() {
        for (name, svg) in KICK_GLYPHS {
            let image = svg_image(svg.as_bytes()).unwrap_or_else(|error| panic!("{name}: {error}"));
            let pixels = image.as_bytes(0).unwrap();
            assert!(pixels.chunks_exact(4).any(|pixel| pixel[3] > 200), "{name} drew nothing");
        }
        assert!(looks_like_svg(b"<?xml version=\"1.0\"?><svg></svg>"));
        assert!(!looks_like_svg(b"GIF89a"));
    }

    #[test]
    #[ignore = "decodes files named in VIOLETWIRE_TEST_IMAGES"]
    fn decodes_listed_files() {
        for path in std::env::var("VIOLETWIRE_TEST_IMAGES")
            .unwrap_or_default()
            .split(';')
        {
            if path.is_empty() {
                continue;
            }
            let bytes = std::fs::read(path).unwrap();
            match decode_chat(&bytes, true) {
                Ok(image) => println!("{path}: {} frames", image.frame_count()),
                Err(error) => println!("{path}: ERROR {error:#}"),
            }
        }
    }

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
