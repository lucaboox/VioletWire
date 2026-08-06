import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
} from "react";
import type { ProviderEmote } from "../../shared/emotes";
import type { TwitchPickerEmote } from "../../shared/chat";
import type { ChatMentionCandidate } from "../../shared/chat-content";
import { matchEmoteNames, type EmoteMatchMode } from "./emote-autocomplete";

interface ChatComposerInputProps {
  "aria-label": string;
  disabled?: boolean;
  /** Whether a typed word must start the emote name or may appear anywhere. */
  emoteMatch?: EmoteMatchMode;
  /** What Tab does to the highlighted name while @-mentioning someone. */
  mentionTab?: "complete" | "cycle";
  maxLength: number;
  mentionCandidates: ChatMentionCandidate[];
  onValueChange(value: string): void;
  placeholder: string;
  sevenTvEmotes: Map<string, ProviderEmote>;
  twitchEmotes: TwitchPickerEmote[];
  value: string;
}

interface EmoteImage {
  imageUrl: string;
  provider: string;
}

interface EmoteSuggestion extends EmoteImage {
  name: string;
}


function readEditorText(editor: HTMLElement): string {
  const readNode = (node: Node): string => {
    // Not `instanceof`: that compares against this window's constructors, and
    // an emote built in the chat window is not one of them — every emote would
    // read as empty, which is what sending and copying saw.
    if (node.nodeType === 1 /* Node.ELEMENT_NODE */) {
      const element = node as HTMLElement;
      if (element.tagName === "IMG") return element.dataset.emoteName ?? "";
      if (element.tagName === "BR") return "\n";
    }
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    return [...node.childNodes].map(readNode).join("");
  };
  return [...editor.childNodes].map(readNode).join("");
}

