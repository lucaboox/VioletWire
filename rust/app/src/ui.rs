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
    Twitch=>"twitch", Kick=>"kick",
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

pub fn brand(size: f32) -> impl IntoElement {
    use gpui::{Image, ImageFormat, img};
    img(std::sync::Arc::new(Image::from_bytes(
        ImageFormat::Png,
        include_bytes!("../assets/violetwire-icon.png").to_vec(),
    )))
    .size(px(size))
    .rounded(px(size * 0.3))
    .flex_none()
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
