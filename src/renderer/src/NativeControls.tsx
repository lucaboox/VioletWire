import {
  Fragment,
  memo,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  AudioLines,
  ChevronLeft,
  ChevronRight,
  Check,
  Layers,
  Maximize,
  MessageSquare,
  Minimize,
  PanelRight,
  Pause,
  Play,
  Reply,
  SlidersHorizontal,
  Settings,
  Smile,
  Tv,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type {
  NativeControlsContext,
  NativePlayerState,
  NativeQuality,
  NativeQualityValue,
} from "../../shared/player";
import {
  formatChatTimestamp,
  messageMentionsLogin,
  type ChatBadgeAsset,
  type ChatMessage,
  type TwitchPickerEmote,
} from "../../shared/chat";
import type { ProviderEmote } from "../../shared/emotes";
import type { AppPreferences } from "../../shared/preferences";
import { applyChatMessage } from "../../shared/chat-messages";
import { readableUsernameColor } from "../../shared/chat-color";
import { ChatComposerInput } from "./ChatComposerInput";
import { EmotePicker } from "./EmotePicker";

const initialState: NativePlayerState = {
  status: "idle",
  paused: false,
  muted: false,
  volume: 100,
  compressorEnabled: false,
  behindLive: false,
  quality: "best",
};

function renderOverlayText(
  message: ChatMessage,
  sevenTvEmotes: Map<string, ProviderEmote>,
): ReactNode[] {
  const twitchRanges = [...message.twitchEmotes].sort((left, right) => left.start - right.start);
  const output: ReactNode[] = [];
  let cursor = 0;
  const appendText = (text: string, key: string) => {
    output.push(
      ...text.split(/(\s+)/).map((token, index) => {
        const emote = sevenTvEmotes.get(token);
        const variant = emote?.variants.find((item) => item.scale === 2) ?? emote?.variants.at(-1);
        return variant ? (
          <img
            alt={emote?.name ?? token}
            className="native-overlay-emote"
            key={`${key}-${index}`}
            loading="lazy"
            src={variant.url}
            title={`${emote?.name ?? token} · 7TV`}
          />
        ) : token;
      }),
    );
  };
  twitchRanges.forEach((range, index) => {
    if (range.start > cursor) appendText(message.text.slice(cursor, range.start), `${message.id}-${index}`);
    const name = message.text.slice(range.start, range.end + 1);
    output.push(
      <img
        alt={name}
        className="native-overlay-emote"
        key={`${message.id}-twitch-${index}`}
        loading="lazy"
        src={`https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(range.id)}/default/dark/2.0`}
        title={`${name} · Twitch`}
      />,
    );
    cursor = range.end + 1;
  });
  if (cursor < message.text.length) appendText(message.text.slice(cursor), `${message.id}-tail`);
  return output;
}

interface OverlayChatMessageRowProps {
  message: ChatMessage;
  showTimestamp: boolean;
  badges: Map<string, ChatBadgeAsset>;
  oledMode: boolean;
  mentioned: boolean;
  deletedRevealed: boolean;
  onRevealDeleted: (id: string) => void;
  onReply: (message: ChatMessage) => void;
  sevenTvEmotes: Map<string, ProviderEmote>;
}

// Memoized so a new chat message only renders its own row instead of
// re-rendering (and re-tokenizing emotes for) every message in the overlay.
const OverlayChatMessageRow = memo(function OverlayChatMessageRow({
  message,
  showTimestamp,
  badges,
  oledMode,
  mentioned,
  deletedRevealed,
  onRevealDeleted,
  onReply,
  sevenTvEmotes,
}: OverlayChatMessageRowProps) {
  return (
    <div
      className={
        mentioned ? "native-video-chat-message mentioned" : "native-video-chat-message"
      }
    >
      {message.reply && (
        <span className="native-chat-reply-parent" title={message.reply.parentMessageBody}>
          Replying to {message.reply.parentDisplayName || message.reply.parentUserLogin}:{" "}
          {message.reply.parentMessageBody}
        </span>
      )}
      {showTimestamp && (
        <time
          className="native-chat-timestamp"
          dateTime={new Date(message.sentAt).toISOString()}
        >
          {formatChatTimestamp(message.sentAt)}
        </time>
      )}
      {message.badges.length > 0 && (
        <span className="native-video-chat-badges">
          {message.badges.slice(0, 4).map((badgeKey) => {
            const badge = badges.get(badgeKey);
            return badge ? (
              <img alt={badge.title} key={badgeKey} src={badge.imageUrl} />
            ) : null;
          })}
        </span>
      )}
      <strong
        style={{
          color: readableUsernameColor(
            message.color,
            oledMode ? "#000000" : "#18181b",
          ),
        }}
      >
        {message.displayName}
      </strong>
      <span>: </span>
      {message.deleted && !deletedRevealed ? (
        <button
          className="deleted-message-toggle"
          onClick={() => onRevealDeleted(message.id)}
          title="Show the deleted message locally"
          type="button"
        >
          &lt;deleted&gt;
        </button>
      ) : (
        renderOverlayText(message, sevenTvEmotes)
      )}
      {!message.deleted && (
        <button
          aria-label={`Reply to ${message.displayName}`}
          className="native-chat-message-reply"
          onClick={() => onReply(message)}
          title={`Reply to ${message.displayName}`}
          type="button"
        >
          <Reply size={13} />
        </button>
      )}
    </div>
  );
});

export function NativeControls() {
  const [context, setContext] = useState<NativeControlsContext | null>(null);
  const [state, setState] = useState<NativePlayerState>(initialState);
  const [qualities, setQualities] = useState<NativeQuality[]>([
    { value: "best", label: "Auto" },
  ]);
  const [openMenu, setOpenMenu] = useState<"quality" | "chat" | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [chatOpacity, setChatOpacity] = useState(() => {
    const stored = Number(window.localStorage.getItem("glint.chat.overlayOpacity"));
    return Number.isFinite(stored) && stored >= 25 && stored <= 100 ? stored : 88;
  });
  const [chatSettingsOpen, setChatSettingsOpen] = useState(false);
  const [chatTimestamps, setChatTimestamps] = useState(
    () => window.localStorage.getItem("glint.chat.timestamps") !== "false",
  );
  const [chatHistoryLimit, setChatHistoryLimit] = useState(() => {
    const stored = Number(window.localStorage.getItem("glint.chat.historyLimit"));
    return Number.isInteger(stored) && stored >= 20 && stored <= 100 ? stored : 20;
  });
  const [mentionSoundEnabled, setMentionSoundEnabled] = useState(false);
  const [revealedDeletedMessages, setRevealedDeletedMessages] = useState<Set<string>>(
    new Set(),
  );
  const [chatAutoScroll, setChatAutoScroll] = useState(true);
  const [oledMode, setOledMode] = useState(
    () => window.localStorage.getItem("glint.appearance.oled") === "true",
  );
  const [audioCompressionPreference, setAudioCompressionPreference] = useState(
    () => window.localStorage.getItem("glint.playback.audioCompression") === "true",
  );
  const [preferencesReady, setPreferencesReady] = useState(false);
  const legacyPreferences = useRef({
    chatTimestamps,
    chatHistoryLimit,
    chatOverlayOpacity: chatOpacity,
    mentionSoundEnabled,
    oledMode,
    audioCompression: audioCompressionPreference,
  });
  const [chatBadges, setChatBadges] = useState<Map<string, ChatBadgeAsset>>(new Map());
  const [twitchPickerEmotes, setTwitchPickerEmotes] = useState<TwitchPickerEmote[]>([]);
  const [sevenTvEmotes, setSevenTvEmotes] = useState<Map<string, ProviderEmote>>(new Map());
  const [sevenTvChannelEmoteNames, setSevenTvChannelEmoteNames] = useState<Set<string>>(new Set());
  const [emotePickerOpen, setEmotePickerOpen] = useState(false);
  const [detachedEmotePickerOpen, setDetachedEmotePickerOpen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const activityTimer = useRef<number | null>(null);
  const lastPointerPosition = useRef<{ x: number; y: number } | null>(null);
  const chatMessagesHost = useRef<HTMLDivElement>(null);
  const chatInputHost = useRef<HTMLDivElement>(null);
  const chatComposerHost = useRef<HTMLFormElement>(null);
  const detachedPickerHost = useRef<HTMLDivElement>(null);
  const currentChannel = useRef<string | null>(null);
  const channel = context?.channel;

  useEffect(() => window.desktop.player.onNativeState(setState), []);

  // Report the detached picker's real rectangle so the main process can make
  // exactly that area of this transparent window clickable, instead of a
  // fixed-size region whose invisible edges swallow clicks meant for the
  // chat behind it.
  useEffect(() => {
    if (!detachedEmotePickerOpen) return;
    const picker = detachedPickerHost.current?.querySelector<HTMLElement>(".vw-emote-picker");
    if (!picker) return;
    const reportPickerBounds = () => {
      const bounds = picker.getBoundingClientRect();
      if (bounds.width < 1 || bounds.height < 1) return;
      window.desktop.player.setNativeEmotePickerBounds({
        x: Math.max(0, Math.round(bounds.x)),
        y: Math.max(0, Math.round(bounds.y)),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    };
    const observer = new ResizeObserver(reportPickerBounds);
    observer.observe(picker);
    // The picker is anchored right/bottom, so window resizes move it without
    // resizing it; ResizeObserver alone would miss those.
    window.addEventListener("resize", reportPickerBounds);
    reportPickerBounds();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reportPickerBounds);
      window.desktop.player.setNativeEmotePickerBounds(null);
    };
  }, [detachedEmotePickerOpen, channel]);
  useEffect(
    () => window.desktop.player.onNativeControlsVisibility(setControlsVisible),
    [],
  );
  useEffect(
    () => window.desktop.player.onNativeEmotePicker(setDetachedEmotePickerOpen),
    [],
  );
  useEffect(
    () =>
      window.desktop.player.onNativeControlsContext((nextContext) => {
        if (currentChannel.current !== nextContext.channel) {
          currentChannel.current = nextContext.channel;
          setChatMessages([]);
          setRevealedDeletedMessages(new Set());
          setChatAutoScroll(true);
          setReplyingTo(null);
        }
        setContext(nextContext);
      }),
    [],
  );
  useEffect(() => {
    if (!channel) return;
    window.desktop.player.controlNative({
      command: "set-compressor",
      enabled: audioCompressionPreference,
    });
  }, [audioCompressionPreference, channel]);
  useEffect(() => window.desktop.player.readyNativeControls(), []);
  useEffect(() => {
    let disposed = false;
    const applyPreferences = (preferences: AppPreferences) => {
      if (disposed) return;
      setChatOpacity(preferences.chatOverlayOpacity);
      setChatTimestamps(preferences.chatTimestamps);
      setChatHistoryLimit(preferences.chatHistoryLimit);
      setMentionSoundEnabled(preferences.mentionSoundEnabled);
      setOledMode(preferences.oledMode);
      setAudioCompressionPreference(preferences.audioCompression);
      setPreferencesReady(true);
    };
    const removeListener = window.desktop.preferences.onChanged(applyPreferences);
    void window.desktop.preferences
      .getOrMigrate(legacyPreferences.current)
      .then(applyPreferences)
      .catch(() => undefined);
    return () => {
      disposed = true;
      removeListener();
    };
  }, []);
  useEffect(
    () => () => window.desktop.player.setNativeControlsExpanded(false),
    [],
  );

  useEffect(() => {
    if (!preferencesReady) return;
    window.desktop.chat.setHistoryLimit(chatHistoryLimit);
    void window.desktop.preferences
      .update({
        chatOverlayOpacity: chatOpacity,
        chatTimestamps,
        chatHistoryLimit,
        mentionSoundEnabled,
        audioCompression: audioCompressionPreference,
      })
      .catch(() => undefined);
  }, [
    audioCompressionPreference,
    chatHistoryLimit,
    chatOpacity,
    chatTimestamps,
    mentionSoundEnabled,
    preferencesReady,
  ]);

  useEffect(
    () =>
      window.desktop.chat.onMessage((message) => {
        if (message.deleted) {
          setRevealedDeletedMessages((revealed) => {
            const next = new Set(revealed);
            next.delete(message.id);
            return next;
          });
        }
        setChatMessages((current) => applyChatMessage(current, message));
      }),
    [],
  );

  useLayoutEffect(() => {
    const host = chatMessagesHost.current;
    if (host && chatAutoScroll) host.scrollTop = host.scrollHeight;
  }, [chatAutoScroll, chatMessages]);

  useEffect(() => {
    const input = chatInputHost.current;
    if (!input) return;
    input.style.height = "0px";
    const nextHeight = Math.min(Math.max(input.scrollHeight, 43), 130);
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > 130 ? "auto" : "hidden";
  }, [chatInput]);

  useEffect(() => {
    if (!channel) return;
    let cancelled = false;
    void Promise.allSettled([
      window.desktop.chat.getAssets(channel),
      window.desktop.emotes.getSevenTvGlobal(),
    ]).then(async ([assetsResult, globalResult]) => {
      if (cancelled) return;
      if (assetsResult.status === "fulfilled") {
        setChatBadges(new Map(assetsResult.value.badges.map((badge) => [badge.key, badge])));
        setTwitchPickerEmotes(assetsResult.value.emotes);
      }
      const combined = new Map<string, ProviderEmote>();
      const channelNames = new Set<string>();
      if (assetsResult.status === "fulfilled") {
        const channelResult = await window.desktop.emotes
          .getSevenTvChannel(assetsResult.value.broadcasterId)
          .catch(() => null);
        if (channelResult) {
          for (const emote of channelResult.emotes) {
            combined.set(emote.name, emote);
            channelNames.add(emote.name);
          }
        }
      }
      if (globalResult.status === "fulfilled") {
        for (const emote of globalResult.value.emotes) {
          if (!combined.has(emote.name)) combined.set(emote.name, emote);
        }
      }
      if (!cancelled) {
        setSevenTvEmotes(combined);
        setSevenTvChannelEmoteNames(channelNames);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [channel]);


  const nativeChatOverlay = Boolean(
    context?.chatVisible && context.chatPresentation === "overlay",
  );

  useEffect(() => {
    const composer = chatComposerHost.current;
    const chat = composer?.closest<HTMLElement>(".native-video-chat");
    if (!composer || !chat) return;
    const syncComposerSpace = () => {
      chat.style.setProperty(
        "--chat-composer-space",
        `${Math.ceil(composer.getBoundingClientRect().height) + 8}px`,
      );
    };
    const observer = new ResizeObserver(syncComposerSpace);
    observer.observe(composer);
    syncComposerSpace();
    return () => observer.disconnect();
  }, [nativeChatOverlay]);

  const revealDeletedMessage = useCallback((id: string) => {
    setRevealedDeletedMessages((revealed) => {
      const next = new Set(revealed);
      next.add(id);
      return next;
    });
  }, []);

  const beginReply = useCallback((message: ChatMessage) => {
    setReplyingTo(message);
    window.requestAnimationFrame(() => chatInputHost.current?.focus());
  }, []);

  function handleChatScroll() {
    const host = chatMessagesHost.current;
    if (!host) return;
    setChatAutoScroll(host.scrollHeight - host.scrollTop - host.clientHeight < 36);
  }

  function scrollChatToCurrent() {
    const host = chatMessagesHost.current;
    if (!host) return;
    host.scrollTo({ top: host.scrollHeight, behavior: "smooth" });
    setChatAutoScroll(true);
  }

  function revealChatComposer() {
    if (!chatAutoScroll) return;
    window.requestAnimationFrame(() => {
      const host = chatMessagesHost.current;
      if (host) host.scrollTop = host.scrollHeight;
    });
  }

  async function sendChatMessage(event: FormEvent) {
    event.preventDefault();
    if (!channel || !chatInput.trim()) return;
    const message = chatInput.trim();
    const replyTarget = replyingTo;
    setChatInput("");
    setReplyingTo(null);
    try {
      await window.desktop.chat.send(channel, message, replyTarget?.id);
    } catch {
      setChatInput(message);
      setReplyingTo(replyTarget);
    }
  }

  useEffect(() => {
    if (!openMenu) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenMenu(null);
      window.desktop.player.setNativeControlsExpanded(false);
      window.desktop.player.sendNativeControlAction("activity");
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [openMenu]);

  useEffect(() => {
    if (!channel) return;
    let cancelled = false;
    void window.desktop.player.getNativeQualities(channel).then((items) => {
      if (!cancelled) setQualities(items);
    });
    return () => {
      cancelled = true;
    };
  }, [channel]);

  function reportActivity() {
    if (activityTimer.current !== null) return;
    window.desktop.player.sendNativeControlAction("activity");
    activityTimer.current = window.setTimeout(() => {
      activityTimer.current = null;
    }, 180);
  }

  function reportPointerActivity(event: { clientX: number; clientY: number }) {
    const previous = lastPointerPosition.current;
    if (previous?.x === event.clientX && previous.y === event.clientY) return;
    lastPointerPosition.current = { x: event.clientX, y: event.clientY };
    reportActivity();
  }

  function closeMenu() {
    setOpenMenu(null);
    window.desktop.player.setNativeControlsExpanded(false);
    reportActivity();
  }

  function toggleMenu(menu: "quality" | "chat") {
    const nextMenu = openMenu === menu ? null : menu;
    setOpenMenu(nextMenu);
    window.desktop.player.setNativeControlsExpanded(nextMenu !== null);
    reportActivity();
  }

  async function selectQuality(quality: NativeQualityValue) {
    closeMenu();
    if (!context || quality === state.quality) return;
    try {
      await window.desktop.player.setNativeQuality(context.channel, quality);
    } catch {
      // The native player state carries the actionable playback error.
    }
  }

  function goLive() {
    if (!channel || !state.behindLive) return;
    closeMenu();
    window.desktop.player.controlNative({ command: "go-live" });
  }

  function selectChatLayout(action: "hide-chat" | "side-chat" | "overlay-chat") {
    closeMenu();
    window.desktop.player.sendNativeControlAction(action);
  }

  if (!context) return null;

  const qualityLabel =
    qualities.find((quality) => quality.value === state.quality)?.label ?? state.quality;
  const viewerLogin = context.viewerLogin ?? "";
  const chatHistoryBoundary = chatMessages.reduce(
    (lastIndex, message, index) => (message.historical ? index : lastIndex),
    -1,
  );
  const chatIcon = !context.chatVisible ? (
    <MessageSquare size={18} />
  ) : context.chatPresentation === "overlay" ? (
    <Layers size={18} />
  ) : (
    <PanelRight size={18} />
  );

  return (
    <div
      className={[
        "controls-surface",
        oledMode ? "oled-mode" : "",
        !context.chatVisible ? "chat-hidden" : "",
        !controlsVisible ? "controls-hidden" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeMenu();
      }}
      onPointerMove={reportPointerActivity}
    >
      {detachedEmotePickerOpen && channel && (
        <div className="native-detached-emote-picker" ref={detachedPickerHost}>
          <EmotePicker
            channelName={channel}
            onClose={() => window.desktop.player.setNativeEmotePicker(false)}
            onSelect={(name) => window.desktop.player.sendNativeEmoteSelection(name)}
            sevenTvChannelEmoteNames={sevenTvChannelEmoteNames}
            sevenTvEmotes={sevenTvEmotes}
            twitchEmotes={twitchPickerEmotes}
          />
        </div>
      )}
      <div className="controls-gradient" />
      {!context.chatVisible && (
        <button
          aria-label="Show stream chat"
          className="native-chat-edge-restore"
          onClick={() => selectChatLayout("side-chat")}
          title="Show stream chat"
          type="button"
        >
          <ChevronLeft size={16} />
        </button>
      )}
      {nativeChatOverlay && (
        <aside
          className="native-video-chat"
          onMouseEnter={revealChatComposer}
          style={{
            backgroundColor: oledMode
              ? `rgb(0 0 0 / ${chatOpacity}%)`
              : `rgb(24 24 27 / ${chatOpacity}%)`,
          }}
        >
          <div className="native-video-chat-tools">
            <button
              aria-label="Hide chat overlay"
              onClick={() => selectChatLayout("hide-chat")}
              title="Hide chat"
              type="button"
            >
              <ChevronRight size={17} />
            </button>
            <button
              aria-expanded={chatSettingsOpen}
              aria-label="Chat overlay settings"
              className={chatSettingsOpen ? "active" : ""}
              onClick={() => setChatSettingsOpen((current) => !current)}
              title="Chat overlay settings"
              type="button"
            >
              <Settings size={16} />
            </button>
            {chatSettingsOpen && (
              <div className="native-video-chat-settings">
                <strong>Chat settings</strong>
                <label>
                  <span>{chatOpacity}%</span>
                  <input
                    aria-label="Chat overlay opacity"
                    max="100"
                    min="25"
                    onChange={(event) => setChatOpacity(Number(event.target.value))}
                    type="range"
                    value={chatOpacity}
                  />
                </label>
                <label className="native-chat-toggle-setting">
                  <span>Show timestamps</span>
                  <input
                    checked={chatTimestamps}
                    onChange={(event) => setChatTimestamps(event.target.checked)}
                    type="checkbox"
                  />
                </label>
                <label className="native-chat-toggle-setting">
                  <span>Mention sound</span>
                  <input
                    checked={mentionSoundEnabled}
                    onChange={(event) => setMentionSoundEnabled(event.target.checked)}
                    type="checkbox"
                  />
                </label>
                <label>
                  <span>History: {chatHistoryLimit}</span>
                  <input
                    aria-label="Chat history message count"
                    max="100"
                    min="20"
                    onChange={(event) => setChatHistoryLimit(Number(event.target.value))}
                    step="10"
                    type="range"
                    value={chatHistoryLimit}
                  />
                </label>
              </div>
            )}
          </div>
          <div
            className={`native-video-chat-messages${
              chatAutoScroll ? "" : " scroll-paused"
            }`}
            onScroll={handleChatScroll}
            ref={chatMessagesHost}
          >
            {chatMessages.map((message, index) => (
              <Fragment key={message.id}>
              <OverlayChatMessageRow
                badges={chatBadges}
                deletedRevealed={revealedDeletedMessages.has(message.id)}
                mentioned={messageMentionsLogin(message, viewerLogin)}
                message={message}
                oledMode={oledMode}
                onRevealDeleted={revealDeletedMessage}
                onReply={beginReply}
                sevenTvEmotes={sevenTvEmotes}
                showTimestamp={chatTimestamps}
              />
              {index === chatHistoryBoundary && (
                <div className="live-chat-divider" role="separator">
                  <span>Live chat</span>
                </div>
              )}
              </Fragment>
            ))}
          </div>
          {!chatAutoScroll && (
            <button className="native-scroll-current" onClick={scrollChatToCurrent} type="button">
              Scroll to current
            </button>
          )}
          <form className="native-video-chat-input" onSubmit={sendChatMessage} ref={chatComposerHost}>
            {replyingTo && (
              <div className="native-chat-reply-composer">
                <span>
                  Replying to <strong>{replyingTo.displayName}</strong>
                </span>
                <button
                  aria-label="Cancel reply"
                  onClick={() => setReplyingTo(null)}
                  title="Cancel reply"
                  type="button"
                >
                  <X size={13} />
                </button>
              </div>
            )}
            <div className="native-chat-composer-box">
              <ChatComposerInput
                aria-label="Send a chat message"
                maxLength={500}
                onValueChange={setChatInput}
                placeholder="Send a message"
                ref={chatInputHost}
                sevenTvEmotes={sevenTvEmotes}
                twitchEmotes={twitchPickerEmotes}
                value={chatInput}
              />
              <div className="native-chat-composer-inline-actions">
                <div className="native-emote-picker-anchor">
                  <button
                    aria-expanded={emotePickerOpen}
                    aria-label="Choose Twitch and 7TV emotes"
                    className={emotePickerOpen ? "native-emote-button active" : "native-emote-button"}
                    onClick={() => setEmotePickerOpen((current) => !current)}
                    title="Twitch and 7TV emotes"
                    type="button"
                  >
                    <Smile size={17} />
                  </button>
                  {emotePickerOpen && (
                    <>
                      <EmotePicker
                        channelName={channel ?? "Channel"}
                        onClose={() => setEmotePickerOpen(false)}
                        onSelect={(name) =>
                          setChatInput((current) =>
                            `${current}${current && !current.endsWith(" ") ? " " : ""}${name} `,
                          )
                        }
                        sevenTvChannelEmoteNames={sevenTvChannelEmoteNames}
                        sevenTvEmotes={sevenTvEmotes}
                        twitchEmotes={twitchPickerEmotes}
                      />
                    {/*
                    <div className="native-emote-picker">
                  <input
                    aria-label="Search emotes"
                    autoFocus
                    onChange={(event) => setEmoteSearch(event.target.value)}
                    placeholder="Search Twitch and 7TV"
                    value={emoteSearch}
                  />
                  <div className="native-emote-tabs" role="tablist">
                    {[
                      { key: "twitch" as const, label: "Twitch", count: pickerEmoteGroups.twitch.length },
                      { key: "7tv" as const, label: "7TV", count: pickerEmoteGroups.sevenTv.length },
                    ].map((provider) => (
                      <button
                        aria-selected={emoteProvider === provider.key}
                        className={emoteProvider === provider.key ? "active" : ""}
                        key={provider.key}
                        onClick={() =>
                          setEmoteProvider((current) =>
                            current === provider.key ? null : provider.key,
                          )
                        }
                        role="tab"
                        type="button"
                      >
                        {provider.label}
                        <small>{provider.count}</small>
                      </button>
                    ))}
                  </div>
                  {searchedPickerEmotes ? (
                    <div className="native-emote-grid">
                      {searchedPickerEmotes.map((emote, index) => (
                        <button
                          aria-label={`${emote.name}, ${emote.provider}`}
                          className={`${emote.wide ? "wide" : ""}${emote.subscriptionOnly ? " subscription-only" : ""}`.trim()}
                          key={`${emote.provider}-${emote.name}`}
                          onClick={() => {
                            setChatInput((current) =>
                              `${current}${current && !current.endsWith(" ") ? " " : ""}${emote.name} `,
                            );
                            setEmotePickerOpen(false);
                          }}
                          title={`${emote.name} · ${emote.provider}${emote.subscriptionOnly ? " · Subscriber emote (may be locked)" : ""}`}
                          type="button"
                        >
                          <img
                            alt=""
                            decoding="async"
                            fetchPriority={index < 24 ? "high" : "auto"}
                            loading="eager"
                            src={emote.imageUrl}
                          />
                        </button>
                      ))}
                      {searchedPickerEmotes.length === 0 && (
                        <span className="native-emote-empty">No matching emotes</span>
                      )}
                    </div>
                  ) : emoteProvider ? (
                    <div className="native-emote-groups">
                      {[
                        {
                          label: emoteProvider === "twitch" ? "Channel emotes" : "Channel 7TV emotes",
                          note: emoteProvider === "twitch" ? "Subscriber emotes may be locked" : "Available in this channel",
                          emotes: emoteProvider === "twitch"
                            ? pickerEmoteGroups.twitchChannel
                            : pickerEmoteGroups.sevenTvChannel,
                        },
                        {
                          label: "Global emotes",
                          note: "Available everywhere",
                          emotes: emoteProvider === "twitch"
                            ? pickerEmoteGroups.twitchGlobal
                            : pickerEmoteGroups.sevenTvGlobal,
                        },
                      ].map((group) => (
                        <details key={group.label} open={group.emotes.length > 0}>
                          <summary title={group.note}>
                            <span>{group.label}</span>
                            <small>{group.emotes.length}</small>
                          </summary>
                          <div className="native-emote-grid">
                            {group.emotes.map((emote, index) => (
                              <button
                                aria-label={`${emote.name}, ${emote.provider}`}
                                className={`${emote.wide ? "wide" : ""}${emote.subscriptionOnly ? " subscription-only" : ""}`.trim()}
                                key={`${emote.provider}-${emote.name}`}
                                onClick={() => {
                                  setChatInput((current) =>
                                    `${current}${current && !current.endsWith(" ") ? " " : ""}${emote.name} `,
                                  );
                                  setEmotePickerOpen(false);
                                }}
                                title={`${emote.name} · ${emote.provider}${emote.subscriptionOnly ? " · Subscriber emote (may be locked)" : ""}`}
                                type="button"
                              >
                                <img
                                  alt=""
                                  decoding="async"
                                  fetchPriority={index < 24 ? "high" : "auto"}
                                  loading="eager"
                                  src={emote.imageUrl}
                                />
                              </button>
                            ))}
                          </div>
                        </details>
                      ))}
                    </div>
                  ) : null}
                    </div>
                    */}
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="native-chat-composer-footer">
              <span />
              <button
                className="native-chat-send-button"
                disabled={!chatInput.trim()}
                type="submit"
              >
                Chat
              </button>
            </div>
          </form>
        </aside>
      )}
      {openMenu === "quality" && (
        <div
          className={`control-popover quality-popover ${
            context.chatVisible && context.chatPresentation === "overlay" ? "avoid-chat" : ""
          }`}
          onPointerDown={(event) => event.stopPropagation()}
          role="menu"
        >
          <header>
            <strong>Stream quality</strong>
            <small>Changing quality briefly reconnects playback.</small>
          </header>
          <div className="popover-options">
            {qualities.map((quality) => (
              <button
                aria-checked={quality.value === state.quality}
                className={quality.value === state.quality ? "selected" : ""}
                key={quality.value}
                onClick={() => void selectQuality(quality.value)}
                role="menuitemradio"
                type="button"
              >
                <span>{quality.label}</span>
                {quality.value === state.quality && <Check size={15} />}
              </button>
            ))}
          </div>
        </div>
      )}
      {openMenu === "chat" && (
        <div
          className={`control-popover chat-popover ${
            context.chatVisible && context.chatPresentation === "overlay" ? "avoid-chat" : ""
          }`}
          onPointerDown={(event) => event.stopPropagation()}
          role="menu"
        >
          <header>
            <strong>Chat layout</strong>
            <small>Choose how chat appears beside the video.</small>
          </header>
          <div className="popover-options chat-options">
            <button
              className={!context.chatVisible ? "selected" : ""}
              onClick={() => selectChatLayout("hide-chat")}
              type="button"
            >
              <MessageSquare size={16} />
              <span><b>Hidden</b><small>Video only</small></span>
              {!context.chatVisible && <Check size={15} />}
            </button>
            <button
              className={
                context.chatVisible && context.chatPresentation === "side" ? "selected" : ""
              }
              onClick={() => selectChatLayout("side-chat")}
              type="button"
            >
              <PanelRight size={16} />
              <span><b>Side by side</b><small>Chat beside the video</small></span>
              {context.chatVisible && context.chatPresentation === "side" && <Check size={15} />}
            </button>
            <button
              className={
                context.chatVisible && context.chatPresentation === "overlay" ? "selected" : ""
              }
              onClick={() => selectChatLayout("overlay-chat")}
              type="button"
            >
              <Layers size={16} />
              <span><b>Overlay</b><small>Chat floats over the video</small></span>
              {context.chatVisible && context.chatPresentation === "overlay" && <Check size={15} />}
            </button>
          </div>
        </div>
      )}
      <div className="controls-bar" aria-label="Native player controls">
        <button
          aria-label={state.paused ? "Play" : "Pause"}
          data-tooltip={state.paused ? "Play (Space)" : "Pause (Space)"}
          onClick={() => window.desktop.player.controlNative({ command: "toggle-pause" })}
          type="button"
        >
          {state.paused ? <Play size={19} /> : <Pause size={19} />}
        </button>
        <button
          aria-label={state.muted ? "Unmute" : "Mute"}
          data-tooltip={state.muted ? "Unmute" : "Mute"}
          onClick={() => window.desktop.player.controlNative({ command: "toggle-mute" })}
          type="button"
        >
          {state.muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
        <input
          aria-label="Volume"
          max="100"
          min="0"
          onChange={(event) =>
            window.desktop.player.controlNative({
              command: "set-volume",
              value: Number(event.target.value),
            })
          }
          type="range"
          value={state.volume}
        />
        <span className="volume-label">{state.volume}%</span>
        <button
          aria-label={
            state.compressorEnabled ? "Disable audio compression" : "Enable audio compression"
          }
          aria-pressed={state.compressorEnabled}
          className={state.compressorEnabled ? "active" : ""}
          data-tooltip={
            state.compressorEnabled ? "Audio compression on" : "Audio compression off"
          }
          onClick={() => {
            const enabled = !state.compressorEnabled;
            setAudioCompressionPreference(enabled);
            window.desktop.player.controlNative({ command: "set-compressor", enabled });
          }}
          type="button"
        >
          <AudioLines size={18} />
        </button>
        <span className="control-spacer" />
        <button
          aria-label={state.behindLive ? "Go to live edge" : "At live edge"}
          className={`live-state ${state.status}${state.behindLive ? " behind-live" : ""}`}
          data-tooltip={state.behindLive ? "Go live" : undefined}
          onClick={goLive}
          type="button"
        >
          {state.behindLive ? "Go live" : state.status === "playing" ? "Live" : state.status}
        </button>
        <button
          aria-label={`Stream quality: ${qualityLabel}`}
          aria-expanded={openMenu === "quality"}
          className={`quality-button ${openMenu === "quality" ? "active" : ""}`}
          data-tooltip={openMenu === "quality" ? undefined : "Stream quality"}
          onClick={() => toggleMenu("quality")}
          type="button"
        >
          <SlidersHorizontal size={16} />
          <span>{qualityLabel}</span>
        </button>
        <button
          aria-label="Chat layout"
          aria-expanded={openMenu === "chat"}
          className={openMenu === "chat" ? "active" : ""}
          data-tooltip={openMenu === "chat" ? undefined : "Chat layout"}
          onClick={() => toggleMenu("chat")}
          type="button"
        >
          {chatIcon}
        </button>
        <button
          aria-label="Theater mode"
          aria-pressed={context.theaterMode}
          className={context.theaterMode ? "active" : ""}
          data-tooltip="Theater mode (T)"
          onClick={() => window.desktop.player.sendNativeControlAction("toggle-theater")}
          type="button"
        >
          <Tv size={18} />
        </button>
        <button
          aria-label={context.fullscreen ? "Exit fullscreen" : "Fullscreen"}
          aria-pressed={context.fullscreen}
          className={context.fullscreen ? "active" : ""}
          data-tooltip={context.fullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}
          onClick={() => window.desktop.player.sendNativeControlAction("toggle-fullscreen")}
          type="button"
        >
          {context.fullscreen ? <Minimize size={19} /> : <Maximize size={19} />}
        </button>
      </div>
    </div>
  );
}
