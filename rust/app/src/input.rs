//! Text editing adapted from GPUI 0.2.2 examples/input.rs (Apache-2.0; see vendor/gpui/LICENSE-APACHE).
use std::ops::Range;

use gpui::{
    App, Bounds, ClipboardItem, Context, CursorStyle, ElementId, ElementInputHandler, Entity,
    EntityInputHandler, FocusHandle, Focusable, GlobalElementId, KeyBinding, LayoutId, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, PaintQuad, Pixels, Point, Render, ShapedLine,
    SharedString, Style, TextRun, UTF16Selection, UnderlineStyle, Window, actions, div, fill, hsla,
    point, prelude::*, px, relative, rgba, size,
};
use unicode_segmentation::*;

/// An emote drawn in place of its name, with its width over height.
pub type InlineEmotes = std::collections::HashMap<String, (std::sync::Arc<gpui::RenderImage>, f32)>;

/// Em spaces stand in for an emote in the shaped line: each is one font size
/// wide, so the caret and selection still come from GPUI's text layout.
const EM_SPACE: char = '\u{2003}';

/// One stretch of the composer as drawn: text as typed, or an emote shown as
/// an image over a run of em spaces.
#[derive(Clone)]
struct Segment {
    content: Range<usize>,
    display: Range<usize>,
    emote: Option<std::sync::Arc<gpui::RenderImage>>,
}

/// The text to shape, and how it maps back to what was typed.
fn display_segments(content: &str, emotes: &InlineEmotes, font_size: f32, height: f32) -> (String, Vec<Segment>) {
    let mut display = String::with_capacity(content.len());
    let mut segments = Vec::new();
    for (start, word) in content.split_word_bound_indices() {
        let range = start..start + word.len();
        let from = display.len();
        match emotes.get(word) {
            Some((image, ratio)) if !word.trim().is_empty() => {
                let spaces = ((height * ratio) / font_size.max(1.)).round().clamp(1., 8.) as usize;
                display.extend(std::iter::repeat_n(EM_SPACE, spaces));
                segments.push(Segment { content: range, display: from..display.len(), emote: Some(image.clone()) });
            }
            _ => {
                display.push_str(word);
                segments.push(Segment { content: range, display: from..display.len(), emote: None });
            }
        }
    }
    (display, segments)
}

fn to_display(segments: &[Segment], index: usize) -> usize {
    for segment in segments {
        if index >= segment.content.start && index <= segment.content.end {
            return match segment.emote {
                Some(_) if index == segment.content.start => segment.display.start,
                Some(_) => segment.display.end,
                None => segment.display.start + (index - segment.content.start),
            };
        }
    }
    segments.last().map_or(index, |segment| segment.display.end)
}

fn to_content(segments: &[Segment], index: usize) -> usize {
    for segment in segments {
        if index >= segment.display.start && index <= segment.display.end {
            return match segment.emote {
                Some(_) if index - segment.display.start <= (segment.display.end - index) => segment.content.start,
                Some(_) => segment.content.end,
                None => segment.content.start + (index - segment.display.start),
            };
        }
    }
    segments.last().map_or(index, |segment| segment.content.end)
}

fn utf16_to_utf8(text: &str, offset: usize) -> usize {
    let (mut bytes, mut units) = (0, 0);
    for ch in text.chars() {
        if units >= offset {
            break;
        }
        units += ch.len_utf16();
        bytes += ch.len_utf8();
    }
    bytes
}

fn inserted_text(content: &str, range: &Range<usize>, text: &str) -> String {
    let remaining = 500usize.saturating_sub(
        content[..range.start].chars().count() + content[range.end..].chars().count(),
    );
    text.chars()
        .filter(|c| !c.is_control())
        .take(remaining)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_composition_offsets_stay_on_character_boundaries() {
        let text = "a👋界";
        assert_eq!(utf16_to_utf8(text, 1), 1);
        assert_eq!(utf16_to_utf8(text, 3), 5);
        assert_eq!(utf16_to_utf8(text, usize::MAX), text.len());
        assert!(text.is_char_boundary(utf16_to_utf8(text, 2)));
    }
    #[test]
    fn replacement_frees_capacity_and_paste_is_single_line() {
        let content = "界".repeat(500);
        assert_eq!(inserted_text(&content, &(0..3), "👋x"), "👋");
        assert!(inserted_text(&content, &(0..0), "x").is_empty());
        assert_eq!(inserted_text("", &(0..0), "hello\r\nworld\0"), "helloworld");
    }
}

