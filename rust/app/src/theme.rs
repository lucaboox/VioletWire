//! VioletWire's dark palette, taken from the Electron app's styles.css.

use gpui::{Rgba, rgb};

pub fn background() -> Rgba {
    rgb(0x0d0d10)
}
pub fn title_bar() -> Rgba {
    rgb(0x121216)
}
pub fn surface() -> Rgba {
    rgb(0x16161b)
}
pub fn surface_hover() -> Rgba {
    rgb(0x1e1e25)
}
pub fn border() -> Rgba {
    rgb(0x202024)
}
pub fn text() -> Rgba {
    rgb(0xe4e4e7)
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

pub const UI_FONT: &str = "Segoe UI";
/// Caption-button glyphs. Present on Windows 10 and 11.
pub const ICON_FONT: &str = "Segoe MDL2 Assets";
