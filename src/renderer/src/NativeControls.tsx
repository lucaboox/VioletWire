import {
  Fragment,
  memo,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  AudioLines,
  ChevronLeft,
  ChevronRight,
  Check,
  Gauge,
  Lock,
  MessageSquareOff,
  MessageSquareText,
  Maximize,
  Minimize,
  MoveDiagonal2,
  Pause,
  PictureInPicture2,
  Play,
  Reply,
  SlidersHorizontal,
  Settings,
  Smile,
  Star,
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
  formatModerationAction,
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
import type { AppPreferences, MentionSoundId } from "../../shared/preferences";
import { filterChatMentionCandidates } from "../../shared/chat-content";
import { readableUsernameColor } from "../../shared/chat-color";
import { parseChannelKey } from "../../shared/platform";
import { ChatComposerInput } from "./ChatComposerInput";
import { NO_CHAT_RESTRICTIONS } from "../../shared/chat";
import type { ChatRestrictions } from "../../shared/chat";
import { EmotePicker } from "./EmotePicker";
import { ChatBadge } from "./ChatBadge";
import { ReplyThread } from "./ReplyThread";
import { ChatUserCard } from "./ChatUserCard";
import { ChatEmote } from "./ChatEmote";
import {
  ChatToggleSetting,
  MentionSoundControls,
  TwitchChatColorControls,
} from "./ChatSettingsControls";
import { withoutRedundantReplyMention } from "./chat-display";
import { renderProviderText } from "./ProviderEmoteText";
import { useChatFeed } from "./chat-feed";
import { ChatSendStatus } from "./ChatSendStatus";
import { useChatSendQueue } from "./use-chat-send-queue";

// The sidebar-layout pair, drawn here rather than pulled from another icon set
// so the app keeps a single icon dependency. Stroked to sit alongside lucide:
// same 24 grid, same 2px round strokes. Theater fills the panel, so the solid
// state marks the toggle being on rather than the chrome still being there.
function SidebarLayoutIcon({ filled, size = 18 }: { filled: boolean; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect height="18" rx="2" width="18" x="3" y="3" />
      <path d="M15 3v18" />
      {filled && <path d="M16 4h4v16h-4z" fill="currentColor" stroke="none" />}
    </svg>
  );
}

const initialState: NativePlayerState = {
  status: "idle",
  paused: false,
  muted: false,
  volume: 100,
  compressorEnabled: false,
  behindLive: false,
  quality: "best",
};

// The controls remount per channel, so their initial volume must already match
// the saved level — otherwise the slider visibly flashes 100% before the
// player state arrives. Warmed at startup and kept current on every change.
let cachedPlayerVolume = 100;
void window.desktop.preferences
  .getOrMigrate()
  .then((preferences) => {
    cachedPlayerVolume = preferences.playerVolume;
  })
  .catch(() => undefined);
const emoteProviders: EmoteProvider[] = ["7tv", "ffz", "bttv"];

interface OverlayGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface OverlayDragState {
  mode: "move" | "resize";
  pointerX: number;
  pointerY: number;
  // Container (video surface) bounds, captured at drag start.
  containerLeft: number;
  containerTop: number;
  containerWidth: number;
  containerHeight: number;
  // Geometry at drag start, in container-relative pixels.
  startLeft: number;
  startTop: number;
  startWidth: number;
  startHeight: number;
}

// Overlay chat size limits, in CSS pixels. Must match the preferences schema.
const OVERLAY_MIN_WIDTH = 280;
const OVERLAY_MAX_WIDTH = 560;
const OVERLAY_MIN_HEIGHT = 200;
const OVERLAY_MAX_HEIGHT = 1000;
const OVERLAY_MARGIN = 8;

function clampOverlayGeometry(
  geometry: OverlayGeometry,
  containerWidth: number,
  containerHeight: number,
): OverlayGeometry {
  const width = Math.round(
    Math.min(OVERLAY_MAX_WIDTH, Math.max(OVERLAY_MIN_WIDTH, geometry.width)),
  );
  const height = Math.round(
    Math.min(
      Math.min(OVERLAY_MAX_HEIGHT, Math.max(0, containerHeight - OVERLAY_MARGIN * 2)),
      Math.max(OVERLAY_MIN_HEIGHT, geometry.height),
    ),
  );
  const left = Math.round(
    Math.min(
      Math.max(OVERLAY_MARGIN, containerWidth - width - OVERLAY_MARGIN),
      Math.max(OVERLAY_MARGIN, geometry.left),
    ),
  );
  const top = Math.round(
    Math.min(
      Math.max(OVERLAY_MARGIN, containerHeight - height - OVERLAY_MARGIN),
      Math.max(OVERLAY_MARGIN, geometry.top),
    ),
  );
  return { left, top, width, height };
}

interface NativeControlsProps {
  inlineContext: NativeControlsContext;
  inlineVisible?: boolean;
  onOpenChatSettings?: () => void;
}

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
  const displayMessage = withoutRedundantReplyMention(message);
  const twitchRanges = [...displayMessage.twitchEmotes].sort(
    (left, right) => left.start - right.start,
  );
  const output: ReactNode[] = [];
  let cursor = 0;
  const appendText = (text: string, key: string) => {
    output.push(...renderProviderText(text, sevenTvEmotes, key, "native-overlay-emote"));
  };
  twitchRanges.forEach((range, index) => {
    if (range.start > cursor) {
      appendText(
        displayMessage.text.slice(cursor, range.start),
        `${message.id}-${index}`,
      );
    }
    const name = displayMessage.text.slice(range.start, range.end + 1);
    output.push(
      <ChatEmote
        className="native-overlay-emote"
        imageUrl={
          range.imageUrl ??
          `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(range.id)}/default/dark/2.0`
        }
        key={`${message.id}-twitch-${index}`}
        name={name}
        provider={range.provider ?? "twitch"}
      />,
    );
    cursor = range.end + 1;
  });
  if (cursor < displayMessage.text.length) {
    appendText(displayMessage.text.slice(cursor), `${message.id}-tail`);
  }
  return output;
}