actions!(
    text_input,
    [
        Backspace,
        Delete,
        Left,
        Right,
        SelectLeft,
        SelectRight,
        SelectAll,
        Home,
        End,
        ShowCharacterPalette,
        Paste,
        Cut,
        Copy,
        Submit,
        Complete,
        SuggestUp,
        SuggestDown,
    ]
);

/// Keys the chat composer hands to its owner for name and emote completion.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ComposerKey {
    Tab,
    Up,
    Down,
}
impl gpui::EventEmitter<ComposerKey> for TextInput {}

pub struct Submitted;
impl gpui::EventEmitter<Submitted> for TextInput {}
pub struct TextInput {
    composer: bool,
    focus_handle: FocusHandle,
    pub content: SharedString,
    placeholder: SharedString,
    selected_range: Range<usize>,
    selection_reversed: bool,
    marked_range: Option<Range<usize>>,
    last_layout: Option<ShapedLine>,
    last_segments: Vec<Segment>,
    last_bounds: Option<Bounds<Pixels>>,
    /// Emotes shown inline (the chat composer); empty elsewhere.
    emotes: InlineEmotes,
    scroll_x: Pixels,
    is_selecting: bool,
}

impl TextInput {
    pub fn new(placeholder: &str, cx: &mut Context<Self>) -> Self {
        Self {
            composer: false,
            focus_handle: cx.focus_handle(),
            content: "".into(),
            placeholder: placeholder.to_owned().into(),
            selected_range: 0..0,
            selection_reversed: false,
            marked_range: None,
            last_layout: None,
            last_segments: Vec::new(),
            last_bounds: None,
            emotes: InlineEmotes::new(),
            scroll_x: px(0.),
            is_selecting: false,
        }
    }
    pub fn composer(cx: &mut Context<Self>) -> Self {
        let mut input = Self::new("Send a message", cx);
        input.composer = true;
        input
    }
    /// The emotes to draw inline, keyed by name. Only words of the current
    /// text need to be present.
    pub fn set_emotes(&mut self, emotes: InlineEmotes, cx: &mut Context<Self>) {
        let same = emotes.len() == self.emotes.len()
            && emotes.iter().all(|(name, (image, _))| {
                self.emotes.get(name).is_some_and(|(kept, _)| std::sync::Arc::ptr_eq(kept, image))
            });
        if !same {
            self.emotes = emotes;
            cx.notify();
        }
    }

    /// Where the caret is (the end of any selection).
    pub fn caret(&self) -> usize {
        self.selected_range.end
    }

    /// Replaces `range` with `text` and puts the caret after it.
    pub fn replace(&mut self, range: Range<usize>, text: &str, cx: &mut Context<Self>) {
        if range.start > range.end
            || range.end > self.content.len()
            || !self.content.is_char_boundary(range.start)
            || !self.content.is_char_boundary(range.end)
        {
            return;
        }
        let text = inserted_text(&self.content, &range, text);
        self.content = (self.content[..range.start].to_owned() + &text + &self.content[range.end..]).into();
        let caret = range.start + text.len();
        self.selected_range = caret..caret;
        self.marked_range = None;
        cx.notify();
    }

