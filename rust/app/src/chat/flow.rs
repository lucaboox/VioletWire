//! Inline chat layout. Text, badges and emotes share lines and baselines rather
//! than behaving like separate flexbox words with artificial gaps.
use gpui::{
    AnyElement, App, AvailableSpace, Bounds, Element, ElementId, Font, FontWeight, GlobalElementId,
    Hsla, InspectorElementId, LayoutId, Pixels, Point, ShapedLine, SharedString, Size, Style,
    TextRun, Window, point, prelude::*, px, relative, size,
};
use std::{cell::RefCell, rc::Rc};
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone)]
enum Token {
    Text(SharedString, Font, Hsla, Option<String>),
    Image(usize, Size<Pixels>, bool),
}
enum Draw {
    Text(Box<ShapedLine>, Option<String>),
    Image(usize),
}
struct Item {
    at: Point<Pixels>,
    height: Pixels,
    draw: Draw,
}
#[derive(Default)]
struct Layout {
    items: Vec<Item>,
    height: Pixels,
    width: Pixels,
}
/// A clicked chatter name: their login and where the click landed.
pub type OnUser = Rc<dyn Fn(&str, Point<Pixels>, &mut Window, &mut App)>;
/// The web link under the pointer, and where, or `None` once it leaves.
pub type OnLinkHover = Rc<dyn Fn(Option<(&str, Point<Pixels>)>, &mut Window, &mut App)>;
/// Marks a name token: never a web address, so `cx.open_url` never sees it.
const USER_LINK: &str = "violetwire-user:";

pub struct MessageFlow {
    on_user: Option<OnUser>,
    pub on_link_hover: Option<OnLinkHover>,
    font_size: Pixels,
    tokens: Vec<Token>,
    images: Vec<AnyElement>,
    layout: Rc<RefCell<Layout>>,
    links: Vec<(gpui::Hitbox, String)>,
}
impl MessageFlow {
    pub fn new(font_size: u8) -> Self {
        Self {
            on_user: None,
            on_link_hover: None,
            font_size: px(f32::from(font_size)),
            tokens: Vec::new(),
            images: Vec::new(),
            layout: Rc::default(),
            links: Vec::new(),
        }
    }
    pub fn text(&mut self, text: &str, color: impl Into<Hsla>, bold: bool) {
        let color = color.into();
        let mut font = gpui::font(crate::theme::UI_FONT);
        if bold {
            font.weight = FontWeight::BOLD;
        }
        for word in text.split_inclusive(char::is_whitespace) {
            let trimmed = word.trim_end_matches(char::is_whitespace);
            if !trimmed.is_empty() {
                let link = link_url(trimmed);
                self.tokens.push(Token::Text(
                    trimmed.to_owned().into(),
                    font.clone(),
                    if link.is_some() {
                        crate::theme::accent_text().into()
                    } else {
                        color
                    },
                    link,
                ));
            }
            if trimmed.len() < word.len() {
                self.tokens.push(Token::Text(
                    word[trimmed.len()..].to_owned().into(),
                    font.clone(),
                    color,
                    None,
                ));
            }
        }
    }
    /// A chatter's name that opens their user card when clicked.
    pub fn user(&mut self, name: &str, suffix: &str, color: impl Into<Hsla>, login: &str, on_user: OnUser) {
        let color = color.into();
        let mut font = gpui::font(crate::theme::UI_FONT);
        font.weight = FontWeight::BOLD;
        self.on_user = Some(on_user);
        self.tokens.push(Token::Text(
            name.to_owned().into(),
            font,
            color,
            Some(format!("{USER_LINK}{login}")),
        ));
        self.text(suffix, color, true);
    }
    pub fn image(&mut self, element: AnyElement, width: f32, height: f32) {
        self.image_layer(element, width, height, false);
    }
    pub fn image_layer(&mut self, element: AnyElement, width: f32, height: f32, layered: bool) {
        self.tokens.push(Token::Image(
            self.images.len(),
            size(px(width), px(height)),
            layered,
        ));
        self.images.push(element);
    }
}

fn link_url(text: &str) -> Option<String> {
    let text = text.trim_end_matches(['.', ',', '!', '?', ')', ']', ';']);
    if text.len() > 2048 {
        return None;
    }
    let uri = text.parse::<ureq::http::Uri>().ok()?;
    (matches!(uri.scheme_str(), Some("http" | "https"))
        && uri.host().is_some_and(|host| !host.is_empty()))
    .then(|| text.to_owned())
}

