//! VioletWire's dark palette, taken from the Electron app's styles.css.

use gpui::{Rgba, rgb};
use std::sync::atomic::{AtomicBool, Ordering};
static OLED: AtomicBool = AtomicBool::new(false);
pub fn set_oled(oled: bool) {
    OLED.store(oled, Ordering::Relaxed);
}
fn panel(normal: u32) -> Rgba {
    rgb(if OLED.load(Ordering::Relaxed) {
        0
    } else {
        normal
    })
}

pub fn background() -> Rgba {
    panel(0x09090b)
}
pub fn title_bar() -> Rgba {
    panel(0x121216)
}
pub fn surface() -> Rgba {
    panel(0x0e0e10)
}
pub fn surface_hover() -> Rgba {
    rgb(0x1c1c21)
}
pub fn border() -> Rgba {
    rgb(0x242429)
}
pub fn text() -> Rgba {
    rgb(0xf4f4f5)
}
pub fn text_dim() -> Rgba {
    rgb(0x8f8f99)
}
pub fn violet() -> Rgba {
    rgb(0x8b5cf6)
}
pub fn violet_hover() -> Rgba {
    rgb(0xa78bfa)
}
pub fn live() -> Rgba {
    rgb(0xeb0400)
}
/// Windows 11's close-button red.
pub fn close_hover() -> Rgba {
    rgb(0xc42b1c)
}

pub fn sidebar() -> Rgba {
    panel(0x111114)
}
pub fn topbar() -> Rgba {
    panel(0x0d0d10)
}
pub fn chat_header() -> Rgba {
    panel(0x151519)
}
pub fn popup() -> Rgba {
    panel(0x18181b)
}
pub fn overlay(opacity: u8) -> Rgba {
    let mut color = surface();
    color.a = f32::from(opacity) / 100.;
    color
}
pub fn input() -> Rgba {
    rgb(0x17171b)
}
pub fn input_border() -> Rgba {
    rgb(0x2d2d34)
}
pub fn text_secondary() -> Rgba {
    rgb(0xd4d4d8)
}
pub fn primary() -> Rgba {
    rgb(0x7c3aed)
}
pub fn button() -> Rgba {
    rgb(0x222228)
}
pub fn button_border() -> Rgba {
    rgb(0x3a3a43)
}
pub fn button_hover() -> Rgba {
    rgb(0x2b2b32)
}
pub fn selected() -> Rgba {
    rgb(0x2a2035)
}
pub fn selected_border() -> Rgba {
    rgb(0x503b68)
}
pub fn selected_hover() -> Rgba {
    rgb(0x382747)
}
pub fn accent_text() -> Rgba {
    rgb(0xddd6fe)
}
pub fn live_dot() -> Rgba {
    rgb(0xf43f5e)
}
pub const UI_FONT: &str = "Segoe UI Variable";
/// Caption-button glyphs. Present on Windows 10 and 11.
pub const ICON_FONT: &str = "Segoe MDL2 Assets";