function placeCaretAtEnd(editor: HTMLElement): void {
  const root = editor.ownerDocument;
  const range = root.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  // The selection belongs to the window the editor is in; this window's is a
  // different one entirely, and empty.
  const selection = root.defaultView?.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * Puts the caret back where it was, counted in the same characters
 * `readEditorText` reads — an emote counts as the length of its name, so an
 * offset taken before the contents were rebuilt still means the same place
 * after a name has become an image.
 */
function placeCaretAtTextOffset(editor: HTMLElement, offset: number): void {
  const root = editor.ownerDocument;
  const range = root.createRange();
  let remaining = offset;

  const walk = (node: Node): boolean => {
    if (node.nodeType === 3 /* Node.TEXT_NODE */) {
      const length = (node.textContent ?? "").length;
      if (remaining <= length) {
        range.setStart(node, remaining);
        return true;
      }
      remaining -= length;
      return false;
    }
    if (node.nodeType === 1 /* Node.ELEMENT_NODE */) {
      const element = node as HTMLElement;
      if (element.tagName === "IMG") {
        // Nothing sits inside an emote, so a caret landing within its name
        // belongs against whichever edge it is nearer.
        const length = (element.dataset.emoteName ?? "").length;
        if (remaining < length) {
          range.setStartBefore(element);
          return true;
        }
        if (remaining === length) {
          range.setStartAfter(element);
          return true;
        }
        remaining -= length;
        return false;
      }
      if (element.tagName === "BR") {
        if (remaining < 1) {
          range.setStartBefore(element);
          return true;
        }
        remaining -= 1;
        return false;
      }
    }
    for (const child of [...node.childNodes]) if (walk(child)) return true;
    return false;
  };

  let placed = false;
  for (const child of [...editor.childNodes]) {
    if (walk(child)) {
      placed = true;
      break;
    }
  }
  if (placed) range.collapse(true);
  else {
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  const selection = root.defaultView?.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

interface ActiveMention {
  end: number;
  query: string;
  start: number;
}

function getCaretTextOffset(editor: HTMLElement): number | null {
  const root = editor.ownerDocument;
  const selection = root.defaultView?.getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.focusNode)) return null;
  const range = root.createRange();
  range.selectNodeContents(editor);
  range.setEnd(selection.focusNode!, selection.focusOffset);
  const fragment = root.createElement("div");
  fragment.append(range.cloneContents());
  return readEditorText(fragment).length;
}

function findActiveMention(text: string, caretOffset: number | null): ActiveMention | null {
  if (caretOffset === null) return null;
  const beforeCaret = text.slice(0, caretOffset);
  const match = /(?:^|\s)@([a-zA-Z0-9_]*)$/.exec(beforeCaret);
  if (!match) return null;
  const query = match[1];
  return {
    start: caretOffset - query.length - 1,
    end: caretOffset,
    query,
  };
}

function findActiveEmote(text: string, caretOffset: number | null): ActiveMention | null {
  if (caretOffset === null) return null;
  const beforeCaret = text.slice(0, caretOffset);
  const match = /(?:^|\s)([a-zA-Z0-9_][a-zA-Z0-9_:-]+)$/.exec(beforeCaret);
  if (!match) return null;
  return {
    start: caretOffset - match[1].length,
    end: caretOffset,
    query: match[1],
  };
}

export const ChatComposerInput = forwardRef<HTMLDivElement, ChatComposerInputProps>(
  function ChatComposerInput(
    {
      "aria-label": ariaLabel,
      disabled = false,
      emoteMatch = "prefix",
      mentionTab = "complete",
      maxLength,
      mentionCandidates,
      onValueChange,
      placeholder,
      sevenTvEmotes,
      twitchEmotes,
      value,
    },
    forwardedRef,
  ) {
    const localRef = useRef<HTMLDivElement | null>(null);
    // Where a completion left the caret, for the render it causes.
    const pendingCaret = useRef<number | undefined>(undefined);
    const [activeMention, setActiveMention] = useState<ActiveMention | null>(null);
    const [selectedMention, setSelectedMention] = useState(0);
    const [activeEmote, setActiveEmote] = useState<ActiveMention | null>(null);
    const [emoteCompletion, setEmoteCompletion] = useState<ActiveMention | null>(null);
    const [selectedEmote, setSelectedEmote] = useState(0);
    // Keeps the highlighted suggestion in view as the arrow keys move it.
    const selectedEmoteRef = useRef<HTMLButtonElement | null>(null);
    useLayoutEffect(() => {
      selectedEmoteRef.current?.scrollIntoView({ block: "nearest" });
    }, [selectedEmote]);
    const emoteImages = useMemo(() => {
      const images = new Map<string, EmoteImage>();
      for (const emote of twitchEmotes) {
        images.set(emote.name, { imageUrl: emote.imageUrl, provider: "Twitch" });
      }
      for (const emote of sevenTvEmotes.values()) {
        if (emote.modifier) continue;
        const variant =
          emote.variants.find((item) => item.scale === 2) ?? emote.variants.at(-1);
        const provider =
          emote.provider === "7tv"
            ? "7TV"
            : emote.provider === "ffz"
              ? "FrankerFaceZ"
              : "BetterTTV";
        if (variant) images.set(emote.name, { imageUrl: variant.url, provider });
      }
      return images;
    }, [sevenTvEmotes, twitchEmotes]);

    const setEditorRef = useCallback(
      (editor: HTMLDivElement | null) => {
        localRef.current = editor;
        if (typeof forwardedRef === "function") forwardedRef(editor);
        else if (forwardedRef) forwardedRef.current = editor;
      },
      [forwardedRef],
    );

    const renderValue = useCallback(
      (editor: HTMLDivElement, nextValue: string, caretOffset?: number) => {
        const root = editor.ownerDocument;
        // Rebuilding the contents destroys the caret, and typing a space is
        // what turns a finished name into an emote — so editing anything but
        // the end of a line would otherwise throw the caret to the end of it.
        //
        // Where it was is only the right answer while the box still holds what
        // the caret was measured against. A completion replaces a word before
        // the box is told, so it says where the caret belongs itself.
        const caret = caretOffset ?? getCaretTextOffset(editor);
        editor.replaceChildren();
        for (const token of nextValue.split(/(\s+)/)) {
          const emote = emoteImages.get(token);
          if (!emote) {
            editor.append(root.createTextNode(token));
            continue;
          }
          const image = root.createElement("img");
          image.alt = token;
          image.className = "composer-emote";
          image.dataset.emoteName = token;
          image.draggable = false;
          image.src = emote.imageUrl;
          image.title = `${token} · ${emote.provider}`;
          editor.append(image);
        }
        if (caret === null) placeCaretAtEnd(editor);
        else placeCaretAtTextOffset(editor, caret);
      },
      [emoteImages],
    );

    useLayoutEffect(() => {
      const editor = localRef.current;
      if (!editor || readEditorText(editor) === value) return;
      const completedCaret = pendingCaret.current;
      pendingCaret.current = undefined;
      renderValue(editor, value, completedCaret);
      setActiveMention(null);
      setActiveEmote(null);
      if (emoteCompletion) {
        // The completed word must still relate to what was typed, or the
        // completion is stale. Substring matching completes to names that do not
        // begin with the query, so the test follows the same rule.
        const completed = value
          .slice(emoteCompletion.start, emoteCompletion.end)
          .toLowerCase();
        const query = emoteCompletion.query.toLowerCase();
        const stillMatches =
          emoteMatch === "substring"
            ? completed.includes(query)
            : completed.startsWith(query);
        if (!stillMatches) setEmoteCompletion(null);
      }
    }, [emoteCompletion, emoteMatch, renderValue, value]);

    function updateValue(convertEmotes = false): void {
      const editor = localRef.current;
      if (!editor) return;
      const nextValue = readEditorText(editor).slice(0, maxLength);
      const caretOffset = getCaretTextOffset(editor);
      const mention = findActiveMention(nextValue, caretOffset);
      onValueChange(nextValue);
      setActiveMention(mention);
      setActiveEmote(mention ? null : findActiveEmote(nextValue, caretOffset));
      setEmoteCompletion(null);
      setSelectedMention(0);
      setSelectedEmote(0);
      if (convertEmotes) renderValue(editor, nextValue);
    }

    const matchingMentions = useMemo(() => {
      if (!activeMention) return [];
      const query = activeMention.query.toLowerCase();
      return mentionCandidates
        .filter(
          ({ displayName, login }) =>
            !query ||
            login.toLowerCase().startsWith(query) ||
            displayName.toLowerCase().startsWith(query),
        )
        .slice(0, 8);
    }, [activeMention, mentionCandidates]);

    function insertMention(candidate: ChatMentionCandidate): void {
      const editor = localRef.current;
      if (!editor || !activeMention) return;
      const currentValue = readEditorText(editor);
      const completed = `@${candidate.login} `;
      const nextValue = `${currentValue.slice(0, activeMention.start)}${completed}${currentValue.slice(activeMention.end)}`;
      pendingCaret.current = activeMention.start + completed.length;
      setActiveMention(null);
      onValueChange(nextValue.slice(0, maxLength));
    }

    const emoteMatchTarget = emoteCompletion ?? activeEmote;
    const matchingEmotes = useMemo(() => {
      if (!emoteMatchTarget) return [];
      return matchEmoteNames(emoteImages.keys(), emoteMatchTarget.query, emoteMatch)
        .slice(0, 100)
        .flatMap((name): EmoteSuggestion[] => {
          const emote = emoteImages.get(name);
          return emote ? [{ ...emote, name }] : [];
        });
    }, [emoteImages, emoteMatch, emoteMatchTarget]);
    const visibleEmoteStart = Math.floor(selectedEmote / 5) * 5;
    const visibleEmotes = matchingEmotes.slice(visibleEmoteStart, visibleEmoteStart + 5);

    function insertEmote(candidate: EmoteSuggestion): void {
      const editor = localRef.current;
      if (!editor || !activeEmote) return;
      const currentValue = readEditorText(editor);
      const completed = `${candidate.name} `;
      const nextValue = `${currentValue.slice(0, activeEmote.start)}${completed}${currentValue.slice(activeEmote.end)}`;
      pendingCaret.current = activeEmote.start + completed.length;
      setActiveEmote(null);
      setEmoteCompletion(null);
      onValueChange(nextValue.slice(0, maxLength));
    }

    function cycleEmoteCompletion(): void {
      const editor = localRef.current;
      const target = emoteCompletion ?? activeEmote;
      if (!editor || !target || matchingEmotes.length === 0) return;

      // The first Tab takes whatever the list has highlighted (arrow keys move
      // it); afterwards Tab steps through the matches from there.
      const nextIndex = emoteCompletion
        ? (selectedEmote + 1) % matchingEmotes.length
        : Math.min(selectedEmote, matchingEmotes.length - 1);
      const candidate = matchingEmotes[nextIndex];
      const currentValue = readEditorText(editor);
      const nextValue = `${currentValue.slice(0, target.start)}${candidate.name}${currentValue.slice(target.end)}`;
      pendingCaret.current = target.start + candidate.name.length;
      setSelectedEmote(nextIndex);
      setEmoteCompletion({
        start: target.start,
        end: target.start + candidate.name.length,
        query: target.query,
      });
      onValueChange(nextValue.slice(0, maxLength));
    }

    function moveEmoteSelection(direction: number): void {
      if (matchingEmotes.length === 0) return;
      setSelectedEmote(
        (current) => (current + direction + matchingEmotes.length) % matchingEmotes.length,
      );
    }

    function handlePaste(event: ClipboardEvent<HTMLDivElement>): void {
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain");
      const root = event.currentTarget.ownerDocument;
      const selection = root.defaultView?.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const node = root.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      updateValue(true);
    }

    return (
      <div className="emote-aware-input">
        <div
          aria-disabled={disabled}
          aria-label={ariaLabel}
          className="chat-composer-editor"
          contentEditable={!disabled}
          data-empty={!value}
          data-placeholder={placeholder}
          onBeforeInput={(event: FormEvent<HTMLDivElement>) => {
            const nativeEvent = event.nativeEvent as InputEvent;
            if (
              nativeEvent.inputType.startsWith("insert") &&
              readEditorText(event.currentTarget).length >= maxLength &&
              nativeEvent.inputType !== "insertFromPaste"
            ) {
              event.preventDefault();
            }
          }}
          onInput={(event) => {
            const nativeEvent = event.nativeEvent as InputEvent;
            updateValue(nativeEvent.data === " " || nativeEvent.inputType === "insertParagraph");
          }}
          onKeyDown={(event) => {
            if (activeMention && matchingMentions.length > 0) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const direction = event.key === "ArrowDown" ? 1 : -1;
                setSelectedMention(
                  (current) =>
                    (current + direction + matchingMentions.length) %
                    matchingMentions.length,
                );
                return;
              }
              // Enter takes the highlighted name rather than sending: the
              // list is open because a name is half typed, and sending it half
              // typed is never what was meant.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                insertMention(matchingMentions[selectedMention] ?? matchingMentions[0]);
                return;
              }
              if (event.key === "Tab") {
                event.preventDefault();
                if (mentionTab === "cycle") {
                  setSelectedMention(
                    (current) => (current + 1) % matchingMentions.length,
                  );
                  return;
                }
                insertMention(matchingMentions[selectedMention] ?? matchingMentions[0]);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setActiveMention(null);
                return;
              }
            }
            if (emoteCompletion && matchingEmotes.length > 0) {
              if (
                event.key === "ArrowRight" ||
                event.key === "ArrowDown" ||
                event.key === "ArrowLeft" ||
                event.key === "ArrowUp"
              ) {
                event.preventDefault();
                moveEmoteSelection(
                  event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1,
                );
                return;
              }
              if (event.key === "Tab") {
                event.preventDefault();
                cycleEmoteCompletion();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setActiveEmote(null);
                setEmoteCompletion(null);
                return;
              }
            }
            if (activeEmote && !emoteCompletion && matchingEmotes.length > 0) {
              // The suggestion list is open: arrows move the highlight, Tab
              // completes it, after which Tab cycles through the matches.
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                moveEmoteSelection(event.key === "ArrowDown" ? 1 : -1);
                return;
              }
              if (event.key === "Tab") {
                event.preventDefault();
                cycleEmoteCompletion();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setActiveEmote(null);
                return;
              }
            }
            if (event.key === "Tab") {
              // Keep keyboard focus inside chat. Without a completion match,
              // the browser would move focus to the emoji picker or another
              // composer control, which makes Tab feel unpredictable.
              event.preventDefault();
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.closest("form")?.requestSubmit();
            }
          }}
          onPaste={handlePaste}
          ref={setEditorRef}
          role="textbox"
          spellCheck
          suppressContentEditableWarning
        />
        {activeMention && matchingMentions.length > 0 && (
          <div className="mention-suggestions" role="listbox" aria-label="Chat usernames">
            {matchingMentions.map((candidate, index) => (
              <button
                aria-selected={index === selectedMention}
                className={index === selectedMention ? "selected" : ""}
                key={candidate.login}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => insertMention(candidate)}
                role="option"
                type="button"
              >
                <span
                  className="mention-suggestion-avatar"
                  style={{ backgroundColor: candidate.color || "#9147ff" }}
                >
                  {candidate.displayName.slice(0, 1).toUpperCase()}
                </span>
                <strong>{candidate.displayName}</strong>
                <small>@{candidate.login}</small>
              </button>
            ))}
          </div>
        )}
        {!activeMention && !emoteCompletion && activeEmote && matchingEmotes.length > 0 && (
          <div className="emote-suggestion-list" role="listbox" aria-label="Matching emotes">
            {matchingEmotes.map((emote, index) => (
              <button
                aria-selected={index === selectedEmote}
                className={index === selectedEmote ? "selected" : ""}
                key={`${emote.provider}-${emote.name}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertEmote(emote)}
                ref={index === selectedEmote ? selectedEmoteRef : undefined}
                role="option"
                type="button"
              >
                <img alt="" src={emote.imageUrl} />
                <strong>{emote.name}</strong>
                <small>{emote.provider}</small>
              </button>
            ))}
          </div>
        )}
        {!activeMention && emoteCompletion && matchingEmotes.length > 0 && (
          <div className="emote-suggestions" role="listbox" aria-label="Matching emotes">
            <button
              aria-label="Previous matching emote"
              className="emote-suggestion-step"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => moveEmoteSelection(-1)}
              type="button"
            >
              ‹
            </button>
            <div className="emote-suggestion-results">
              {visibleEmotes.map((emote, index) => {
                const absoluteIndex = visibleEmoteStart + index;
                return (
                  <button
                    aria-label={`${emote.name}, ${emote.provider}`}
                    aria-selected={absoluteIndex === selectedEmote}
                    className={absoluteIndex === selectedEmote ? "selected" : ""}
                    key={`${emote.provider}-${emote.name}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insertEmote(emote)}
                    role="option"
                    title={`${emote.name} · ${emote.provider}`}
                    type="button"
                  >
                    <img alt="" src={emote.imageUrl} />
                    <span>{emote.name}</span>
                  </button>
                );
              })}
            </div>
            <button
              aria-label="Next matching emote"
              className="emote-suggestion-step"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => moveEmoteSelection(1)}
              type="button"
            >
              ›
            </button>
          </div>
        )}
      </div>
    );
  },
);