interface OverlayChatMessageRowProps {
  message: ChatMessage;
  showTimestamp: boolean;
  badges: Map<string, ChatBadgeAsset>;
  oledMode: boolean;
  mentioned: boolean;
  deletedRevealed: boolean;
  deletedMessageStyle: AppPreferences["chatDeletedMessageStyle"];
  onRevealDeleted: (id: string) => void;
  onReply: (message: ChatMessage) => void;
  onOpenThread: (message: ChatMessage) => void;
  onOpenUser: (message: ChatMessage, anchor: DOMRect) => void;
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
  deletedMessageStyle,
  onRevealDeleted,
  onReply,
  onOpenThread,
  onOpenUser,
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
            {message.badgeAssets && message.badgeAssets.length > 0 ? (
              <span className="native-video-chat-badges">
                {message.badgeAssets.slice(0, 4).map((badge) => (
                  <ChatBadge badge={badge} key={badge.key} />
                ))}
              </span>
            ) : (
              message.badges.length > 0 && (
                <span className="native-video-chat-badges" title={message.badges.join(", ")}>
                  {message.badges.slice(0, 4).map((badgeKey) => {
                    const badge = badges.get(badgeKey);
                    return badge ? <ChatBadge badge={badge} key={badgeKey} /> : null;
                  })}
                </span>
              )
            )}
            <button
              className="chat-username"
              onClick={(event) => onOpenUser(message, event.currentTarget.getBoundingClientRect())}
              type="button"
            >
              {message.displayName}
            </button>
            <span>: </span>
            {renderOverlayText(message, providerEmotes)}
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      className={[
        "native-video-chat-message",
        mentioned ? "mentioned" : "",
        message.deleted && deletedMessageStyle === "dimmed" ? "deleted-dimmed" : "",
      ].filter(Boolean).join(" ")}
      data-chat-message-id={message.id}
    >
      {message.reply && (
        <button
          className="native-chat-reply-parent"
          onClick={() => onOpenThread(message)}
          title={message.reply.parentMessageBody}
          type="button"
        >
          Replying to {message.reply.parentDisplayName || message.reply.parentUserLogin}:{" "}
          {message.reply.parentMessageBody}
        </button>
      )}
      {showTimestamp && (
        <time
          className="native-chat-timestamp"
          dateTime={new Date(message.sentAt).toISOString()}
        >
          {formatChatTimestamp(message.sentAt)}
        </time>
      )}
      {message.badgeAssets && message.badgeAssets.length > 0 ? (
        <span className="native-video-chat-badges">
          {message.badgeAssets.slice(0, 4).map((badge) => (
            <ChatBadge badge={badge} key={badge.key} />
          ))}
        </span>
      ) : (
        message.badges.length > 0 && (
          <span className="native-video-chat-badges">
            {message.badges.slice(0, 4).map((badgeKey) => {
              const badge = badges.get(badgeKey);
              return badge ? <ChatBadge badge={badge} key={badgeKey} /> : null;
            })}
          </span>
        )
      )}
      <button
        className="chat-username"
        onClick={(event) => onOpenUser(message, event.currentTarget.getBoundingClientRect())}
        style={{
          color: readableUsernameColor(
            message.color,
            oledMode ? "#000000" : "#18181b",
          ),
        }}
        type="button"
      >
        {message.displayName}
      </button>
      {message.action ? <span> </span> : <span>: </span>}
      {message.deleted && deletedMessageStyle === "placeholder" && !deletedRevealed ? (
        <button
          className="deleted-message-toggle"
          onClick={() => onRevealDeleted(message.id)}
          title="Show the deleted message locally"
          type="button"
        >
          &lt;{formatModerationAction(message)}&gt;
        </button>
      ) : (
        <>
          <span
            className={message.deleted ? "deleted-original-content" : undefined}
            style={
              message.action
                ? {
                    color: readableUsernameColor(
                      message.color,
                      oledMode ? "#000000" : "#18181b",
                    ),
                  }
                : undefined
            }
          >
            {renderOverlayText(message, providerEmotes)}
          </span>
          {message.deleted && deletedMessageStyle === "dimmed" && (
            <span className="moderation-reason">
              {" "}({formatModerationAction(message)})
            </span>
          )}
        </>
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

export function NativeControls({
  inlineContext,
  inlineVisible = true,
  onOpenChatSettings,
}: NativeControlsProps) {
  const context = inlineContext;
  const [state, setState] = useState<NativePlayerState>(() => ({
    ...initialState,
    volume: cachedPlayerVolume,
  }));
  const [sliderVolume, setSliderVolume] = useState(cachedPlayerVolume);
  const volumeDragging = useRef(false);
  const [qualities, setQualities] = useState<NativeQuality[]>([
    { value: "best", label: "Auto" },
  ]);
  const [openMenu, setOpenMenu] = useState<"quality" | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsHovered, setStatsHovered] = useState(false);
  const [stats, setStats] = useState<Record<string, string> | null>(null);
  const [fpsOverlay, setFpsOverlay] = useState(false);
  const [pictureInPictureActive, setPictureInPictureActive] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [openReplyThread, setOpenReplyThread] = useState<ChatMessage | null>(null);
  const [selectedChatUser, setSelectedChatUser] = useState<ChatMessage | null>(null);
  const [selectedChatUserAnchor, setSelectedChatUserAnchor] = useState<DOMRect | undefined>();
  const [chatOpacity, setChatOpacity] = useState(() => {
    const stored = Number(window.localStorage.getItem("glint.chat.overlayOpacity"));
    return Number.isFinite(stored) && stored >= 25 && stored <= 100 ? stored : 88;
  });
  // Overlay chat geometry (relative to the video surface). null = unplaced, so
  // the CSS default top-right anchor is used until the first drag/resize.
  const [overlayGeometry, setOverlayGeometry] = useState<OverlayGeometry | null>(null);
  const overlayRef = useRef<HTMLElement>(null);
  const overlayDrag = useRef<OverlayDragState | null>(null);
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
  const [emoteAutocompleteMatch, setEmoteAutocompleteMatch] =
    useState<AppPreferences["emoteAutocompleteMatch"]>("prefix");
  const [chatDeletedMessageStyle, setChatDeletedMessageStyle] =
    useState<AppPreferences["chatDeletedMessageStyle"]>("placeholder");
  const [mentionSoundEnabled, setMentionSoundEnabled] = useState(false);
  const [mentionSoundVolume, setMentionSoundVolume] = useState(100);
  const [mentionSoundId, setMentionSoundId] = useState<MentionSoundId>("ping");
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
    chatDeletedMessageStyle,
    chatOverlayOpacity: chatOpacity,
    mentionSoundEnabled,
    mentionSoundVolume,
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
  const activityTimer = useRef<number | null>(null);
  const lastPointerPosition = useRef<{ x: number; y: number } | null>(null);
  const {
    messages: chatMessages,
    recentChatters,
    autoScroll: chatAutoScroll,
    pausedNewCount: pausedChatNewMessages,
    revealedDeleted: revealedDeletedMessages,
    messagesHostRef: chatMessagesHost,
    autoScrollRef: chatAutoScrollRef,
    handleScroll: handleChatScroll,
    handleWheel: handleChatWheel,
    handlePointerDown: handleChatPointerDown,
    scrollToCurrent: scrollChatToCurrent,
    revealDeleted: revealDeletedMessage,
    reset: resetChatFeed,
  } = useChatFeed(context?.channel);
  const chatInputHost = useRef<HTMLDivElement>(null);
  const chatComposerHost = useRef<HTMLFormElement>(null);
  const currentChannel = useRef<string | null>(null);
  const channel = context?.channel;
  const [chatRestrictionState, setChatRestrictionState] = useState<{
    channel: string | undefined;
    restrictions: ChatRestrictions;
  }>({ channel: undefined, restrictions: NO_CHAT_RESTRICTIONS });
  const chatRestrictions =
    chatRestrictionState.channel === channel
      ? chatRestrictionState.restrictions
      : NO_CHAT_RESTRICTIONS;
  const restoreUnsentChat = useCallback((message: string, reply?: ChatMessage) => {
    setChatInput(message);
    setReplyingTo(reply ?? null);
  }, []);
  const chatSender = useChatSendQueue(
    channel ?? null,
    chatRestrictions.slowModeSeconds,
    restoreUnsentChat,
  );
  useEffect(
    () =>
      window.desktop.chat.onRestrictions((restrictions) => {
        setChatRestrictionState({ channel, restrictions });
      }),
    [channel],
  );
  const chatRestrictionLabel = useMemo(() => {
    const parts: string[] = [];
    // Followers-only no longer applies once you follow; the rest still do.
    if (chatRestrictions.followersOnly && context?.isFollowed === false) {
      parts.push("Followers-only chat");
    }
    if (chatRestrictions.subscribersOnly) parts.push("Subscribers-only chat");
    if (chatRestrictions.emoteOnly) parts.push("Emote-only chat");
    if (chatRestrictions.slowModeSeconds) {
      parts.push(`Slow mode · ${chatRestrictions.slowModeSeconds}s`);
    }
    return parts.length > 0 ? parts.join(" · ") : null;
  }, [chatRestrictions, context?.isFollowed]);
  const chatBlocked =
    chatRestrictions.followersOnly && context?.isFollowed === false;
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
    if (!emotePickerOpen && !chatSettingsOpen) return;
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
        chatSettingsOpen &&
        !target.closest(".native-video-chat-tools, .native-video-chat-settings")
      ) {
        setChatSettingsOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOpenChatMenus, true);
    return () => document.removeEventListener("pointerdown", closeOpenChatMenus, true);
  }, [chatSettingsOpen, emotePickerOpen]);

  useEffect(
    () =>
      window.desktop.player.onNativeState((nextState) => {
        setState(nextState);
        if (!volumeDragging.current) setSliderVolume(nextState.volume);
      }),
    [],
  );

  useEffect(() => {
    const video = document.querySelector<HTMLVideoElement>(
      ".player-host > .native-hls-video",
    );
    if (!video) return;
    const updatePictureInPictureState = () => {
      setPictureInPictureActive(document.pictureInPictureElement === video);
    };
    const initialStateTimer = window.setTimeout(updatePictureInPictureState, 0);
    video.addEventListener("enterpictureinpicture", updatePictureInPictureState);
    video.addEventListener("leavepictureinpicture", updatePictureInPictureState);
    return () => {
      window.clearTimeout(initialStateTimer);
      video.removeEventListener("enterpictureinpicture", updatePictureInPictureState);
      video.removeEventListener("leavepictureinpicture", updatePictureInPictureState);
    };
  }, [channel]);

  useEffect(() => {
    if (currentChannel.current !== channel) {
      currentChannel.current = channel ?? null;
      resetChatFeed();
      setReplyingTo(null);
    }
  }, [channel, resetChatFeed]);
  useEffect(() => {
    if (!channel) return;
    window.desktop.player.controlNative({
      command: "set-compressor",
      enabled: audioCompressionPreference,
    });
  }, [audioCompressionPreference, channel]);
  useEffect(() => {
    let disposed = false;
    const applyPreferences = (preferences: AppPreferences) => {
      if (disposed) return;
      setChatOpacity(preferences.chatOverlayOpacity);
      // Do not fight an in-progress drag if a preference change lands mid-gesture.
      if (!overlayDrag.current) {
        setOverlayGeometry(
          preferences.chatOverlayPlaced
            ? {
                left: preferences.chatOverlayLeft,
                top: preferences.chatOverlayTop,
                width: preferences.chatOverlayWidth,
                height: preferences.chatOverlayHeight,
              }
            : null,
        );
      }
      cachedPlayerVolume = preferences.playerVolume;
      setChatTimestamps(preferences.chatTimestamps);
      setChatHistoryLimit(preferences.chatHistoryLimit);
      setChatFontSize(preferences.chatFontSize);
      setChatEmoteSize(preferences.chatEmoteSize);
      setChatDeletedMessageStyle(preferences.chatDeletedMessageStyle);
      setEmoteAutocompleteMatch(preferences.emoteAutocompleteMatch);
      setMentionSoundEnabled(preferences.mentionSoundEnabled);
      setMentionSoundVolume(preferences.mentionSoundVolume);
      setMentionSoundId(preferences.mentionSoundId);
      setOledMode(preferences.oledMode);
      setAudioCompressionPreference(preferences.audioCompression);
      setFpsOverlay(preferences.showFpsOverlay);
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
  useEffect(() => {
    if (!preferencesReady) return;
    window.desktop.chat.setHistoryLimit(chatHistoryLimit);
    const persistTimer = window.setTimeout(() => {
      void window.desktop.preferences
        .update({
          chatOverlayOpacity: chatOpacity,
          chatTimestamps,
          chatHistoryLimit,
          chatFontSize,
          chatEmoteSize,
          chatDeletedMessageStyle,
          mentionSoundEnabled,
          mentionSoundVolume,
          mentionSoundId,
          audioCompression: audioCompressionPreference,
        })
        .catch(() => undefined);
    }, 180);
    return () => window.clearTimeout(persistTimer);
  }, [
    audioCompressionPreference,
    chatHistoryLimit,
    chatFontSize,
    chatEmoteSize,
    chatDeletedMessageStyle,
    chatOpacity,
    chatTimestamps,
    mentionSoundEnabled,
    mentionSoundVolume,
    mentionSoundId,
    preferencesReady,
  ]);

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
    queueMicrotask(() => {
      if (cancelled) return;
      setProviderEmoteMaps(emptyProviderEmoteMaps());
      setProviderChannelNames(emptyProviderChannelNames());
    });

    const mergeProviderResult = (result: EmoteSetResult) => {
      if (cancelled) return;
      setProviderEmoteMaps((current) => {
        const next = new Map(current);
        const providerMap = new Map(next.get(result.provider));
        for (const emote of result.emotes) {
          if (result.scope === "channel" || !providerMap.has(emote.name)) {
            providerMap.set(emote.name, emote);
          }
        }
        next.set(result.provider, providerMap);
        return next;
      });
      if (result.scope === "channel") {
        setProviderChannelNames((current) => {
          const next = new Map(current);
          next.set(result.provider, new Set(result.emotes.map((emote) => emote.name)));
          return next;
        });
      }
    };

    const globalRequests = [
      window.desktop.emotes.getSevenTvGlobal(),
      window.desktop.emotes.getFfzGlobal(),
      window.desktop.emotes.getBttvGlobal(),
    ];
    for (const request of globalRequests) void request.then(mergeProviderResult).catch(() => {});

    void window.desktop.chat.getAssets(channel).then((assets) => {
      if (cancelled) return;
      setChatBadges(new Map(assets.badges.map((badge) => [badge.key, badge])));
      setTwitchPickerEmotes(assets.emotes);
      const channelRequests = [
        window.desktop.emotes.getSevenTvChannel(assets.broadcasterId),
        window.desktop.emotes.getFfzChannel(assets.broadcasterId),
        window.desktop.emotes.getBttvChannel(assets.broadcasterId),
      ];
      for (const request of channelRequests) {
        void request.then(mergeProviderResult).catch(() => {});
      }
    }).catch(() => {
      if (!cancelled) {
        setChatBadges(new Map());
        setTwitchPickerEmotes([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [channel]);


  const nativeChatOverlay = Boolean(
    context?.chatVisible && context.chatPresentation === "overlay",
  );

  // Keep a placed overlay inside the video surface when it resizes (window
  // resize, theater, fullscreen). No-op while unplaced or mid-drag.
  useEffect(() => {
    if (!nativeChatOverlay) return;
    const surface = overlayRef.current?.offsetParent as HTMLElement | null;
    if (!surface) return;
    const clampToSurface = () => {
      if (overlayDrag.current) return;
      setOverlayGeometry((current) => {
        if (!current) return current;
        const rect = surface.getBoundingClientRect();
        const clamped = clampOverlayGeometry(current, rect.width, rect.height);
        return clamped.left === current.left &&
          clamped.top === current.top &&
          clamped.width === current.width &&
          clamped.height === current.height
          ? current
          : clamped;
      });
    };
    const observer = new ResizeObserver(clampToSurface);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [nativeChatOverlay]);

  const persistOverlayGeometry = useCallback((geometry: OverlayGeometry) => {
    void window.desktop.preferences
      .update({
        chatOverlayPlaced: true,
        chatOverlayLeft: geometry.left,
        chatOverlayTop: geometry.top,
        chatOverlayWidth: geometry.width,
        chatOverlayHeight: geometry.height,
      })
      .catch(() => undefined);
  }, []);

  function beginOverlayGesture(
    event: React.PointerEvent<HTMLElement>,
    mode: "move" | "resize",
  ) {
    if (event.button !== 0) return;
    const overlay = overlayRef.current;
    const surface = overlay?.offsetParent as HTMLElement | null;
    if (!overlay || !surface) return;
    const overlayRect = overlay.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    overlayDrag.current = {
      mode,
      pointerX: event.clientX,
      pointerY: event.clientY,
      containerLeft: surfaceRect.left,
      containerTop: surfaceRect.top,
      containerWidth: surfaceRect.width,
      containerHeight: surfaceRect.height,
      // Adopt the current on-screen geometry so an unplaced (CSS-anchored)
      // overlay takes over smoothly from wherever it is.
      startLeft: overlayRect.left - surfaceRect.left,
      startTop: overlayRect.top - surfaceRect.top,
      startWidth: overlayRect.width,
      startHeight: overlayRect.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  function updateOverlayGesture(event: React.PointerEvent<HTMLElement>) {
    const drag = overlayDrag.current;
    if (!drag) return;
    const dx = event.clientX - drag.pointerX;
    const dy = event.clientY - drag.pointerY;
    let next: OverlayGeometry;
    if (drag.mode === "move") {
      next = {
        left: drag.startLeft + dx,
        top: drag.startTop + dy,
        width: drag.startWidth,
        height: drag.startHeight,
      };
    } else {
      // Resize from the top-left: the bottom-right corner stays anchored.
      const anchorRight = drag.startLeft + drag.startWidth;
      const anchorBottom = drag.startTop + drag.startHeight;
      const width = Math.min(OVERLAY_MAX_WIDTH, Math.max(OVERLAY_MIN_WIDTH, drag.startWidth - dx));
      const height = Math.min(
        OVERLAY_MAX_HEIGHT,
        Math.max(OVERLAY_MIN_HEIGHT, drag.startHeight - dy),
      );
      next = { left: anchorRight - width, top: anchorBottom - height, width, height };
    }
    setOverlayGeometry(clampOverlayGeometry(next, drag.containerWidth, drag.containerHeight));
  }

  function endOverlayGesture(event: React.PointerEvent<HTMLElement>) {
    if (!overlayDrag.current) return;
    overlayDrag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setOverlayGeometry((current) => {
      if (current) persistOverlayGeometry(current);
      return current;
    });
  }

  function resetOverlayGeometry() {
    setOverlayGeometry(null);
    void window.desktop.preferences
      .update({ chatOverlayPlaced: false })
      .catch(() => undefined);
  }

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

  const beginReply = useCallback((message: ChatMessage) => {
    setReplyingTo(message);
    window.requestAnimationFrame(() => chatInputHost.current?.focus());
  }, []);

  const openChatUserCard = useCallback((message: ChatMessage, anchor: DOMRect) => {
    setSelectedChatUser(message);
    setSelectedChatUserAnchor(anchor);
  }, []);

  function revealChatComposer() {
    if (!chatAutoScrollRef.current) return;
    const startedAt = window.performance.now();
    const keepPinned = (now: number) => {
      if (!chatAutoScrollRef.current) return;
      const host = chatMessagesHost.current;
      if (host) host.scrollTop = host.scrollHeight;
      if (now - startedAt < 200) window.requestAnimationFrame(keepPinned);
    };
    window.requestAnimationFrame(keepPinned);
  }

  async function sendChatMessage(event: FormEvent) {
    event.preventDefault();
    if (!channel || !chatInput.trim()) return;
    const message = chatInput.trim();
    const replyTarget = replyingTo;
    setChatInput("");
    setReplyingTo(null);
    await chatSender.send(message, replyTarget ?? undefined);
  }

  useEffect(() => {
    if (!openMenu) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenMenu(null);
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

  // Turn hls.js/Chromium diagnostics into labelled rows, dropping values that
  // have not been measured yet.
  const statsRows = useMemo(() => {
    if (!stats) return [];
    const read = (key: string) => {
      const value = stats[key];
      return value && value.length > 0 ? value : null;
    };
    return [
      { label: "Latency", value: read("Latency") },
      { label: "Low latency mode", value: read("Low latency mode") },
      { label: "Resolution", value: read("Resolution") },
      { label: "Framerate", value: read("FPS") },
      { label: "Bitrate", value: read("Video bitrate") },
      { label: "Dropped frames", value: read("Dropped frames") },
      { label: "Playback rate", value: read("Playback rate") },
      { label: "Buffer size", value: read("Buffer") },
      { label: "Stall recoveries", value: read("Stall recoveries") },
    ].filter(
      (row): row is { label: string; value: string } => row.value !== null,
    );
  }, [stats]);

  // The compact latency badge needs current HLS stats even while the full
  // panel is closed.
  useEffect(() => {
    const statsRequested = statsOpen || statsHovered || fpsOverlay;
    // Do not reconcile the entire controls/chat tree for a background latency
    // badge while the user is reading older messages. Opening or hovering the
    // stats UI still requests fresh figures immediately.
    if (!chatAutoScroll && !statsRequested) return;
    let cancelled = false;
    const read = async () => {
      const next = await window.desktop.player.getNativeStats();
      if (!cancelled) setStats(next);
    };
    void read();
    const timer = window.setInterval(
      () => void read(),
      statsRequested ? 750 : 3_000,
    );
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    chatAutoScroll,
    fpsOverlay,
    statsHovered,
    statsOpen,
  ]);

  // The current frame rate, reused for both the panel and the corner overlay.
  const fpsDisplay = useMemo(
    () =>
      statsRows.find(
        (row) => row.label === "FPS" || row.label === "Framerate",
      )?.value ?? null,
    [statsRows],
  );
  const latencyDisplay = stats?.Latency ?? null;

  // Clearing here rather than in the effect keeps a stale reading from showing
  // for a frame when the panel is reopened. Kept if the FPS overlay still needs it.
  function closeOrOpenStats(next?: boolean) {
    const open = next ?? !statsOpen;
    setStatsOpen(open);
  }

  function toggleFpsOverlay(next: boolean) {
    setFpsOverlay(next);
    void window.desktop.preferences.update({ showFpsOverlay: next }).catch(() => undefined);
  }

  function closeMenu() {
    setOpenMenu(null);
    reportActivity();
  }

  function toggleMenu(menu: "quality") {
    const nextMenu = openMenu === menu ? null : menu;
    setOpenMenu(nextMenu);
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

  function togglePlayback() {
    if (!channel) return;
    closeMenu();
    window.desktop.player.controlNative({
      command: state.paused ? "go-live" : "toggle-pause",
    });
  }

  async function togglePictureInPicture() {
    if (!document.pictureInPictureEnabled) return;
    const video = document.querySelector<HTMLVideoElement>(
      ".player-host > .native-hls-video",
    );
    if (!video) return;
    try {
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch {
      // Chromium rejects PiP while the video has no presented frame. The
      // button remains available once playback reaches the playing state.
    }
  }

  function selectChatLayout(action: "hide-chat" | "side-chat" | "overlay-chat") {
    closeMenu();
    window.desktop.player.sendNativeControlAction(action);
  }

  const qualityLabel =
    qualities.find((quality) => quality.value === state.quality)?.label ?? state.quality;
  const viewerLogin = context.viewerLogin ?? "";
  const chatHistoryBoundary = chatMessages.reduce(
    (lastIndex, message, index) => (message.historical ? index : lastIndex),
    -1,
  );
  const channelLogin = parseChannelKey(context.channel).login;
  const chatMentionCandidates = filterChatMentionCandidates(recentChatters, "", 100, {
    color: "#9147ff",
    displayName: context.channelDisplayName ?? channelLogin,
    login: channelLogin,
  });
  const chatOverlayActive = context.chatVisible && context.chatPresentation === "overlay";

  return (
    <div
      className={[
        "controls-surface",
        "inline-controls",
        oledMode ? "oled-mode" : "",
        !context.chatVisible ? "chat-hidden" : "",
        !inlineVisible ? "controls-hidden" : "",
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
          className={
            overlayGeometry ? "native-video-chat placed" : "native-video-chat"
          }
          onMouseEnter={revealChatComposer}
          ref={overlayRef}
          style={{
            backgroundColor: oledMode
              ? `rgb(0 0 0 / ${chatOpacity}%)`
              : `rgb(24 24 27 / ${chatOpacity}%)`,
            ...(overlayGeometry
              ? {
                  left: overlayGeometry.left,
                  top: overlayGeometry.top,
                  width: overlayGeometry.width,
                  height: overlayGeometry.height,
                  right: "auto",
                  bottom: "auto",
                }
              : {}),
          }}
        >
          <button
            aria-label="Resize chat overlay"
            className="native-video-chat-resize"
            onPointerDown={(event) => beginOverlayGesture(event, "resize")}
            onPointerMove={updateOverlayGesture}
            onPointerUp={endOverlayGesture}
            onDoubleClick={resetOverlayGeometry}
            title="Drag to resize · double-click to reset"
            type="button"
          >
            <MoveDiagonal2 size={13} />
          </button>
          <div
            className="native-video-chat-tools"
            onPointerDown={(event) => {
              // Buttons inside the tools bar keep their own behavior; empty
              // space acts as a title bar for moving the overlay.
              if (event.target instanceof Element && event.target.closest("button")) return;
              beginOverlayGesture(event, "move");
            }}
            onPointerMove={updateOverlayGesture}
            onPointerUp={endOverlayGesture}
          >
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
          </div>
          {chatSettingsOpen && (
            // Rendered as a sibling of the tools bar, not a child: the tools bar
            // is the drag surface, so nesting the panel there turned every
            // slider and toggle into a move handle.
            <div
              className="native-video-chat-settings"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <strong>Chat settings</strong>
              <TwitchChatColorControls
                platform={channel ? parseChannelKey(channel).platform : "twitch"}
              />
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
              <ChatToggleSetting
                checked={chatTimestamps}
                label="Show timestamps"
                onChange={setChatTimestamps}
              />
              <ChatToggleSetting
                checked={mentionSoundEnabled}
                label="Mention sound"
                onChange={setMentionSoundEnabled}
              />
              <MentionSoundControls
                onSoundChange={setMentionSoundId}
                onVolumeChange={setMentionSoundVolume}
                soundId={mentionSoundId}
                volume={mentionSoundVolume}
              />
              <ChatToggleSetting
                checked={chatDeletedMessageStyle === "dimmed"}
                label="Dim deleted messages"
                onChange={(checked) =>
                  setChatDeletedMessageStyle(
                    checked ? "dimmed" : "placeholder",
                  )
                }
              />
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
              {onOpenChatSettings && (
                <button
                  className="chat-settings-more"
                  onClick={() => {
                    setChatSettingsOpen(false);
                    onOpenChatSettings();
                  }}
                  type="button"
                >
                  <Settings size={14} />
                  More chat settings
                  <ChevronRight size={14} />
                </button>
              )}
            </div>
          )}
          <div
            className={`native-video-chat-messages${
              chatAutoScroll ? "" : " scroll-paused"
            }`}
            onScroll={handleChatScroll}
            onWheel={handleChatWheel}
            onPointerDown={handleChatPointerDown}
            ref={chatMessagesHost}
          >
            {chatMessages.map((message, index) => (
              <Fragment key={message.id}>
              <OverlayChatMessageRow
                badges={chatBadges}
                deletedMessageStyle={chatDeletedMessageStyle}
                deletedRevealed={revealedDeletedMessages.has(message.id)}
                mentioned={messageMentionsLogin(message, viewerLogin)}
                message={message}
                oledMode={oledMode}
                onRevealDeleted={revealDeletedMessage}
                onOpenThread={setOpenReplyThread}
                onOpenUser={openChatUserCard}
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
          {openReplyThread && (
            <ReplyThread
              badges={chatBadges}
              messages={chatMessages}
              oledMode={oledMode}
              onClose={() => setOpenReplyThread(null)}
              onOpenUser={openChatUserCard}
              onReply={beginReply}
              renderText={(message) => renderOverlayText(message, chatProviderEmotes)}
              selected={openReplyThread}
            />
          )}
          {selectedChatUser && channel && (
            <ChatUserCard
              anchor={selectedChatUserAnchor}
              badges={chatBadges}
              channel={channel}
              key={`${channel}:${selectedChatUser.login}`}
              messages={chatMessages}
              onClose={() => {
                setSelectedChatUser(null);
                setSelectedChatUserAnchor(undefined);
              }}
              renderText={(message) =>
                renderOverlayText(message, chatProviderEmotes)}
              selected={selectedChatUser}
            />
          )}
          {!chatAutoScroll && (
            <button
              className="native-scroll-current"
              onClick={scrollChatToCurrent}
              title={
                pausedChatNewMessages > 20
                  ? "20+ new messages"
                  : pausedChatNewMessages > 0
                    ? `${pausedChatNewMessages} new ${pausedChatNewMessages === 1 ? "message" : "messages"}`
                    : "Return to live chat"
              }
              type="button"
            >
              <Pause aria-hidden="true" size={12} />
              <span>Chat paused due to scroll</span>
              <ArrowDown aria-hidden="true" size={14} />
            </button>
          )}
          <form className="native-video-chat-input" onSubmit={sendChatMessage} ref={chatComposerHost}>
            <ChatSendStatus
              onDismiss={chatSender.dismiss}
              status={chatSender.status}
            />
            {chatRestrictionLabel && (
              <div className={chatBlocked ? "chat-restriction blocked" : "chat-restriction"}>
                <Lock size={13} aria-hidden="true" />
                <span>
                  {chatRestrictionLabel}
                  {chatBlocked && " · Follow to chat"}
                </span>
              </div>
            )}
            {replyingTo && (
              <div className="native-chat-reply-composer">
                <div className="chat-reply-heading">
                  <span><Reply size={15} /> Replying to {replyingTo.displayName}:</span>
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
                    return badge ? <ChatBadge badge={badge} key={badgeKey} /> : null;
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
                emoteMatch={emoteAutocompleteMatch}
                aria-label="Send a chat message"
                maxLength={500}
                mentionCandidates={chatMentionCandidates}
                onValueChange={setChatInput}
                placeholder={replyingTo ? "Write a reply" : "Send a message"}
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
                disabled={!chatInput.trim() || chatBlocked}
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
      {statsOpen && (
        <div
          className="stats-panel hls-stats"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <header>
            <strong>Video Player Stats</strong>
            <button aria-label="Close video stats" onClick={() => closeOrOpenStats(false)} type="button">
              <X size={15} />
            </button>
          </header>
          {statsRows.length > 0 ? (
            <dl>
              {statsRows.map((row, index) => (
                <Fragment key={row.label}>
                  {(index === 2 || index === 5) && (
                    <span aria-hidden="true" className="stats-row-divider" />
                  )}
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </Fragment>
              ))}
            </dl>
          ) : (
            <p className="stats-empty">
              {stats ? "Waiting for playback." : "Stats are only available on the Native player."}
            </p>
          )}
          <label className="stats-fps-toggle">
            <input
              checked={fpsOverlay}
              onChange={(event) => toggleFpsOverlay(event.target.checked)}
              type="checkbox"
            />
            Show FPS in the corner
          </label>
        </div>
      )}
      {fpsOverlay && fpsDisplay && (
        <div className="fps-overlay">{fpsDisplay} FPS</div>
      )}
      {state.paused && (
        <button
          aria-label="Play and return to live"
          className="native-center-play"
          onClick={togglePlayback}
          title="Play and return to live"
          type="button"
        >
          <Play aria-hidden="true" fill="currentColor" size={42} />
        </button>
      )}
      <div className="controls-bar" aria-label="Native player controls">
        <button
          aria-label={state.paused ? "Play" : "Pause"}
          data-tooltip={
            state.paused ? "Play and return to live (Space)" : "Pause (Space)"
          }
          onClick={togglePlayback}
          type="button"
        >
          {state.paused ? <Play size={19} /> : <Pause size={19} />}
        </button>
        <button
          aria-label={state.muted ? "Unmute (M)" : "Mute (M)"}
          data-tooltip={state.muted ? "Unmute (M)" : "Mute (M)"}
          onClick={() => {
            volumeDragging.current = false;
            window.desktop.player.controlNative({ command: "toggle-mute" });
          }}
          type="button"
        >
          {state.muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
        <input
          aria-label="Volume"
          max="100"
          min="0"
          onInput={(event) => {
            const value = Number(event.currentTarget.value);
            setSliderVolume(value);
            // Update the remount cache immediately, not via the debounced
            // preference save — otherwise switching channels right after a
            // change re-mounts the controls at the stale value and jumps.
            cachedPlayerVolume = value;
            window.desktop.player.controlNative({ command: "set-volume", value });
          }}
          onBlur={() => {
            volumeDragging.current = false;
          }}
          onPointerCancel={() => {
            volumeDragging.current = false;
          }}
          onPointerDown={() => {
            volumeDragging.current = true;
          }}
          onPointerUp={() => {
            volumeDragging.current = false;
          }}
          type="range"
          value={sliderVolume}
        />
        <span className="volume-label">{sliderVolume}%</span>
        <button
          aria-label={
            state.compressorEnabled ? "Disable audio compression" : "Enable audio compression"
          }
          aria-pressed={state.compressorEnabled}
          data-tooltip={
            state.compressorEnabled ? "Disable audio compression" : "Enable audio compression"
          }
          onClick={() => {
            const enabled = !state.compressorEnabled;
            setAudioCompressionPreference(enabled);
            window.desktop.player.controlNative({ command: "set-compressor", enabled });
          }}
          type="button"
        >
          <span className={`icon-toggle${state.compressorEnabled ? "" : " off"}`}>
            <AudioLines size={18} />
          </span>
        </button>
        <span className="control-spacer" />
        <div
          aria-label={
            state.paused
              ? "Playback paused"
              : state.behindLive
                ? "Playback behind live"
                : "Playback at live edge"
          }
          className={`live-state ${state.status}${
            state.paused || state.behindLive ? " behind-live" : ""
          }`}
          role="status"
        >
          {state.paused
            ? "Paused"
            : state.behindLive
              ? "Behind live"
              : state.status === "playing"
                ? "Live"
                : state.status}
        </div>
        <div
          className="stats-control"
          onMouseEnter={() => setStatsHovered(true)}
          onMouseLeave={() => setStatsHovered(false)}
        >
          <button
            aria-label={
              latencyDisplay
                ? `Video stats, ${latencyDisplay} latency`
                : "Video stats"
            }
            aria-pressed={statsOpen}
            className={`${statsOpen ? "active " : ""}latency-stats-button`.trim()}
            onClick={() => closeOrOpenStats()}
            type="button"
          >
            <Gauge size={17} />
            {latencyDisplay && <span>{latencyDisplay}</span>}
          </button>
          {statsHovered && !statsOpen && (
            <div className="stats-hover-card" role="tooltip">
              <strong>Video Player Stats</strong>
              {statsRows.length > 0 ? (
                <dl>
                  {statsRows.map((row, index) => (
                    <Fragment key={row.label}>
                      {(index === 2 || index === 5) && (
                        <span aria-hidden="true" className="stats-row-divider" />
                      )}
                      <dt>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </Fragment>
                  ))}
                </dl>
              ) : (
                <p>Measuring playback…</p>
              )}
            </div>
          )}
        </div>
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
          aria-label={chatOverlayActive ? "Dock chat beside the video" : "Overlay chat on the video"}
          aria-pressed={chatOverlayActive}
          data-tooltip={chatOverlayActive ? "Disable chat overlay" : "Enable chat overlay"}
          onClick={() => selectChatLayout(chatOverlayActive ? "side-chat" : "overlay-chat")}
          type="button"
        >
          {chatOverlayActive ? (
            <MessageSquareText size={18} />
          ) : (
            <MessageSquareOff size={18} />
          )}
        </button>
        {document.pictureInPictureEnabled && (
          <button
            aria-label={
              pictureInPictureActive
                ? "Exit picture-in-picture"
                : "Picture-in-picture"
            }
            aria-pressed={pictureInPictureActive}
            className={pictureInPictureActive ? "active" : ""}
            data-tooltip={
              pictureInPictureActive
                ? "Exit picture-in-picture"
                : "Picture-in-picture"
            }
            disabled={state.status !== "playing"}
            onClick={() => void togglePictureInPicture()}
            type="button"
          >
            <PictureInPicture2 size={18} />
          </button>
        )}
        <button
          aria-label="Theater mode"
          aria-pressed={context.theaterMode}
          data-tooltip="Theater mode (T)"
          onClick={() => window.desktop.player.sendNativeControlAction("toggle-theater")}
          type="button"
        >
          <SidebarLayoutIcon filled={context.theaterMode} />
        </button>
        <button
          aria-label={context.fullscreen ? "Exit fullscreen" : "Fullscreen"}
          aria-pressed={context.fullscreen}
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
