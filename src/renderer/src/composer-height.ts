/** Matches the min-height and max-height the box is given in the stylesheet. */
const COMPOSER_MIN_HEIGHT = 43;
const COMPOSER_MAX_HEIGHT = 130;

/**
 * Sizes the message box to what it holds.
 *
 * An emote is taller than a line of text, so a message with one in it needs a
 * taller box than the same message as letters. Height that follows the text
 * alone is not enough: completing a name that was already typed in full changes
 * no text at all, and an emote's image can arrive well after the word it
 * replaced. Either leaves the box at its old height with the emote cropped by
 * the edge of it.
 */
export function fitComposerHeight(editor: HTMLElement | null): void {
  if (!editor) return;
  editor.style.height = "0px";
  // The box is measured to its border, but scrollHeight stops at the padding,
  // so the border has to be added back or the box comes up exactly that much
  // short — enough to shave the top off an emote.
  const border = editor.offsetHeight - editor.clientHeight;
  const needed = editor.scrollHeight + border;
  editor.style.height = `${Math.min(Math.max(needed, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT)}px`;
  editor.style.overflowY = needed > COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
}