    fn complete(&mut self, _: &Complete, _: &mut Window, cx: &mut Context<Self>) {
        if self.composer {
            cx.emit(ComposerKey::Tab);
        }
    }
    fn suggest_up(&mut self, _: &SuggestUp, _: &mut Window, cx: &mut Context<Self>) {
        if self.composer {
            cx.emit(ComposerKey::Up);
        }
    }
    fn suggest_down(&mut self, _: &SuggestDown, _: &mut Window, cx: &mut Context<Self>) {
        if self.composer {
            cx.emit(ComposerKey::Down);
        }
    }

    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.content = "".into();
        self.selected_range = 0..0;
        self.marked_range = None;
        cx.notify();
    }
    pub fn append(&mut self, text: &str, cx: &mut Context<Self>) {
        let range = self.selected_range.clone();
        let text = inserted_text(&self.content, &range, text);
        self.content =
            (self.content[..range.start].to_owned() + &text + &self.content[range.end..]).into();
        self.selected_range = range.start + text.len()..range.start + text.len();
        self.marked_range = None;
        cx.notify();
    }
    fn submit(&mut self, _: &Submit, _: &mut Window, cx: &mut Context<Self>) {
        if self.marked_range.is_none() {
            cx.emit(Submitted);
        }
    }

    fn left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.move_to(self.previous_boundary(self.cursor_offset()), cx);
        } else {
            self.move_to(self.selected_range.start, cx)
        }
    }

    fn right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.move_to(self.next_boundary(self.selected_range.end), cx);
        } else {
            self.move_to(self.selected_range.end, cx)
        }
    }

    fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.previous_boundary(self.cursor_offset()), cx);
    }

    fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.next_boundary(self.cursor_offset()), cx);
    }

    fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
        self.select_to(self.content.len(), cx)
    }

    fn home(&mut self, _: &Home, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
    }

    fn end(&mut self, _: &End, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.content.len(), cx);
    }

    fn backspace(&mut self, _: &Backspace, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.select_to(self.previous_boundary(self.cursor_offset()), cx)
        }
        self.replace_text_in_range(None, "", window, cx)
    }

    fn delete(&mut self, _: &Delete, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.select_to(self.next_boundary(self.cursor_offset()), cx)
        }
        self.replace_text_in_range(None, "", window, cx)
    }

    fn on_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus_handle);
        self.is_selecting = true;

        if event.modifiers.shift {
            self.select_to(self.index_for_mouse_position(event.position), cx);
        } else {
            self.move_to(self.index_for_mouse_position(event.position), cx)
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _window: &mut Window, _: &mut Context<Self>) {
        self.is_selecting = false;
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.is_selecting {
            self.select_to(self.index_for_mouse_position(event.position), cx);
        }
    }

    fn show_character_palette(
        &mut self,
        _: &ShowCharacterPalette,
        window: &mut Window,
        _: &mut Context<Self>,
    ) {
        window.show_character_palette();
    }

    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.replace_text_in_range(None, &text.replace("\n", " "), window, cx);
        }
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_string(),
            ));
        }
    }
    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_string(),
            ));
            self.replace_text_in_range(None, "", window, cx)
        }
    }

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        self.selected_range = offset..offset;
        cx.notify()
    }

    fn cursor_offset(&self) -> usize {
        if self.selection_reversed {
            self.selected_range.start
        } else {
            self.selected_range.end
        }
    }

    fn index_for_mouse_position(&self, position: Point<Pixels>) -> usize {
        if self.content.is_empty() {
            return 0;
        }

        let (Some(bounds), Some(line)) = (self.last_bounds.as_ref(), self.last_layout.as_ref())
        else {
            return 0;
        };
        if position.y < bounds.top() {
            return 0;
        }
        if position.y > bounds.bottom() {
            return self.content.len();
        }
        to_content(
            &self.last_segments,
            line.closest_index_for_x(position.x - bounds.left() + self.scroll_x),
        )
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        if self.selection_reversed {
            self.selected_range.start = offset
        } else {
            self.selected_range.end = offset
        };
        if self.selected_range.end < self.selected_range.start {
            self.selection_reversed = !self.selection_reversed;
            self.selected_range = self.selected_range.end..self.selected_range.start;
        }
        cx.notify()
    }

    fn offset_from_utf16(&self, offset: usize) -> usize {
        utf16_to_utf8(&self.content, offset)
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        let mut utf16_offset = 0;
        let mut utf8_count = 0;

        for ch in self.content.chars() {
            if utf8_count >= offset {
                break;
            }
            utf8_count += ch.len_utf8();
            utf16_offset += ch.len_utf16();
        }

        utf16_offset
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end)
    }

    fn range_from_utf16(&self, range_utf16: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(range_utf16.start)..self.offset_from_utf16(range_utf16.end)
    }

    fn previous_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .rev()
            .find_map(|(idx, _)| (idx < offset).then_some(idx))
            .unwrap_or(0)
    }

    fn next_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .find_map(|(idx, _)| (idx > offset).then_some(idx))
            .unwrap_or(self.content.len())
    }
}

