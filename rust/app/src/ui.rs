//! Shared controls matching the Electron client's styles.css and Lucide icons.
use crate::theme;
use gpui::{
    AssetSource, Context, Div, FontWeight, Render, SharedString, Stateful, Window, div,
    prelude::*, px, rgba, svg,
};
use std::borrow::Cow;

macro_rules! icons {
    ($($variant:ident => $file:literal),* $(,)?) => {
        #[derive(Clone, Copy)]
        pub enum Icon { $($variant),* }
        impl Icon {
            pub fn path(self) -> &'static str {
                match self { $(Self::$variant => concat!("icons/",$file,".svg")),* }
            }
        }
        const ICONS: &[(&str,&[u8])] = &[$((concat!("icons/",$file,".svg"),include_bytes!(concat!("../assets/icons/",$file,".svg")))),*];
    };
}
icons! {
    Home=>"house", Search=>"search", Back=>"arrow-left", Forward=>"arrow-right",
    External=>"external-link", Chat=>"message-square", ChatClose=>"panel-right-close",
SidebarClose=>"panel-left-close", SidebarOpen=>"panel-left-open",
    Overlay=>"picture-in-picture-2", Theater=>"rectangle-horizontal", Fullscreen=>"maximize",
    ExitFullscreen=>"minimize", Play=>"play", Pause=>"pause", Volume=>"volume-2", Muted=>"volume-x",
    Emotes=>"smile", Close=>"x", Users=>"users", Clock=>"clock-3", Refresh=>"refresh-cw",
    SignOut=>"log-out", SignIn=>"log-in", Down=>"arrow-down",
    Settings=>"settings",Reply=>"reply",Copy=>"copy",
    Gauge=>"gauge", Quality=>"sliders-horizontal", AudioLines=>"audio-lines",
    AudioLinesOff=>"audio-lines-off", Compass=>"compass", Check=>"check",
    ChevronDown=>"chevron-down", Scissors=>"scissors", Star=>"star", StarFilled=>"star-filled",
    Keyboard=>"keyboard", Monitor=>"monitor", Info=>"info", Globe=>"globe", Sparkles=>"sparkles", Grid=>"layout-grid",
    Twitch=>"twitch", Kick=>"kick", Pin=>"pin",
    ChevronLeft=>"chevron-left", Heart=>"heart", HeartFilled=>"heart-filled", PopOut=>"app-window",
}
pub struct Assets;
impl AssetSource for Assets {
    fn load(&self, path: &str) -> anyhow::Result<Option<Cow<'static, [u8]>>> {
        Ok(ICONS
            .iter()
            .find(|(name, _)| *name == path)
            .map(|(_, bytes)| Cow::Borrowed(*bytes)))
    }
    fn list(&self, path: &str) -> anyhow::Result<Vec<SharedString>> {
        Ok(ICONS
            .iter()
            .filter(|(name, _)| name.starts_with(path))
            .map(|(name, _)| (*name).into())
            .collect())
    }
}
pub fn icon(icon: Icon, size: f32) -> gpui::Svg {
    svg()
        .path(icon.path())
        .size(px(size))
        .flex_none()
        .text_color(theme::text_secondary())
}
/// Twitch's or Kick's mark in its own colour (Electron's `ProviderLogo`).
pub fn provider_logo(kick: bool, size: f32) -> gpui::Svg {
    svg()
        .path(if kick { Icon::Kick.path() } else { Icon::Twitch.path() })
        .size(px(size))
        .flex_none()
        .text_color(gpui::rgb(if kick { KICK_GREEN } else { TWITCH_PURPLE }))
}
pub const TWITCH_PURPLE: u32 = 0xa970ff;
pub const KICK_GREEN: u32 = 0x53fc18;

/// The window's display scale, kept so artwork can be drawn at its exact
/// pixel size (set each frame by the root view).
static SCALE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0x3f80_0000);

pub fn set_scale(scale: f32) {
    SCALE.store(scale.to_bits(), std::sync::atomic::Ordering::Relaxed);
}