fn shaped(
    text: SharedString,
    font: Font,
    color: Hsla,
    font_size: Pixels,
    window: &Window,
) -> ShapedLine {
    let run = TextRun {
        len: text.len(),
        font,
        color,
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    window
        .text_system()
        .shape_line(text, font_size, &[run], None)
}
fn finish_line(layout: &mut Layout, first: usize, height: Pixels) {
    for item in &mut layout.items[first..] {
        item.at.y = layout.height + (height - item.height) / 2.;
    }
    layout.height += height;
}
fn measure(tokens: &[Token], width: Pixels, font_size: Pixels, window: &Window) -> Layout {
    let line_height = font_size * 1.5;
    let width = width.max(px(16.));
    let mut layout = Layout {
        width,
        ..Default::default()
    };
    let (mut x, mut height, mut first) = (px(0.), line_height, 0);
    let mut previous_image: Option<(usize, Pixels)> = None;
    for token in tokens {
        match token {
            Token::Image(index, dimensions, layered) => {
                if *layered
                    && let Some((base, base_width)) =
                        previous_image.filter(|(base, _)| *base >= first)
                {
                    let base_x = layout.items[base].at.x;
                    layout.items.push(Item {
                        at: point(base_x + (base_width - dimensions.width) / 2., px(0.)),
                        height: dimensions.height,
                        draw: Draw::Image(*index),
                    });
                    x = base_x + base_width;
                    height = height.max(dimensions.height);
                    continue;
                }
                if x > px(0.) && x + dimensions.width > width {
                    finish_line(&mut layout, first, height);
                    first = layout.items.len();
                    x = px(0.);
                    height = line_height;
                }
                layout.items.push(Item {
                    at: point(x, px(0.)),
                    height: dimensions.height,
                    draw: Draw::Image(*index),
                });
                previous_image = Some((layout.items.len() - 1, dimensions.width));
                x += dimensions.width;
                height = height.max(dimensions.height);
            }
            Token::Text(text, font, color, link) => {
                let mut remaining = text.clone();
                let whitespace = remaining.chars().all(char::is_whitespace);
                if !whitespace {
                    previous_image = None;
                }
                if whitespace && x == px(0.) {
                    continue;
                }
                loop {
                    let line = shaped(remaining.clone(), font.clone(), *color, font_size, window);
                    if whitespace && line.width > width - x {
                        x = width;
                        break;
                    }
                    if line.width > width - x && x > px(0.) {
                        finish_line(&mut layout, first, height);
                        first = layout.items.len();
                        x = px(0.);
                        height = line_height;
                        if whitespace {
                            break;
                        }
                    }
                    if line.width <= width - x {
                        x += line.width;
                        layout.items.push(Item {
                            at: point(x - line.width, px(0.)),
                            height: line_height,
                            draw: Draw::Text(Box::new(line), link.clone()),
                        });
                        break;
                    }
                    // A long URL/word must wrap without clipping or splitting a
                    // UTF-8 character, emoji sequence or combining grapheme.
                    let index = line.closest_index_for_x(width);
                    let split = remaining
                        .grapheme_indices(true)
                        .map(|(i, _)| i)
                        .rfind(|i| *i > 0 && *i <= index)
                        .unwrap_or_else(|| {
                            remaining
                                .graphemes(true)
                                .next()
                                .map_or(remaining.len(), str::len)
                        });
                    let prefix = shaped(
                        remaining[..split].to_owned().into(),
                        font.clone(),
                        *color,
                        font_size,
                        window,
                    );
                    layout.items.push(Item {
                        at: point(x, px(0.)),
                        height: line_height,
                        draw: Draw::Text(Box::new(prefix), link.clone()),
                    });
                    if split == remaining.len() {
                        break;
                    }
                    remaining = remaining[split..].to_owned().into();
                    finish_line(&mut layout, first, height);
                    first = layout.items.len();
                    x = px(0.);
                    height = line_height;
                }
            }
        }
    }
    finish_line(&mut layout, first, height);
    layout
}

impl IntoElement for MessageFlow {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl Element for MessageFlow {
    type RequestLayoutState = ();
    type PrepaintState = ();
    fn id(&self) -> Option<ElementId> {
        Some("message-flow".into())
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        _cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        let tokens = self.tokens.clone();
        let state = self.layout.clone();
        let font_size = self.font_size;
        (
            window.request_measured_layout(style, move |known, available, window, _| {
                let width = known.width.unwrap_or(match available.width {
                    AvailableSpace::Definite(width) => width,
                    _ => px(360.),
                });
                let layout = measure(&tokens, width, font_size, window);
                let dimensions = size(layout.width, layout.height);
                *state.borrow_mut() = layout;
                dimensions
            }),
            (),
        )
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        if self.layout.borrow().width != bounds.size.width {
            *self.layout.borrow_mut() =
                measure(&self.tokens, bounds.size.width, self.font_size, window);
        }
        let layout = self.layout.borrow();
        self.links.clear();
        for item in &layout.items {
            if let Draw::Text(line, Some(link)) = &item.draw {
                let hitbox = window.insert_hitbox(
                    Bounds::new(bounds.origin + item.at, size(line.width, item.height)),
                    gpui::HitboxBehavior::Normal,
                );
                self.links.push((hitbox, link.clone()));
            }
            if let Draw::Image(index) = item.draw {
                let child = &mut self.images[index];
                child.prepaint_as_root(
                    bounds.origin + item.at,
                    size(AvailableSpace::MinContent, AvailableSpace::MinContent),
                    window,
                    cx,
                );
            }
        }
    }
    fn paint(
        &mut self,
        global_id: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        for item in &self.layout.borrow().items {
            match &item.draw {
                Draw::Text(line, _) => {
                    let _ = line.paint(bounds.origin + item.at, self.font_size * 1.5, window, cx);
                }
                Draw::Image(index) => self.images[*index].paint(window, cx),
            }
        }
        type LinkPress = Rc<RefCell<Option<(String, Point<Pixels>)>>>;
        type Hovered = Rc<RefCell<Option<String>>>;
        window.with_element_state::<(LinkPress, Hovered), _>(
            global_id.expect("Message flow has an ID"),
            |state, window| {
                let (state, hovered) = state.unwrap_or_default();
                // Which web link of this message the pointer is over, for
                // link previews.
                if let Some(on_hover) = self.on_link_hover.clone() {
                    let links: Vec<(gpui::Hitbox, String)> = self
                        .links
                        .iter()
                        .filter(|(_, link)| !link.starts_with(USER_LINK))
                        .cloned()
                        .collect();
                    if !links.is_empty() {
                        let hovered = hovered.clone();
                        window.on_mouse_event(move |event: &gpui::MouseMoveEvent, phase, window, cx| {
                            if phase != gpui::DispatchPhase::Bubble {
                                return;
                            }
                            let now = links
                                .iter()
                                .find(|(hitbox, _)| hitbox.is_hovered(window))
                                .map(|(_, link)| link.clone());
                            if *hovered.borrow() == now {
                                return;
                            }
                            let was = hovered.replace(now.clone());
                            match &now {
                                Some(link) => on_hover(Some((link, event.position)), window, cx),
                                None if was.is_some() => on_hover(None, window, cx),
                                None => {}
                            }
                        });
                    }
                }
                let on_user = self.on_user.clone();
                for (hitbox, link) in &self.links {
                    window.set_cursor_style(gpui::CursorStyle::PointingHand, hitbox);
                    let down_state = state.clone();
                    let down_hitbox = hitbox.clone();
                    let down_link = link.clone();
                    window.on_mouse_event(move |event: &gpui::MouseDownEvent, phase, window, _| {
                        if phase == gpui::DispatchPhase::Bubble
                            && event.button == gpui::MouseButton::Left
                            && down_hitbox.is_hovered(window)
                        {
                            *down_state.borrow_mut() = Some((down_link.clone(), event.position));
                        }
                    });
                    let state = state.clone();
                    let hitbox = hitbox.clone();
                    let link = link.clone();
                    let on_user = on_user.clone();
                    window.on_mouse_event(move |event: &gpui::MouseUpEvent, phase, window, cx| {
                        if phase == gpui::DispatchPhase::Bubble
                            && event.button == gpui::MouseButton::Left
                            && hitbox.is_hovered(window)
                            && let Some((pressed, at)) = state.borrow_mut().take()
                            && pressed == link
                            && (at.x - event.position.x).abs() < px(5.)
                            && (at.y - event.position.y).abs() < px(5.)
                        {
                            if let Some(login) = link.strip_prefix(USER_LINK) {
                                if let Some(on_user) = &on_user {
                                    on_user(login, event.position, window, cx);
                                }
                            } else {
                                cx.open_url(&link);
                            }
                            cx.stop_propagation();
                        }
                    });
                }
                ((), (state, hovered))
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn links_open_only_explicit_web_schemes() {
        assert_eq!(
            link_url("https://example.com/watch?a=1)."),
            Some("https://example.com/watch?a=1".into())
        );
        for link in [
            "javascript:alert(1)",
            "data:text/html,x",
            "file:///C:/x",
            "https:///",
            "www.example.com",
        ] {
            assert!(link_url(link).is_none(), "{link}");
        }
    }
}