impl EntityInputHandler for TextInput {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        actual_range.replace(self.range_to_utf16(&range));
        Some(self.content[range].to_string())
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.range_to_utf16(&self.selected_range),
            reversed: self.selection_reversed,
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        self.marked_range
            .as_ref()
            .map(|range| self.range_to_utf16(range))
    }

    fn unmark_text(&mut self, _window: &mut Window, _cx: &mut Context<Self>) {
        self.marked_range = None;
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|range_utf16| self.range_from_utf16(range_utf16))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());

        let new_text = inserted_text(&self.content, &range, new_text);
        self.content =
            (self.content[..range.start].to_owned() + &new_text + &self.content[range.end..])
                .into();
        self.selected_range = range.start + new_text.len()..range.start + new_text.len();
        self.marked_range.take();
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|range_utf16| self.range_from_utf16(range_utf16))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());

        let new_text = inserted_text(&self.content, &range, new_text);
        self.content =
            (self.content[..range.start].to_owned() + &new_text + &self.content[range.end..])
                .into();
        if !new_text.is_empty() {
            self.marked_range = Some(range.start..range.start + new_text.len());
        } else {
            self.marked_range = None;
        }
        self.selected_range = new_selected_range_utf16
            .as_ref()
            .map(|selected| {
                let start = utf16_to_utf8(&new_text, selected.start);
                let end = utf16_to_utf8(&new_text, selected.end).max(start);
                range.start + start..range.start + end
            })
            .unwrap_or_else(|| range.start + new_text.len()..range.start + new_text.len());

        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let last_layout = self.last_layout.as_ref()?;
        let range = self.range_from_utf16(&range_utf16);
        let (start, end) = (
            to_display(&self.last_segments, range.start),
            to_display(&self.last_segments, range.end),
        );
        Some(Bounds::from_corners(
            point(bounds.left() + last_layout.x_for_index(start) - self.scroll_x, bounds.top()),
            point(bounds.left() + last_layout.x_for_index(end) - self.scroll_x, bounds.bottom()),
        ))
    }

    fn character_index_for_point(
        &mut self,
        point: gpui::Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        self.last_bounds?.localize(&point)?;
        let last_layout = self.last_layout.as_ref()?;

        let utf8_index = to_content(
            &self.last_segments,
            last_layout.index_for_x(point.x - self.last_bounds?.left() + self.scroll_x)?,
        );
        Some(self.offset_to_utf16(utf8_index))
    }
}

struct TextElement {
    input: Entity<TextInput>,
}

struct PrepaintState {
    line: Option<ShapedLine>,
    segments: Vec<Segment>,
    cursor: Option<PaintQuad>,
    selection: Option<PaintQuad>,
    scroll_x: Pixels,
}

impl IntoElement for TextElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for TextElement {
    type RequestLayoutState = ();
    type PrepaintState = PrepaintState;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = window.line_height().into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let input = self.input.read(cx);
        let content = input.content.clone();
        let selected_range = input.selected_range.clone();
        let cursor = input.cursor_offset();
        let style = window.text_style();