/// The app icon, as Electron's `.brand-mark`. The artwork is 1080 px; GPUI
/// samples a big shrink coarsely, so it is shrunk once here with a proper
/// filter to the exact pixels shown, as the browser does.
pub fn brand(size: f32) -> impl IntoElement {
    use gpui::{ImageSource, RenderImage, img};
    use std::{cell::RefCell, collections::HashMap, sync::Arc};
    thread_local! {
        static SIZES: RefCell<HashMap<u32, Arc<RenderImage>>> = RefCell::new(HashMap::new());
    }
    let scale = f32::from_bits(SCALE.load(std::sync::atomic::Ordering::Relaxed)).clamp(0.5, 4.);
    let pixels = (size * scale).round().max(1.) as u32;
    let image = SIZES.with_borrow_mut(|sizes| {
        sizes
            .entry(pixels)
            .or_insert_with(|| {
                let art = image::load_from_memory(include_bytes!("../assets/violetwire-icon.png"))
                    .map(|art| art.into_rgba8())
                    .unwrap_or_else(|_| image::RgbaImage::new(1, 1));
                let mut small = image::imageops::resize(&art, pixels, pixels, image::imageops::FilterType::Lanczos3);
                for pixel in small.chunks_exact_mut(4) {
                    pixel.swap(0, 2);
                }
                Arc::new(RenderImage::new(vec![image::Frame::new(small)]))
            })
            .clone()
    });
    div()
        .size(px(size))
        .flex_none()
        .rounded(px(9.))
        .overflow_hidden()
        // Electron's `box-shadow: 0 6px 20px #7c3aed55`.
        .shadow(vec![gpui::BoxShadow {
            color: gpui::hsla(262. / 360., 0.83, 0.58, 0.33),
            offset: gpui::point(px(0.), px(6.)),
            blur_radius: px(20.),
            spread_radius: px(0.),
        }])
        .child(img(ImageSource::Render(image)).size_full())
}

#[derive(Clone, Copy)]
pub enum ButtonStyle {
    Primary,
    Secondary,
    Ghost,
    Selected,
    Disabled,
}
pub fn button(
    id: &'static str,
    label: impl Into<SharedString>,
    glyph: Option<Icon>,
    style: ButtonStyle,
) -> Stateful<Div> {
    let label = label.into();
    let (background, border, text, hover) = match style {
        ButtonStyle::Disabled => (
            gpui::rgb(0x29292f),
            gpui::rgb(0x37373e),
            gpui::rgb(0x777781),
            gpui::rgb(0x29292f),
        ),
        ButtonStyle::Primary => (
            theme::primary(),
            theme::violet(),
            gpui::rgb(0xffffff),
            theme::violet(),
        ),
        ButtonStyle::Secondary => (
            theme::button(),
            theme::button_border(),
            theme::text_secondary(),
            theme::button_hover(),
        ),
        ButtonStyle::Ghost => (rgba(0), rgba(0), theme::text_dim(), theme::surface_hover()),
        ButtonStyle::Selected => (
            theme::selected(),
            theme::selected_border(),
            theme::accent_text(),
            theme::selected_hover(),
        ),
    };
    div()
        .id(id)
        .flex_none()
        .h(px(34.))
        .px_3()
        .flex()
        .items_center()
        .justify_center()
        .gap(px(7.))
        .rounded(px(7.))
        .border_1()
        .border_color(border)
        .bg(background)
        .text_color(text)
        .text_size(px(12.))
        .font_weight(FontWeight::SEMIBOLD)
        .cursor_pointer()
        .hover(move |s| s.bg(hover).text_color(theme::text()))
        .active(move |s| {
            s.bg(if matches!(style, ButtonStyle::Disabled) {
                background
            } else {
                theme::selected_hover()
            })
        })
        .when_some(glyph, |v, g| v.child(icon(g, 15.).text_color(text)))
        .when(!label.is_empty(), |v| v.child(label))
}
pub fn icon_button(
    id: &'static str,
    glyph: Icon,
    label: &'static str,
    selected: bool,
) -> Stateful<Div> {
    icon_button_colored(id, glyph, label, selected, theme::text_dim())
}
fn icon_button_colored(
    id: &'static str,
    glyph: Icon,
    label: &'static str,
    selected: bool,
    color: gpui::Rgba,
) -> Stateful<Div> {
    let control = button(
        id,
        "",
        None,
        if selected {
            ButtonStyle::Selected
        } else {
            ButtonStyle::Ghost
        },
    );
    control
        .w(px(34.))
        .px_0()
        .child(icon(glyph, 18.).text_color(if selected {
            theme::accent_text()
        } else {
            color
        }))
        .tooltip(move |_, cx| cx.new(|_| Tooltip(label.into())).into())
}
pub fn video_button(
    id: &'static str,
    glyph: Icon,
    label: &'static str,
    selected: bool,
) -> Stateful<Div> {
    icon_button_colored(id, glyph, label, false, theme::text()).when(selected, |v| {
        v.bg(rgba(0x23232ae0)).border_color(rgba(0xffffff26))
    })
}
pub struct Tooltip(pub SharedString);
impl Render for Tooltip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .max_w(px(360.))
            .px_3()
            .py_2()
            .rounded(px(7.))
            .border_1()
            .border_color(theme::button_border())
            .bg(theme::button())
            .text_color(theme::text())
            .text_size(px(12.))
            .font_weight(FontWeight::SEMIBOLD)
            .child(self.0.clone())
    }
}
