import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type ClipboardEvent,
  type FormEvent,
} from "react";
import type { ProviderEmote } from "../../shared/emotes";
import type { TwitchPickerEmote } from "../../shared/chat";

interface ChatComposerInputProps {
  "aria-label": string;
  disabled?: boolean;
  maxLength: number;
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

function readEditorText(editor: HTMLElement): string {
  const readNode = (node: Node): string => {
    if (node instanceof HTMLImageElement) return node.dataset.emoteName ?? "";
    if (node instanceof HTMLBRElement) return "\n";
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    return [...node.childNodes].map(readNode).join("");
  };
  return [...editor.childNodes].map(readNode).join("");
}

function placeCaretAtEnd(editor: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export const ChatComposerInput = forwardRef<HTMLDivElement, ChatComposerInputProps>(
  function ChatComposerInput(
    {
      "aria-label": ariaLabel,
      disabled = false,
      maxLength,
      onValueChange,
      placeholder,
      sevenTvEmotes,
      twitchEmotes,
      value,
    },
    forwardedRef,
  ) {
    const localRef = useRef<HTMLDivElement | null>(null);
    const emoteImages = useMemo(() => {
      const images = new Map<string, EmoteImage>();
      for (const emote of twitchEmotes) {
        images.set(emote.name, { imageUrl: emote.imageUrl, provider: "Twitch" });
      }
      for (const emote of sevenTvEmotes.values()) {
        const variant =
          emote.variants.find((item) => item.scale === 2) ?? emote.variants.at(-1);
        if (variant) images.set(emote.name, { imageUrl: variant.url, provider: "7TV" });
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
      (editor: HTMLDivElement, nextValue: string) => {
        editor.replaceChildren();
        for (const token of nextValue.split(/(\s+)/)) {
          const emote = emoteImages.get(token);
          if (!emote) {
            editor.append(document.createTextNode(token));
            continue;
          }
          const image = document.createElement("img");
          image.alt = token;
          image.className = "composer-emote";
          image.dataset.emoteName = token;
          image.draggable = false;
          image.src = emote.imageUrl;
          image.title = `${token} · ${emote.provider}`;
          editor.append(image);
        }
        placeCaretAtEnd(editor);
      },
      [emoteImages],
    );

    useLayoutEffect(() => {
      const editor = localRef.current;
      if (!editor || readEditorText(editor) === value) return;
      renderValue(editor, value);
    }, [renderValue, value]);

    function updateValue(convertEmotes = false): void {
      const editor = localRef.current;
      if (!editor) return;
      const nextValue = readEditorText(editor).slice(0, maxLength);
      onValueChange(nextValue);
      if (convertEmotes) renderValue(editor, nextValue);
    }

    function handlePaste(event: ClipboardEvent<HTMLDivElement>): void {
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain");
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
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
      </div>
    );
  },
);