        let font_size = style.font_size.to_pixels(window.rem_size());
        let (display_text, text_color, segments) = if content.is_empty() {
            (input.placeholder.clone(), hsla(0., 0., 0.65, 1.), Vec::new())
        } else if input.marked_range.is_some() || input.emotes.is_empty() {
            let segments = vec![Segment { content: 0..content.len(), display: 0..content.len(), emote: None }];
            (content, style.color, segments)
        } else {
            let (display, segments) = display_segments(
                &content,
                &input.emotes,
                f32::from(font_size),
                f32::from(bounds.size.height),
            );
            (display.into(), style.color, segments)
        };
        let cursor = to_display(&segments, cursor);
        let selected_range = to_display(&segments, selected_range.start)..to_display(&segments, selected_range.end);

        let run = TextRun {
            len: display_text.len(),
            font: style.font(),
            color: text_color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let runs = if let Some(marked_range) = input.marked_range.as_ref() {
            vec![
                TextRun {
                    len: marked_range.start,
                    ..run.clone()
                },
                TextRun {
                    len: marked_range.end - marked_range.start,
                    underline: Some(UnderlineStyle {
                        color: Some(run.color),
                        thickness: px(1.0),
                        wavy: false,
                    }),
                    ..run.clone()
                },
                TextRun {
                    len: display_text.len() - marked_range.end,
                    ..run
                },
            ]
            .into_iter()
            .filter(|run| run.len > 0)
            .collect()
        } else {
            vec![run]
        };

        let line = window
            .text_system()
            .shape_line(display_text, font_size, &runs, None);

        let cursor_pos = line.x_for_index(cursor);
        let mut scroll_x = input.scroll_x;
        if cursor_pos < scroll_x {
            scroll_x = cursor_pos;
        }
        if cursor_pos - scroll_x > bounds.size.width - px(6.) {
            scroll_x = (cursor_pos - bounds.size.width + px(6.)).max(px(0.));
        }
        let cursor_pos = cursor_pos - scroll_x;
        let (selection, cursor) = if selected_range.is_empty() {
            (
                None,
                Some(fill(
                    Bounds::new(
                        point(bounds.left() + cursor_pos, bounds.top()),
                        size(px(2.), bounds.bottom() - bounds.top()),
                    ),
                    crate::theme::violet(),
                )),
            )
        } else {
            (
                Some(fill(
                    Bounds::from_corners(
                        point(
                            bounds.left() + line.x_for_index(selected_range.start) - scroll_x,
                            bounds.top(),
                        ),
                        point(
                            bounds.left() + line.x_for_index(selected_range.end) - scroll_x,
                            bounds.bottom(),
                        ),
                    ),
                    rgba(0x3311ff30),
                )),
                None,
            )
        };
        PrepaintState {
            line: Some(line),
            segments,
            cursor,
            selection,
            scroll_x,
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus_handle = self.input.read(cx).focus_handle.clone();
        window.handle_input(
            &focus_handle,
            ElementInputHandler::new(bounds, self.input.clone()),
            cx,
        );
        if let Some(selection) = prepaint.selection.take() {
            window.paint_quad(selection)
        }
        let line = prepaint.line.take().unwrap();
        line.paint(
            point(bounds.left() - prepaint.scroll_x, bounds.top()),
            window.line_height(),
            window,
            cx,
        )
        .unwrap();
        // Emotes over the spaces reserved for them, kept inside the field.
        let segments = std::mem::take(&mut prepaint.segments);
        window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
            for segment in &segments {
                let Some(image) = segment.emote.clone() else { continue };
                let left = bounds.left() + line.x_for_index(segment.display.start) - prepaint.scroll_x;
                let right = bounds.left() + line.x_for_index(segment.display.end) - prepaint.scroll_x;
                let height = bounds.size.height;
                let _ = window.paint_image(
                    Bounds::new(point(left, bounds.top()), size(right - left, height)),
                    gpui::Corners::default(),
                    image,
                    0,
                    false,
                );
            }
        });

        if focus_handle.is_focused(window)
            && let Some(cursor) = prepaint.cursor.take()
        {
            window.paint_quad(cursor);
        }

