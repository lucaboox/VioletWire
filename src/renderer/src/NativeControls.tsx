import {
  Fragment,
  memo,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
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
  Star,
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
import type {
  EmoteProvider,
  EmoteSetResult,
  ProviderEmote,
} from "../../shared/emotes";
import type { AppPreferences } from "../../shared/preferences";
import { applyChatMessage } from "../../shared/chat-messages";
import { getChatMentionCandidates } from "../../shared/chat-content";
import { readableUsernameColor } from "../../shared/chat-color";
import { ChatComposerInput } from "./ChatComposerInput";
import { EmotePicker } from "./EmotePicker";
import { ChatEmote } from "./ChatEmote";
import { renderProviderText } from "./ProviderEmoteText";
import {
  captureChatScrollAnchor,
  restoreChatScrollAnchor,
  type ChatScrollAnchor,
} from "./chat-scroll";

const initialState: NativePlayerState = {
  status: "idle",
  paused: false,
  muted: false,
  volume: 100,
  compressorEnabled: false,
  behindLive: false,
  quality: "best",
};
const emoteProviders: EmoteProvider[] = ["7tv", "ffz", "bttv"];

function emptyProviderEmoteMaps(): Map<EmoteProvider, Map<string, ProviderEmote>> {
  return new Map(emoteProviders.map((provider) => [provider, new Map()]));
}

function emptyProviderChannelNames(): Map<EmoteProvider, Set<string>> {
  return new Map(emoteProviders.map((provider) => [provider, new Set()]));
}

function renderOverlayText(
  message: ChatMessage,
  sevenTvEmotes: Map<string, ProviderEmote>,
): ReactNode[] {
  const twitchRanges = [...message.twitchEmotes].sort((left, right) => left.start - right.start);
  const output: ReactNode[] = [];
  let cursor = 0;
  const appendText = (text: string, key: string) => {
    output.push(...renderProviderText(text, sevenTvEmotes, key, "native-overlay-emote"));
  };
  twitchRanges.forEach((range, index) => {
    if (range.start > cursor) appendText(message.text.slice(cursor, range.start), `${message.id}-${index}`);
    const name = message.text.slice(range.start, range.end + 1);
    output.push(
      <ChatEmote
        className="native-overlay-emote"
        imageUrl={`https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(range.id)}/default/dark/2.0`}
        key={`${message.id}-twitch-${index}`}
        name={name}
        provider="twitch"
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
  providerEmotes: Map<string, ProviderEmote>;
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
  providerEmotes,
}: OverlayChatMessageRowProps) {
  if (message.notice) {
    return (
      <div
        className="native-video-chat-message native-chat-notice"
        data-chat-message-id={message.id}
      >
        <div className="native-chat-notice-heading">
          <Star fill="currentColor" size={14} />
          <strong>{message.notice.systemMessage}</strong>
        </div>
        <div className="native-chat-notice-facts">
          {message.notice.tier && <span>{message.notice.tier}</span>}
          {message.notice.cumulativeMonths && (
            <span>{message.notice.cumulativeMonths} months</span>
          )}
          {message.notice.streakMonths && (
            <span>{message.notice.streakMonths} month streak</span>
          )}
          {message.notice.giftCount && <span>{message.notice.giftCount} gifts</span>}
        </div>
        {message.text && (
          <div className="native-chat-notice-text">
            <strong>{message.displayName}:</strong>{" "}
            {renderOverlayText(message, providerEmotes)}
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      className={
        mentioned ? "native-video-chat-message mentioned" : "native-video-chat-message"
      }
      data-chat-message-id={message.id}
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
        renderOverlayText(message, providerEmotes)
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
  const [chatFontSize, setChatFontSize] = useState(() => {
    const stored = Number(window.localStorage.getItem("glint.chat.fontSize"));
    return Number.isInteger(stored) && stored >= 14 && stored <= 25 ? stored : 14;
  });
  const [chatEmoteSize, setChatEmoteSize] = useState(() => {
    const stored = Number(window.localStorage.getItem("glint.chat.emoteSize"));
    return Number.isInteger(stored) && stored >= 18 && stored <= 48 ? stored : 27;
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
    chatFontSize,
    chatEmoteSize,
    chatOverlayOpacity: chatOpacity,
    mentionSoundEnabled,
    oledMode,
    audioCompression: audioCompressionPreference,
  });
  const [chatBadges, setChatBadges] = useState<Map<string, ChatBadgeAsset>>(new Map());
  const [twitchPickerEmotes, setTwitchPickerEmotes] = useState<TwitchPickerEmote[]>([]);
  const [providerEmoteMaps, setProviderEmoteMaps] = useState(emptyProviderEmoteMaps);
  const [providerChannelNames, setProviderChannelNames] = useState(
    emptyProviderChannelNames,
  );
  const [emotePickerOpen, setEmotePickerOpen] = useState(false);
  const [detachedEmotePickerOpen, setDetachedEmotePickerOpen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const activityTimer = useRef<number | null>(null);
  const lastPointerPosition = useRef<{ x: number; y: number } | null>(null);
  const chatMessagesHost = useRef<HTMLDivElement>(null);
  const chatScrollAnchor = useRef<ChatScrollAnchor | null>(null);
  const chatAutoScrollRef = useRef(true);
  const chatInputHost = useRef<HTMLDivElement>(null);
  const chatComposerHost = useRef<HTMLFormElement>(null);
  const detachedPickerHost = useRef<HTMLDivElement>(null);
  const currentChannel = useRef<string | null>(null);
  const channel = context?.channel;
  const chatProviderEmotes = useMemo(() => {
    const combined = new Map<string, ProviderEmote>();
    for (const provider of emoteProviders) {
      for (const emote of providerEmoteMaps.get(provider)?.values() ?? []) {
        if (!combined.has(emote.name)) combined.set(emote.name, emote);
      }
    }
    return combined;
  }, [providerEmoteMaps]);

  useEffect(() => {
    if (!emotePickerOpen && !detachedEmotePickerOpen && !chatSettingsOpen) return;
    const closeOpenChatMenus = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        emotePickerOpen &&
        !target.closest(".native-emote-picker-anchor")
      ) {
        setEmotePickerOpen(false);
      }
      if (
        detachedEmotePickerOpen &&
        !target.closest(".native-detached-emote-picker")
      ) {
        window.desktop.player.setNativeEmotePicker(false);
      }
      if (
        chatSettingsOpen &&
        !target.closest(".native-video-chat-tools")
      ) {
        setChatSettingsOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOpenChatMenus, true);
    return () => document.removeEventListener("pointerdown", closeOpenChatMenus, true);
  }, [chatSettingsOpen, detachedEmotePickerOpen, emotePickerOpen]);

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
          chatAutoScrollRef.current = true;
          chatScrollAnchor.current = null;
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
      setChatFontSize(preferences.chatFontSize);
      setChatEmoteSize(preferences.chatEmoteSize);
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
        chatFontSize,
        chatEmoteSize,
        mentionSoundEnabled,
        audioCompression: audioCompressionPreference,
      })
      .catch(() => undefined);
  }, [
    audioCompressionPreference,
    chatHistoryLimit,
    chatFontSize,
    chatEmoteSize,
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
        if (!chatAutoScrollRef.current && chatMessagesHost.current) {
          chatScrollAnchor.current = captureChatScrollAnchor(chatMessagesHost.current);
        }
        setChatMessages((current) => applyChatMessage(current, message));
      }),
    [],
  );

  useLayoutEffect(() => {
    const host = chatMessagesHost.current;
    if (!host) return;
    if (chatAutoScroll) {
      host.scrollTop = host.scrollHeight;
    } else if (chatScrollAnchor.current) {
      restoreChatScrollAnchor(host, chatScrollAnchor.current);
      chatScrollAnchor.current = null;
    }
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
      window.desktop.emotes.getFfzGlobal(),
      window.desktop.emotes.getBttvGlobal(),
    ]).then(async ([assetsResult, ...globalResults]) => {
      if (cancelled) return;
      if (assetsResult.status === "fulfilled") {
        setChatBadges(new Map(assetsResult.value.badges.map((badge) => [badge.key, badge])));
        setTwitchPickerEmotes(assetsResult.value.emotes);
      }
      const nextMaps = emptyProviderEmoteMaps();
      const nextChannelNames = emptyProviderChannelNames();
      const channelResults: PromiseSettledResult<EmoteSetResult>[] =
        assetsResult.status === "fulfilled"
          ? await Promise.allSettled([
              window.desktop.emotes.getSevenTvChannel(assetsResult.value.broadcasterId),
              window.desktop.emotes.getFfzChannel(assetsResult.value.broadcasterId),
              window.desktop.emotes.getBttvChannel(assetsResult.value.broadcasterId),
            ])
          : [];
      for (const result of channelResults) {
        if (result.status !== "fulfilled") continue;
        for (const emote of result.value.emotes) {
          nextMaps.get(result.value.provider)!.set(emote.name, emote);
          nextChannelNames.get(result.value.provider)!.add(emote.name);
        }
      }
      for (const result of globalResults) {
        if (result.status !== "fulfilled") continue;
        for (const emote of result.value.emotes) {
          const providerMap = nextMaps.get(result.value.provider)!;
          if (!providerMap.has(emote.name)) providerMap.set(emote.name, emote);
        }
      }
      if (!cancelled) {
        setProviderEmoteMaps(nextMaps);
        setProviderChannelNames(nextChannelNames);
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
    const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 36;
    chatAutoScrollRef.current = atBottom;
    setChatAutoScroll(atBottom);
  }

  function scrollChatToCurrent() {
    const host = chatMessagesHost.current;
    if (!host) return;
    host.scrollTo({ top: host.scrollHeight, behavior: "smooth" });
    chatAutoScrollRef.current = true;
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

  useEffect(() => {
    if (!context) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (openMenu || chatSettingsOpen || emotePickerOpen || detachedEmotePickerOpen) {
        return;
      }
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          'input, textarea, select, button, a, [contenteditable="true"], [role="textbox"], [role="menu"], [role="dialog"]',
        )
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "t") {
        window.desktop.player.sendNativeControlAction("toggle-theater");
      } else if (key === "c") {
        window.desktop.player.sendNativeControlAction(
          context.chatVisible ? "hide-chat" : "side-chat",
        );
      } else if (key === "f") {
        window.desktop.player.sendNativeControlAction("toggle-fullscreen");
      } else if (event.code === "Space") {
        event.preventDefault();
        window.desktop.player.controlNative({ command: "toggle-pause" });
      } else if (key === "m") {
        window.desktop.player.controlNative({ command: "toggle-mute" });
      } else if (event.key === "Escape" && context.fullscreen) {
        window.desktop.player.sendNativeControlAction("toggle-fullscreen");
      } else if (event.key === "Escape" && context.theaterMode) {
        window.desktop.player.sendNativeControlAction("toggle-theater");
      } else {
        return;
      }
      window.desktop.player.sendNativeControlAction("activity");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    chatSettingsOpen,
    context,
    detachedEmotePickerOpen,
    emotePickerOpen,
    openMenu,
  ]);

  if (!context) return null;

  const qualityLabel =
    qualities.find((quality) => quality.value === state.quality)?.label ?? state.quality;
  const viewerLogin = context.viewerLogin ?? "";
  const chatHistoryBoundary = chatMessages.reduce(
    (lastIndex, message, index) => (message.historical ? index : lastIndex),
    -1,
  );
  const chatMentionCandidates = getChatMentionCandidates(chatMessages, "", 100);
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
      style={{
        "--chat-font-size": `${chatFontSize}px`,
        "--chat-emote-size": `${chatEmoteSize}px`,
      } as CSSProperties}
    >
      {detachedEmotePickerOpen && channel && (
        <div className="native-detached-emote-picker" ref={detachedPickerHost}>
          <EmotePicker
            channelName={channel}
            onClose={() => window.desktop.player.setNativeEmotePicker(false)}
            onSelect={(name) => window.desktop.player.sendNativeEmoteSelection(name)}
            providerChannelEmoteNames={providerChannelNames}
            providerEmotes={providerEmoteMaps}
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
                  <span>Font size: {chatFontSize}px</span>
                  <input
                    aria-label="Chat font size"
                    max="25"
                    min="14"
                    onChange={(event) => setChatFontSize(Number(event.target.value))}
                    type="range"
                    value={chatFontSize}
                  />
                </label>
                <label>
                  <span>Emote size: {chatEmoteSize}px</span>
                  <input
                    aria-label="Chat emote size"
                    max="48"
                    min="18"
                    onChange={(event) => setChatEmoteSize(Number(event.target.value))}
                    type="range"
                    value={chatEmoteSize}
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
                providerEmotes={chatProviderEmotes}
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
                <div className="chat-reply-heading">
                  <span><Reply size={13} /> Replying to @{replyingTo.login}:</span>
                  <button
                    aria-label="Cancel reply"
                    onClick={() => setReplyingTo(null)}
                    title="Cancel reply"
                    type="button"
                  >
                    <X size={13} />
                  </button>
                </div>
                <div className="chat-reply-preview">
                  {replyingTo.badges.slice(0, 1).map((badgeKey) => {
                    const badge = chatBadges.get(badgeKey);
                    return badge ? (
                      <img alt={badge.title} key={badgeKey} src={badge.imageUrl} />
                    ) : null;
                  })}
                  <strong
                    style={{
                      color: readableUsernameColor(
                        replyingTo.color,
                        oledMode ? "#000000" : "#18181b",
                      ),
                    }}
                  >
                    {replyingTo.displayName}:
                  </strong>
                  <span>{replyingTo.text}</span>
                </div>
              </div>
            )}
            <div className="native-chat-composer-box">
              <ChatComposerInput
                aria-label="Send a chat message"
                maxLength={500}
                mentionCandidates={chatMentionCandidates}
                onValueChange={setChatInput}
                placeholder={replyingTo ? `@${replyingTo.login}` : "Send a message"}
                ref={chatInputHost}
                sevenTvEmotes={chatProviderEmotes}
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
                        providerChannelEmoteNames={providerChannelNames}
                        providerEmotes={providerEmoteMaps}
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
                {replyingTo ? "Reply" : "Chat"}
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