        self.input.update(cx, |input, _cx| {
            input.scroll_x = prepaint.scroll_x;
            input.last_layout = Some(line);
            input.last_segments = segments;
            input.last_bounds = Some(bounds);
        });
    }
}

impl Render for TextInput {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .items_center()
            .w_full()
            .px_2()
            .when(self.composer, |v| v.pr(px(42.)))
            .h(px(if self.composer { 43. } else { 38. }))
            .rounded(px(8.))
            .border_1()
            .when(self.composer, |v| v.border_2())
            .border_color(if self.focus_handle.is_focused(window) {
                crate::theme::violet()
            } else if self.composer {
                gpui::rgb(0x45454d)
            } else {
                crate::theme::input_border()
            })
            .overflow_hidden()
            .key_context("TextInput")
            .track_focus(&self.focus_handle(cx))
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::submit))
            .on_action(cx.listener(Self::complete))
            .on_action(cx.listener(Self::suggest_up))
            .on_action(cx.listener(Self::suggest_down))
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::show_character_palette))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::copy))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .bg(if self.composer {
                crate::theme::surface()
            } else {
                crate::theme::input()
            })
            .line_height(px(30.))
            .text_size(px(if self.composer { 13. } else { 14. }))
            .when(!self.composer, |v| {
                v.child(
                    div()
                        .mr_2()
                        .text_color(crate::theme::text_dim())
                        .child(crate::ui::icon(crate::ui::Icon::Search, 16.)),
                )
            })
            .child(
                div()
                    .h(px(30.))
                    .min_w_0()
                    .flex_1()
                    .child(TextElement { input: cx.entity() }),
            )
    }
}

impl Focusable for TextInput {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("backspace", Backspace, Some("TextInput")),
        KeyBinding::new("delete", Delete, Some("TextInput")),
        KeyBinding::new("left", Left, Some("TextInput")),
        KeyBinding::new("right", Right, Some("TextInput")),
        KeyBinding::new("shift-left", SelectLeft, Some("TextInput")),
        KeyBinding::new("shift-right", SelectRight, Some("TextInput")),
        KeyBinding::new("ctrl-a", SelectAll, Some("TextInput")),
        KeyBinding::new("ctrl-v", Paste, Some("TextInput")),
        KeyBinding::new("ctrl-c", Copy, Some("TextInput")),
        KeyBinding::new("ctrl-x", Cut, Some("TextInput")),
        KeyBinding::new("home", Home, Some("TextInput")),
        KeyBinding::new("end", End, Some("TextInput")),
        KeyBinding::new("enter", Submit, Some("TextInput")),
        KeyBinding::new("tab", Complete, Some("TextInput")),
        KeyBinding::new("up", SuggestUp, Some("TextInput")),
        KeyBinding::new("down", SuggestDown, Some("TextInput")),
    ]);
}

#[cfg(test)]
mod emote_tests {
    use super::*;

    #[test]
    fn emotes_map_between_typed_and_drawn_text() {
        let image = std::sync::Arc::new(gpui::RenderImage::new(vec![image::Frame::new(
            image::RgbaImage::new(2, 2),
        )]));
        let emotes = InlineEmotes::from([("Kappa".to_owned(), (image, 1.0))]);
        let (display, segments) = display_segments("hi Kappa x", &emotes, 14., 28.);
        // Kappa becomes two em spaces (28 px wide at a 14 px font).
        assert_eq!(display, format!("hi {0}{0} x", EM_SPACE));
        // A caret after "Kappa" sits after its spaces, and maps back.
        let after = to_display(&segments, 8);
        assert_eq!(after, 3 + EM_SPACE.len_utf8() * 2);
        assert_eq!(to_content(&segments, after), 8);
        // Inside the emote snaps to an edge; text maps one to one.
        assert_eq!(to_content(&segments, 3 + EM_SPACE.len_utf8()), 3);
        assert_eq!(to_content(&segments, 1), 1);
        assert_eq!(to_display(&segments, 10), display.len());
    }
}
