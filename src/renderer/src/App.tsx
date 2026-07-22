import {
  FormEvent,
  Fragment,
  memo,
  type ReactNode,
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  Clock,
  ChevronLeft,
  ChevronRight,
  Compass,
  Check,
  Copy,
  ExternalLink,
  Heart,
  History,
  Home,
  LayoutGrid,
  LogIn,
  Maximize,
  Minimize,
  MoveDiagonal2,
  Play,
  Pause,
  RotateCcw,
  RefreshCw,
  Reply,
  Scissors,
  Search,
  Settings,
  Smile,
  Star,
  StarOff,
  Tv,
  Users,
  Unlink,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  formatQualityLabel,
  type ChatPresentation,
  type ChannelActionWindowState,
  type MultiStreamTileState,
  type NativePlayerAvailability,
  type NativeRenderBackend,
  type NativePlayerState,
  type NativeQualityValue,
  type PlayerMode,
} from "../../shared/player";
import type {
  BrowseCategory,
  BrowseStream,
  FollowedChannel,
  SearchChannelResult,
  TwitchSearchResults,
  StreamMetadata,
  TwitchAuthState,
  TwitchDeviceAuthorization,
  PlaybackSessionState,
} from "../../shared/twitch";
import type { EmoteSetResult } from "../../shared/emotes";
import type { AppPreferences, MentionSoundId } from "../../shared/preferences";
import type { EmoteProvider, ProviderEmote } from "../../shared/emotes";
import type {
  ChatBadgeAsset,
  ChatConnectionState,
  ChatMessage,
  TwitchPickerEmote,
} from "../../shared/chat";
import { applyChatMessageBatch } from "../../shared/chat-messages";
import {
  formatChatTimestamp,
  formatModerationAction,
  messageMentionsLogin,
} from "../../shared/chat";
import { getChatMentionCandidates } from "../../shared/chat-content";
import {
  mergeChangelogEntries,
  parseChangelog,
} from "../../shared/changelog";
import { readableUsernameColor } from "../../shared/chat-color";
import { ChatComposerInput } from "./ChatComposerInput";
import { useChatFeed } from "./chat-feed";
import { EmotePicker } from "./EmotePicker";
import { MultiStreamView } from "./MultiStreamView";
import { ReactTooltipLayer } from "./ReactTooltipLayer";
import { ChatEmote } from "./ChatEmote";
import { ChatBadge } from "./ChatBadge";
import { ReplyThread } from "./ReplyThread";
import { ChatUserCard } from "./ChatUserCard";
import { NativeControls } from "./NativeControls";
import {
  ChatToggleSetting,
  MentionSoundControls,
} from "./ChatSettingsControls";
import { withoutRedundantReplyMention } from "./chat-display";
import { playMentionSound } from "./mention-sound";
import { renderProviderText } from "./ProviderEmoteText";
import type { AppUpdateStatus } from "../../shared/updates";
import violetWireIcon from "./assets/violetwire-icon.png";
import changelogSource from "../../../CHANGELOG.md?raw";
import "./controls.css";

const NATIVE_CONTROLS_HIDE_DELAY = 5_000;

type AppSection = "home" | "browse" | "settings";
type ChatLayout = "hidden" | ChatPresentation;
type ChannelNavigationIdentity = {
  login: string;
  displayName: string;
  profileImageUrl: string;
  title?: string;
  isLive?: boolean;
  viewerCount?: number;
  startedAt?: string;
  category?: string;
  language?: string;
  tags?: string[];
  isMature?: boolean;
};

const signedOutState: TwitchAuthState = { status: "signed-out", account: null };
const anonymousPlaybackState: PlaybackSessionState = { linked: false };
const emptySearchResults: TwitchSearchResults = { channels: [], categories: [] };
const emoteProviders: EmoteProvider[] = ["7tv", "ffz", "bttv"];
const bundledChangelogEntries = parseChangelog(changelogSource);
const languageNames: Record<string, string> = {
  de: "german",
  en: "english",
  es: "spanish",
  fr: "french",
  it: "italian",
  ja: "japanese",
  ko: "korean",
  pl: "polish",
  pt: "portuguese",
  ru: "russian",
  tr: "turkish",
  zh: "chinese",
};

function emptyProviderEmoteMaps(): Map<EmoteProvider, Map<string, ProviderEmote>> {
  return new Map(emoteProviders.map((provider) => [provider, new Map()]));
}

function emptyProviderChannelNames(): Map<EmoteProvider, Set<string>> {
  return new Map(emoteProviders.map((provider) => [provider, new Set()]));
}

function formatUptime(startedAt: string | undefined, now: number): string {
  if (!startedAt) return "";
  const elapsed = Math.max(0, now - new Date(startedAt).getTime());
  const hours = Math.floor(elapsed / 3_600_000);
  const minutes = Math.floor((elapsed % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function visibleStreamTags(tags: string[] | undefined, language: string | undefined): string[] {
  const languageCode = language?.toLowerCase() ?? "";
  const languageName = languageNames[languageCode];
  const seen = new Set<string>();
  return (tags ?? [])
    .map((tag) => tag.trim())
    .filter((tag) => {
      const normalized = tag.toLowerCase();
      if (
        !normalized ||
        normalized === languageCode ||
        normalized === languageName ||
        seen.has(normalized)
      ) {
        return false;
      }
      seen.add(normalized);
      return true;
    })
    .slice(0, 3);
}

function renderChatMessageText(
  message: ChatMessage,
  providerEmotes: Map<string, ProviderEmote>,
): ReactNode[] {
  const displayMessage = withoutRedundantReplyMention(message);
  const ranges = [...displayMessage.twitchEmotes].sort(
    (left, right) => left.start - right.start,
  );
  if (ranges.length === 0) {
    return renderProviderText(
      displayMessage.text,
      providerEmotes,
      message.id,
      "chat-emote",
    );
  }
  const output: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) {
      output.push(
        ...renderProviderText(
          displayMessage.text.slice(cursor, range.start),
          providerEmotes,
          `${message.id}-text-${index}`,
          "chat-emote",
        ),
      );
    }
    const name = displayMessage.text.slice(range.start, range.end + 1);
    output.push(
      <ChatEmote
        className="chat-emote"
        imageUrl={`https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(range.id)}/default/dark/2.0`}
        key={`${message.id}-twitch-${index}`}
        name={name}
        provider="twitch"
      />,
    );
    cursor = range.end + 1;
  });
  if (cursor < displayMessage.text.length) {
    output.push(
      ...renderProviderText(
        displayMessage.text.slice(cursor),
        providerEmotes,
        `${message.id}-tail`,
        "chat-emote",
      ),
    );
  }
  return output;
}

interface ChatMessageRowProps {
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
// re-rendering (and re-tokenizing emotes for) every message in the list.
const ChatMessageRow = memo(function ChatMessageRow({
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
}: ChatMessageRowProps) {
  if (message.notice) {
    return (
      <div
        className="native-chat-message chat-notice-message"
        data-chat-message-id={message.id}
      >
        <div className="chat-notice-heading">
          <Star fill="currentColor" size={15} />
          <strong>{message.notice.systemMessage}</strong>
        </div>
        <div className="chat-notice-facts">
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
          <div className="chat-notice-text">
            {showTimestamp && (
              <time dateTime={new Date(message.sentAt).toISOString()}>
                {formatChatTimestamp(message.sentAt)}
              </time>
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
            <span className="chat-colon">:</span>{" "}
            {renderChatMessageText(message, providerEmotes)}
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      className={[
        "native-chat-message",
        mentioned ? "mentioned" : "",
        message.deleted && deletedMessageStyle === "dimmed" ? "deleted-dimmed" : "",
      ].filter(Boolean).join(" ")}
      data-chat-message-id={message.id}
    >
      {message.reply && (
        <button
          className="chat-reply-parent"
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
          className="chat-timestamp"
          dateTime={new Date(message.sentAt).toISOString()}
        >
          {formatChatTimestamp(message.sentAt)}
        </time>
      )}
      {message.badges.length > 0 && (
        <span className="native-chat-badges" title={message.badges.join(", ")}>
          {message.badges.slice(0, 4).map((badgeKey) => {
            const badge = badges.get(badgeKey);
            return badge ? <ChatBadge badge={badge} key={badgeKey} /> : null;
          })}
        </span>
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
      {message.action ? " " : <><span className="chat-colon">:</span>{" "}</>}
      <span
        className="native-chat-text"
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
            <span className={message.deleted ? "deleted-original-content" : undefined}>
              {renderChatMessageText(message, providerEmotes)}
            </span>
            {message.deleted && deletedMessageStyle === "dimmed" && (
              <span className="moderation-reason">
                {" "}({formatModerationAction(message)})
              </span>
            )}
          </>
        )}
      </span>
      {!message.deleted && (
        <button
          aria-label={`Reply to ${message.displayName}`}
          className="chat-message-reply"
          onClick={() => onReply(message)}
          title={`Reply to ${message.displayName}`}
          type="button"
        >
          <Reply size={14} />
        </button>
      )}
    </div>
  );
});

export function App() {
  const [activeSection, setActiveSection] = useState<AppSection>("home");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [changelogEntries, setChangelogEntries] = useState(
    bundledChangelogEntries,
  );
  const [changelogReturnsToSettings, setChangelogReturnsToSettings] = useState(false);
  const [playerReturnSection, setPlayerReturnSection] = useState<AppSection>("home");
  const [channelInput, setChannelInput] = useState("");
  const [topSearchResults, setTopSearchResults] =
    useState<TwitchSearchResults>(emptySearchResults);
  const [topSearchOpen, setTopSearchOpen] = useState(false);
  const [topSearchLoading, setTopSearchLoading] = useState(false);
  const [activeChannel, setActiveChannel] = useState<string | null>(null);
  const [activeChannelIdentity, setActiveChannelIdentity] =
    useState<ChannelNavigationIdentity>();
  const [subscriptionDrawerState, setSubscriptionDrawerState] =
    useState<ChannelActionWindowState>("closed");
  const [error, setError] = useState<string | null>(null);
  const [chatVisible, setChatVisible] = useState(true);
  const [chatPresentation, setChatPresentation] = useState<ChatPresentation>("side");
  const [theaterMode, setTheaterMode] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [nativeControlsVisible, setNativeControlsVisible] = useState(true);
  const [controlsHideDelay, setControlsHideDelay] = useState(NATIVE_CONTROLS_HIDE_DELAY);
  const [notice, setNotice] = useState<string | null>(null);
  // The real version arrives from the main process via updates.getStatus();
  // an empty placeholder avoids hardcoding a release version in the renderer.
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>({
    state: "disabled",
    currentVersion: "",
  });
  const [uptimeNow, setUptimeNow] = useState(() => Date.now());
  const [authState, setAuthState] = useState<TwitchAuthState>(signedOutState);
  const [authBusy, setAuthBusy] = useState(true);
  const [deviceAuthorization, setDeviceAuthorization] =
    useState<TwitchDeviceAuthorization | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [followedChannels, setFollowedChannels] = useState<FollowedChannel[]>([]);
  const [favoriteChannels, setFavoriteChannels] = useState<Set<string>>(new Set());
  const [channelMenu, setChannelMenu] = useState<{
    login: string;
    x: number;
    y: number;
  } | null>(null);
  const [browseCategories, setBrowseCategories] = useState<BrowseCategory[]>([]);
  const [browseCategoryCursor, setBrowseCategoryCursor] = useState<string | undefined>();
  const [browseSearch, setBrowseSearch] = useState("");
  const [browseLoading, setBrowseLoading] = useState(true);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [selectedBrowseCategory, setSelectedBrowseCategory] =
    useState<BrowseCategory | null>(null);
  const [categoryStreams, setCategoryStreams] = useState<BrowseStream[]>([]);
  const [categoryStreamCursor, setCategoryStreamCursor] = useState<string | undefined>();
  const [categoryStreamsLoading, setCategoryStreamsLoading] = useState(false);
  const [streamMetadata, setStreamMetadata] = useState<StreamMetadata | null>(null);
  const [playbackSession, setPlaybackSession] =
    useState<PlaybackSessionState>(anonymousPlaybackState);
  const [playbackSessionBusy, setPlaybackSessionBusy] = useState(false);
  const [sevenTvStatus, setSevenTvStatus] = useState<EmoteSetResult | null>(null);
  const [sevenTvBusy, setSevenTvBusy] = useState(false);
  const [chatConnectionState, setChatConnectionState] =
    useState<ChatConnectionState>("disconnected");
  const [chatInput, setChatInput] = useState("");
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [openReplyThread, setOpenReplyThread] = useState<ChatMessage | null>(null);
  const [selectedChatUser, setSelectedChatUser] = useState<ChatMessage | null>(null);
  const [selectedChatUserAnchor, setSelectedChatUserAnchor] = useState<DOMRect | undefined>();
  const [providerEmoteMaps, setProviderEmoteMaps] = useState(emptyProviderEmoteMaps);
  const [providerChannelNames, setProviderChannelNames] = useState(
    emptyProviderChannelNames,
  );
  const [twitchBadges, setTwitchBadges] = useState<Map<string, ChatBadgeAsset>>(new Map());
  const [twitchPickerEmotes, setTwitchPickerEmotes] = useState<TwitchPickerEmote[]>([]);
  // Cache each channel's loaded emotes/badges so switching chat (multistream
  // tabs especially) reuses them instantly instead of clearing and refetching.
  const emoteBundleCache = useRef<
    Map<string, { maps: Map<EmoteProvider, Map<string, ProviderEmote>>; names: Map<EmoteProvider, Set<string>> }>
  >(new Map());
  const badgeBundleCache = useRef<
    Map<string, { badges: Map<string, ChatBadgeAsset>; picker: TwitchPickerEmote[] }>
  >(new Map());
  const [emotePickerOpen, setEmotePickerOpen] = useState(false);
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
  const [chatDeletedMessageStyle, setChatDeletedMessageStyle] =
    useState<AppPreferences["chatDeletedMessageStyle"]>("placeholder");
  const [chatOnLeft, setChatOnLeft] = useState(
    () => window.localStorage.getItem("glint.chat.onLeft") === "true",
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chatSidebarWidth, setChatSidebarWidth] = useState(384);
  const playerPageRef = useRef<HTMLElement>(null);
  const chatResizeState = useRef<{ layoutLeft: number; layoutRight: number } | null>(null);
  const [chatResizing, setChatResizing] = useState(false);
  const [chatOpacity, setChatOpacity] = useState(() => {
    const stored = Number(window.localStorage.getItem("glint.chat.overlayOpacity"));
    return Number.isFinite(stored) && stored >= 25 && stored <= 100 ? stored : 88;
  });
  const [mentionSoundEnabled, setMentionSoundEnabled] = useState(false);
  const [mentionSoundVolume, setMentionSoundVolume] = useState(100);
  const [mentionSoundId, setMentionSoundId] = useState<MentionSoundId>("ping");
  const [oledMode, setOledMode] = useState(
    () => window.localStorage.getItem("glint.appearance.oled") === "true",
  );
  const [preferredMode, setPreferredMode] = useState<PlayerMode>(() =>
    window.localStorage.getItem("glint.playback.default") === "official" ? "official" : "native",
  );
  const [experimentalTexturePlayer, setExperimentalTexturePlayer] = useState(true);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [lastSeenChangelogVersion, setLastSeenChangelogVersion] = useState("");
  const changelogAutoShown = useRef(false);
  const legacyPreferences = useRef({
    preferredPlayerMode: preferredMode,
    experimentalTexturePlayer: true,
    chatTimestamps,
    chatHistoryLimit,
    chatFontSize,
    chatEmoteSize,
    chatDeletedMessageStyle,
    chatOnLeft,
    chatOverlayOpacity: chatOpacity,
    mentionSoundEnabled,
    mentionSoundVolume,
    oledMode,
    audioCompression:
      window.localStorage.getItem("glint.playback.audioCompression") === "true",
  });
  const [activeMode, setActiveMode] = useState<PlayerMode | null>(null);
  const [activeNativeBackend, setActiveNativeBackend] =
    useState<NativeRenderBackend | null>(null);
  // Twitch-style floating mini player: the texture session keeps playing in a
  // small draggable corner canvas while the user browses other sections.
  const [miniPlayerActive, setMiniPlayerActive] = useState(false);
  const [miniPlayerPosition, setMiniPlayerPosition] = useState<
    { left: number; top: number } | null
  >(null);
  const [miniPlayerWidth, setMiniPlayerWidth] = useState(320);
  const miniPlayerDragOffset = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const miniPlayerRef = useRef<HTMLDivElement>(null);
  const [nativeAvailability, setNativeAvailability] =
    useState<NativePlayerAvailability | null>(null);
  const [nativeState, setNativeState] = useState<NativePlayerState>({
    status: "idle",
    paused: false,
    muted: false,
    volume: 100,
    compressorEnabled: false,
    behindLive: false,
    quality: "best",
  });
  const [multiStreamActive, setMultiStreamActive] = useState(false);
  const [multiTheater, setMultiTheater] = useState(false);
  const [multiTiles, setMultiTiles] = useState<MultiStreamTileState[]>([]);
  // Which tile's chat the tabbed Stream Chat is currently showing.
  const [multiChatChannel, setMultiChatChannel] = useState<string | null>(null);
  const [multiChatBroadcasterId, setMultiChatBroadcasterId] = useState<string | null>(null);
  // All tile channels stay connected at once; each keeps its own message buffer
  // so switching tabs is instant and nothing is missed in the background.
  const [multiChatBuffers, setMultiChatBuffers] = useState<Map<string, ChatMessage[]>>(new Map());
  const [multiChatStates, setMultiChatStates] = useState<
    Map<string, ChatConnectionState>
  >(new Map());
  const multiChatHost = useRef<HTMLDivElement>(null);
  const multiChatContent = useRef<HTMLDivElement>(null);
  const multiChatPinned = useRef(true);
  const multiChatUserScrollAt = useRef(0);
  const [multiChatPaused, setMultiChatPaused] = useState(false);
  // The selected chat tab, falling back to the active tile (or first) when the
  // held selection has no tile — derived rather than stored so no effect writes
  // it. A user tab click or tile activation still sets multiChatChannel.
  const effectiveMultiChatChannel = useMemo(() => {
    if (!multiStreamActive) return null;
    if (multiChatChannel && multiTiles.some((tile) => tile.channel === multiChatChannel)) {
      return multiChatChannel;
    }
    const fallback = multiTiles.find((tile) => tile.active) ?? multiTiles[0];
    return fallback ? fallback.channel : null;
  }, [multiStreamActive, multiChatChannel, multiTiles]);
  // The channel the chat pane (connection, emotes, badges, sending) follows:
  // the selected tab in multistream, otherwise the single watched channel.
  const chatChannel = multiStreamActive ? effectiveMultiChatChannel : activeChannel;
  const chatBroadcasterId = multiStreamActive
    ? multiChatBroadcasterId
    : (streamMetadata?.broadcasterId ?? null);
  const multiDisplayMessages = useMemo(
    () =>
      effectiveMultiChatChannel ? (multiChatBuffers.get(effectiveMultiChatChannel) ?? []) : [],
    [effectiveMultiChatChannel, multiChatBuffers],
  );
  const chatProviderEmotes = useMemo(() => {
    const combined = new Map<string, ProviderEmote>();
    // Channel sets win over global sets in each service; provider priority
    // follows the picker order so duplicate names resolve predictably.
    for (const provider of emoteProviders) {
      for (const emote of providerEmoteMaps.get(provider)?.values() ?? []) {
        if (!combined.has(emote.name)) combined.set(emote.name, emote);
      }
    }
    return combined;
  }, [providerEmoteMaps]);
  // Stable so the reply thread and user card can memoize their message rows;
  // an inline arrow would change identity every chat batch and defeat it.
  const renderCardText = useCallback(
    (message: ChatMessage) => renderChatMessageText(message, chatProviderEmotes),
    [chatProviderEmotes],
  );
  const playerHost = useRef<HTMLDivElement>(null);
  const chatHost = useRef<HTMLDivElement>(null);
  const chatInputHost = useRef<HTMLDivElement>(null);
  const chatComposerHost = useRef<HTMLFormElement>(null);
  const mentionSettings = useRef<{
    enabled: boolean;
    login: string;
    volume: number;
    soundId: MentionSoundId;
  }>({ enabled: false, login: "", volume: 70, soundId: "ping" });

  // Fires for every arriving message before batching; used only for the
  // mention alert. The feed engine (batching, scroll/pause, trimming) is
  // shared with the native overlay chat via this hook.
  const handleIncomingChatMessage = useCallback((message: ChatMessage) => {
    const mention = mentionSettings.current;
    if (
      mention.enabled &&
      !message.historical &&
      messageMentionsLogin(message, mention.login)
    ) {
      playMentionSound(mention.soundId, mention.volume);
    }
  }, []);
  const {
    messages: chatMessages,
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
  } = useChatFeed(handleIncomingChatMessage);
  const browseCategoryLoadSentinel = useRef<HTMLDivElement>(null);
  const categoryStreamLoadSentinel = useRef<HTMLDivElement>(null);
  const browseCategoryLoadPending = useRef(false);
  const categoryStreamLoadPending = useRef(false);
  const nativeControlsTimer = useRef<number | null>(null);
  const watchChannelGeneration = useRef(0);
  const lastPlayerPointerPosition = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!emotePickerOpen && !chatSettingsOpen) return;
    const closeOpenChatMenus = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        emotePickerOpen &&
        !target.closest(".emote-picker-anchor") &&
        !target.closest(".native-detached-emote-picker")
      ) {
        setEmotePickerOpen(false);
        if (activeMode === "native" && activeNativeBackend === "window") {
          window.desktop.player.setNativeEmotePicker(false);
        }
      }
      if (
        chatSettingsOpen &&
        !target.closest(".chat-overlay-tools") &&
        !target.closest(".chat-header-actions")
      ) {
        setChatSettingsOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOpenChatMenus, true);
    return () => document.removeEventListener("pointerdown", closeOpenChatMenus, true);
  }, [activeMode, activeNativeBackend, chatSettingsOpen, emotePickerOpen]);

  const revealNativeControls = useCallback(() => {
    if (!activeChannel || activeMode !== "native" || selectedChatUser) return;
    setNativeControlsVisible(true);
    if (nativeControlsTimer.current !== null) {
      window.clearTimeout(nativeControlsTimer.current);
    }
    nativeControlsTimer.current = window.setTimeout(
      () => setNativeControlsVisible(false),
      controlsHideDelay,
    );
  }, [activeChannel, activeMode, selectedChatUser, controlsHideDelay]);

  // Twitch-style: the controls belong to the video, so as soon as the pointer
  // leaves the player surface (onto chat, the toolbar, or off-window) they hide
  // immediately rather than waiting out the auto-hide delay.
  const hideNativeControls = useCallback(() => {
    if (nativeControlsTimer.current !== null) {
      window.clearTimeout(nativeControlsTimer.current);
      nativeControlsTimer.current = null;
    }
    setNativeControlsVisible(false);
  }, []);

  const activeChannelDisplayName =
    streamMetadata?.displayName ?? activeChannelIdentity?.displayName ?? activeChannel;

  // Where the user currently is, shown in the title bar and the window title.
  // Ordered by how specific each place is: a stream beats the section it was
  // opened from, and a chosen category beats Browse itself.
  const locationLabel = useMemo(() => {
    if (multiStreamActive) return "Multistream";
    if (activeChannel) return activeChannelDisplayName;
    if (activeSection === "settings") return "Settings";
    if (activeSection === "browse") return selectedBrowseCategory?.name ?? "Browse";
    return "Home";
  }, [
    activeChannel,
    activeChannelDisplayName,
    activeSection,
    multiStreamActive,
    selectedBrowseCategory,
  ]);

  useEffect(() => {
    document.title = `${locationLabel} - VioletWire`;
  }, [locationLabel]);

  useEffect(() => {
    window.desktop.player.setModalOpen(settingsOpen || topSearchOpen || changelogOpen);
  }, [changelogOpen, settingsOpen, topSearchOpen]);

  useEffect(() => {
    if (!settingsOpen && !changelogOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (changelogOpen) {
        setChangelogOpen(false);
        if (changelogReturnsToSettings) setSettingsOpen(true);
        setChangelogReturnsToSettings(false);
      } else {
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [changelogOpen, changelogReturnsToSettings, settingsOpen]);

  const loadNextBrowseCategories = useCallback(async () => {
    if (!browseCategoryCursor || browseCategoryLoadPending.current) return;
    browseCategoryLoadPending.current = true;
    setBrowseLoading(true);
    setBrowseError(null);
    const requestedCursor = browseCategoryCursor;
    try {
      const result = await window.desktop.twitch.getBrowseCategories(
        browseSearch,
        requestedCursor,
      );
      setBrowseCategories((current) => {
        const existingIds = new Set(current.map((category) => category.id));
        return [...current, ...result.items.filter((category) => !existingIds.has(category.id))];
      });
      setBrowseCategoryCursor(
        result.cursor && result.cursor !== requestedCursor ? result.cursor : undefined,
      );
    } catch (reason) {
      setBrowseError(
        reason instanceof Error ? reason.message : "Unable to load more Twitch categories.",
      );
    } finally {
      browseCategoryLoadPending.current = false;
      setBrowseLoading(false);
    }
  }, [browseCategoryCursor, browseSearch]);

  const loadNextCategoryStreams = useCallback(async () => {
    if (
      !selectedBrowseCategory ||
      !categoryStreamCursor ||
      categoryStreamLoadPending.current
    ) {
      return;
    }
    categoryStreamLoadPending.current = true;
    setCategoryStreamsLoading(true);
    setBrowseError(null);
    const requestedCursor = categoryStreamCursor;
    try {
      const result = await window.desktop.twitch.getCategoryStreams(
        selectedBrowseCategory.id,
        requestedCursor,
      );
      setCategoryStreams((current) => {
        const existingIds = new Set(current.map((stream) => stream.id));
        return [...current, ...result.items.filter((stream) => !existingIds.has(stream.id))];
      });
      setCategoryStreamCursor(
        result.cursor && result.cursor !== requestedCursor ? result.cursor : undefined,
      );
    } catch (reason) {
      setBrowseError(reason instanceof Error ? reason.message : "Unable to load more streams.");
    } finally {
      categoryStreamLoadPending.current = false;
      setCategoryStreamsLoading(false);
    }
  }, [categoryStreamCursor, selectedBrowseCategory]);

  useEffect(() => {
    if (!activeChannel || !playerHost.current) return;

    const syncPlayerBounds = () => {
      const bounds = playerHost.current?.getBoundingClientRect();
      if (!bounds || bounds.width < 1 || bounds.height < 1) return;
      window.desktop.player.setBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
        scale: window.devicePixelRatio || 1,
      });
    };

    const syncChatBounds = () => {
      const bounds = chatHost.current?.getBoundingClientRect();
      if (!bounds || bounds.width < 1 || bounds.height < 1) return;
      window.desktop.player.setChatBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    };

    window.desktop.player.setChatPresentation(chatPresentation);
    window.desktop.player.setChatVisible(chatVisible);
    const observer = new ResizeObserver(() => {
      syncPlayerBounds();
      if (chatVisible) syncChatBounds();
    });
    observer.observe(playerHost.current);
    if (chatHost.current) observer.observe(chatHost.current);
    window.addEventListener("resize", syncPlayerBounds);
    window.addEventListener("resize", syncChatBounds);
    syncPlayerBounds();
    if (chatVisible) syncChatBounds();

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncPlayerBounds);
      window.removeEventListener("resize", syncChatBounds);
    };
  }, [
    activeChannel,
    activeMode,
    chatOnLeft,
    chatPresentation,
    chatVisible,
    fullscreen,
    // The player page unmounts while the mini player floats; rebinding on
    // restore reattaches the observers to the freshly mounted hosts.
    miniPlayerActive,
    theaterMode,
  ]);

  useEffect(() => {
    void refreshNativeAvailability();
    const removeStateListener = window.desktop.player.onNativeState(setNativeState);
    const removeBackendListener =
      window.desktop.player.onNativeBackendChanged(setActiveNativeBackend);
    return () => {
      removeStateListener();
      removeBackendListener();
    };
  }, []);

  // Keep the multistream tile list in sync with the main process. Upsert each
  // tile by id, and drop tiles the manager reports removed.
  useEffect(() => {
    const removeState = window.desktop.player.onMultiTileState((tile) => {
      setMultiTiles((current) => {
        const next = current.filter((existing) => existing.id !== tile.id);
        next.push(tile);
        next.sort((left, right) => left.id - right.id);
        return next;
      });
    });
    const removeRemoved = window.desktop.player.onMultiTileRemoved((id) => {
      setMultiTiles((current) => current.filter((tile) => tile.id !== id));
    });
    return () => {
      removeState();
      removeRemoved();
    };
  }, []);

  // Load the selected tab's broadcaster id for its channel emotes/badges. The
  // messages themselves come from the always-connected per-channel buffers.
  useEffect(() => {
    if (!multiStreamActive || !effectiveMultiChatChannel) return;
    let cancelled = false;
    void window.desktop.twitch
      .getStreamMetadata(effectiveMultiChatChannel)
      .then((meta) => {
        if (!cancelled) setMultiChatBroadcasterId(meta?.broadcasterId ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [multiStreamActive, effectiveMultiChatChannel]);

  // Buffer every tile channel's chat. Messages are batched on a short interval
  // so busy channels don't re-render the app per message.
  const multiChatPending = useRef<Map<string, ChatMessage[]>>(new Map());
  // Listeners stay registered so no message is missed between starting
  // multistream and this effect running; they're idle when main isn't sending.
  useEffect(() => {
    const removeMessage = window.desktop.player.onMultiChatMessage((channel, message) => {
      const pending = multiChatPending.current;
      pending.set(channel, [...(pending.get(channel) ?? []), message]);
    });
    const removeState = window.desktop.player.onMultiChatState((channel, state) => {
      setMultiChatStates((current) => {
        const next = new Map(current);
        next.set(channel, state);
        return next;
      });
    });
    return () => {
      removeMessage();
      removeState();
    };
  }, []);

  // The batch flush only needs to tick while multistream is up — otherwise it
  // was firing every 150ms for the life of the app doing nothing.
  useEffect(() => {
    if (!multiStreamActive) return;
    const flush = window.setInterval(() => {
      if (multiChatPending.current.size === 0) return;
      const batch = multiChatPending.current;
      multiChatPending.current = new Map();
      setMultiChatBuffers((current) => {
        const next = new Map(current);
        for (const [channel, messages] of batch) {
          next.set(channel, applyChatMessageBatch(current.get(channel) ?? [], messages));
        }
        return next;
      });
    }, 150);
    return () => window.clearInterval(flush);
  }, [multiStreamActive]);

  const scrollMultiChatToBottom = useCallback(() => {
    const host = multiChatHost.current;
    if (host) host.scrollTop = host.scrollHeight;
    multiChatPinned.current = true;
    setMultiChatPaused(false);
  }, []);

  // Only a real wheel/pointer scroll pauses the feed. Programmatic scrolls (tab
  // switches, jump-to-bottom) and content-driven reflow (emote images loading)
  // must not — otherwise switching chats can leave it stuck "scrolled up".
  const handleMultiChatScroll = useCallback(() => {
    const host = multiChatHost.current;
    if (!host) return;
    const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 40;
    if (atBottom) {
      multiChatPinned.current = true;
      setMultiChatPaused(false);
      return;
    }
    if (Date.now() - multiChatUserScrollAt.current < 700) {
      multiChatPinned.current = false;
      setMultiChatPaused(true);
    }
  }, []);

  const noteMultiChatUserScroll = useCallback(() => {
    multiChatUserScrollAt.current = Date.now();
  }, []);

  // A new tab starts pinned to the newest message. Clear the paused state
  // directly (a short new chat may not fire a scroll event to clear it) and
  // drop any stale scroll intent so the first reflow can't re-pause it.
  useLayoutEffect(() => {
    multiChatPinned.current = true;
    multiChatUserScrollAt.current = 0;
    const host = multiChatHost.current;
    if (host) host.scrollTop = host.scrollHeight;
    const frame = requestAnimationFrame(() => setMultiChatPaused(false));
    return () => cancelAnimationFrame(frame);
  }, [effectiveMultiChatChannel]);

  // Keep the chat glued to the bottom while pinned even as content grows — new
  // messages and, crucially, late-loading emote/badge images that expand rows
  // after they first render (the naive "scroll on message" approach missed
  // these and left the view stuck above the newest line).
  useEffect(() => {
    if (!multiStreamActive) return;
    const host = multiChatHost.current;
    const content = multiChatContent.current;
    if (!host || !content) return;
    const observer = new ResizeObserver(() => {
      if (multiChatPinned.current) host.scrollTop = host.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [multiStreamActive, effectiveMultiChatChannel]);

  useEffect(
    () => window.desktop.player.onFullscreenChanged(setFullscreen),
    [],
  );

  useEffect(() => {
    let disposed = false;
    const applyPreferences = (preferences: AppPreferences) => {
      if (disposed) return;
      setPreferredMode(preferences.preferredPlayerMode);
      setExperimentalTexturePlayer(preferences.experimentalTexturePlayer);
      setChatTimestamps(preferences.chatTimestamps);
      setChatHistoryLimit(preferences.chatHistoryLimit);
      setChatFontSize(preferences.chatFontSize);
      setChatEmoteSize(preferences.chatEmoteSize);
      setChatDeletedMessageStyle(preferences.chatDeletedMessageStyle);
      setChatOnLeft(preferences.chatOnLeft);
      setFavoriteChannels(new Set(preferences.favoriteChannels));
      setControlsHideDelay(preferences.controlsHideDelay);
      // Seed the volume slider from the saved level while nothing is actively
      // playing, so the first stream opens showing it rather than 100%.
      setNativeState((current) =>
        current.status === "playing"
          ? current
          : { ...current, volume: preferences.playerVolume },
      );
      setSidebarCollapsed(preferences.sidebarCollapsed);
      setChatSidebarWidth(preferences.chatSidebarWidth);
      setChatOpacity(preferences.chatOverlayOpacity);
      setMentionSoundEnabled(preferences.mentionSoundEnabled);
      setMentionSoundVolume(preferences.mentionSoundVolume);
      setMentionSoundId(preferences.mentionSoundId);
      setOledMode(preferences.oledMode);
      setLastSeenChangelogVersion(preferences.lastSeenChangelogVersion);
      setPreferencesReady(true);
    };

    const removeListener = window.desktop.preferences.onChanged(applyPreferences);
    void window.desktop.preferences
      .getOrMigrate(legacyPreferences.current)
      .then(applyPreferences)
      .catch(() => setNotice("VioletWire could not load your saved settings."));
    return () => {
      disposed = true;
      removeListener();
    };
  }, []);

  useEffect(() => {
    if (!preferencesReady) return;
    const persistTimer = window.setTimeout(() => {
      void window.desktop.preferences
        .update({
          preferredPlayerMode: preferredMode,
          experimentalTexturePlayer,
          chatTimestamps,
          chatHistoryLimit,
          chatFontSize,
          chatEmoteSize,
          chatDeletedMessageStyle,
          chatOnLeft,
          controlsHideDelay,
          sidebarCollapsed,
          chatSidebarWidth,
          chatOverlayOpacity: chatOpacity,
          mentionSoundEnabled,
          mentionSoundVolume,
          mentionSoundId,
          oledMode,
        })
        .catch(() => undefined);
    }, 180);
    return () => window.clearTimeout(persistTimer);
  }, [
    chatHistoryLimit,
    chatFontSize,
    chatEmoteSize,
    chatDeletedMessageStyle,
    chatOnLeft,
    controlsHideDelay,
    sidebarCollapsed,
    chatSidebarWidth,
    chatOpacity,
    chatTimestamps,
    mentionSoundEnabled,
    mentionSoundVolume,
    mentionSoundId,
    oledMode,
    preferredMode,
    experimentalTexturePlayer,
    preferencesReady,
  ]);

  useEffect(() => {
    if (!preferencesReady) return;
    window.desktop.chat.setHistoryLimit(chatHistoryLimit);
  }, [chatHistoryLimit, preferencesReady]);

  const viewerLogin =
    authState.status === "signed-in" ? authState.account.login.toLowerCase() : "";

  useEffect(() => {
    mentionSettings.current = {
      enabled: mentionSoundEnabled,
      login: viewerLogin,
      volume: mentionSoundVolume,
      soundId: mentionSoundId,
    };
  }, [mentionSoundEnabled, mentionSoundVolume, mentionSoundId, viewerLogin]);

  useEffect(() => window.desktop.chat.onState(setChatConnectionState), []);

  useEffect(() => {
    const removePickerListener = window.desktop.player.onNativeEmotePicker(
      setEmotePickerOpen,
    );
    const removeSelectionListener = window.desktop.player.onNativeEmoteSelection((name) => {
      setChatInput((current) =>
        `${current}${current && !current.endsWith(" ") ? " " : ""}${name} `,
      );
      setEmotePickerOpen(false);
      window.requestAnimationFrame(() => chatInputHost.current?.focus());
    });
    return () => {
      removePickerListener();
      removeSelectionListener();
    };
  }, []);

  // Load a channel's emotes (global + channel sets) into the cache once and
  // return the bundle. Keyed by channel + broadcaster id so it refreshes when
  // the broadcaster id resolves after the login.
  const loadEmoteBundle = useCallback(
    async (channel: string, broadcasterId: string | null) => {
      const key = `${channel}|${broadcasterId ?? ""}`;
      const existing = emoteBundleCache.current.get(key);
      if (existing) return existing;
      const requests: Array<Promise<EmoteSetResult>> = [
        window.desktop.emotes.getSevenTvGlobal(),
        window.desktop.emotes.getFfzGlobal(),
        window.desktop.emotes.getBttvGlobal(),
      ];
      if (broadcasterId) {
        requests.push(
          window.desktop.emotes.getSevenTvChannel(broadcasterId),
          window.desktop.emotes.getFfzChannel(broadcasterId),
          window.desktop.emotes.getBttvChannel(broadcasterId),
        );
      }
      const results = await Promise.allSettled(requests);
      const maps = emptyProviderEmoteMaps();
      const names = emptyProviderChannelNames();
      for (const settled of results) {
        if (settled.status !== "fulfilled") continue;
        const result = settled.value;
        const providerMap = maps.get(result.provider) ?? new Map();
        for (const emote of result.emotes) {
          if (result.scope === "channel" || !providerMap.has(emote.name)) {
            providerMap.set(emote.name, emote);
          }
        }
        maps.set(result.provider, providerMap);
        if (result.scope === "channel") {
          names.set(result.provider, new Set(result.emotes.map((emote) => emote.name)));
        }
      }
      const bundle = { maps, names };
      emoteBundleCache.current.set(key, bundle);
      return bundle;
    },
    [],
  );

  const loadBadgeBundle = useCallback(async (channel: string) => {
    const existing = badgeBundleCache.current.get(channel);
    if (existing) return existing;
    const assets = await window.desktop.chat.getAssets(channel);
    const bundle = {
      badges: new Map(assets.badges.map((badge) => [badge.key, badge] as const)),
      picker: assets.emotes,
    };
    badgeBundleCache.current.set(channel, bundle);
    return bundle;
  }, []);

  useEffect(() => {
    if (!chatChannel) return;
    const cached = emoteBundleCache.current.get(`${chatChannel}|${chatBroadcasterId ?? ""}`);
    if (cached) {
      setProviderEmoteMaps(cached.maps);
      setProviderChannelNames(cached.names);
      return;
    }
    let cancelled = false;
    // Only clear when we actually have to fetch (first time for this channel);
    // cached channels above swap in instantly with no flash.
    setProviderEmoteMaps(emptyProviderEmoteMaps());
    setProviderChannelNames(emptyProviderChannelNames());
    void loadEmoteBundle(chatChannel, chatBroadcasterId).then((bundle) => {
      if (cancelled) return;
      setProviderEmoteMaps(bundle.maps);
      setProviderChannelNames(bundle.names);
    });
    return () => {
      cancelled = true;
    };
  }, [chatChannel, chatBroadcasterId, loadEmoteBundle]);

  useEffect(() => {
    if (!chatChannel || authState.status !== "signed-in") return;
    const cached = badgeBundleCache.current.get(chatChannel);
    if (cached) {
      setTwitchBadges(cached.badges);
      setTwitchPickerEmotes(cached.picker);
      return;
    }
    let cancelled = false;
    void loadBadgeBundle(chatChannel)
      .then((bundle) => {
        if (cancelled) return;
        setTwitchBadges(bundle.badges);
        setTwitchPickerEmotes(bundle.picker);
      })
      .catch(() => {
        if (!cancelled) {
          setTwitchBadges(new Map());
          setTwitchPickerEmotes([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chatChannel, authState.status, loadBadgeBundle]);

  // Multistream keeps all tabs' chats up, so warm every tile channel's emotes
  // and badges into the cache in the background. Switching tabs is then instant
  // with the right custom emotes, never unloading and refetching. Each channel
  // is warmed once — the effect re-runs as tiles update, but the guard skips
  // channels already fetched.
  const warmedChatChannels = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!multiStreamActive) return;
    let cancelled = false;
    for (const tile of multiTiles) {
      if (warmedChatChannels.current.has(tile.channel)) continue;
      warmedChatChannels.current.add(tile.channel);
      void window.desktop.twitch
        .getStreamMetadata(tile.channel)
        .then((meta) => {
          if (cancelled) return;
          void loadEmoteBundle(tile.channel, meta?.broadcasterId ?? null);
          if (authState.status === "signed-in") void loadBadgeBundle(tile.channel);
        })
        .catch(() => warmedChatChannels.current.delete(tile.channel));
    }
    return () => {
      cancelled = true;
    };
  }, [multiStreamActive, multiTiles, authState.status, loadEmoteBundle, loadBadgeBundle]);

  // The side chat now stays mounted while hidden. Messages that arrive while
  // it's hidden don't move its scroll, so re-pin to the newest on re-show if it
  // was following live.
  useEffect(() => {
    if (chatVisible && chatAutoScrollRef.current) {
      const frame = requestAnimationFrame(() => scrollChatToCurrent());
      return () => cancelAnimationFrame(frame);
    }
  }, [chatVisible, chatAutoScrollRef, scrollChatToCurrent]);

  const chatHistoryBoundary = chatMessages.reduce(
    (lastIndex, message, index) => (message.historical ? index : lastIndex),
    -1,
  );
  const chatMentionCandidates = useMemo(
    () => getChatMentionCandidates(chatMessages, "", 100),
    [chatMessages],
  );

  useEffect(() => {
    const input = chatInputHost.current;
    if (!input) return;
    input.style.height = "0px";
    const nextHeight = Math.min(Math.max(input.scrollHeight, 43), 130);
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > 130 ? "auto" : "hidden";
  }, [chatInput]);

  useEffect(() => {
    const composer = chatComposerHost.current;
    const chat = composer?.closest<HTMLElement>(".native-chat");
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
  }, [activeChannel, chatPresentation, chatVisible]);

  const beginReply = useCallback((message: ChatMessage) => {
    setReplyingTo(message);
    window.requestAnimationFrame(() => chatInputHost.current?.focus());
  }, []);

  // While minimized, have the addon render at the mini box's actual pixel
  // size: the full-page buffer has a different aspect ratio, which baked
  // letterbox bars into the frames and left the box partly unfilled.
  useEffect(() => {
    if (!miniPlayerActive || activeNativeBackend !== "texture") return;
    const host = miniPlayerRef.current;
    if (!host) return;
    const syncMiniBounds = () => {
      const rect = host.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      window.desktop.player.setBounds({
        x: 0,
        y: 0,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        scale: window.devicePixelRatio || 1,
      });
    };
    const observer = new ResizeObserver(syncMiniBounds);
    observer.observe(host);
    syncMiniBounds();
    return () => observer.disconnect();
  }, [activeNativeBackend, miniPlayerActive]);

  // Hover-intent stream pre-resolution: after 150ms on a channel card, ask
  // the main process to resolve its stream URL so a click skips the
  // Streamlink round trip. The main process dedups and caps concurrency, so
  // stray hovers are cheap.
  const preresolveTimer = useRef<number | null>(null);
  const schedulePreresolve = useCallback((login: string) => {
    if (preresolveTimer.current !== null) window.clearTimeout(preresolveTimer.current);
    preresolveTimer.current = window.setTimeout(() => {
      preresolveTimer.current = null;
      window.desktop.player.preresolveStream(login);
    }, 150);
  }, []);
  const cancelPreresolve = useCallback(() => {
    if (preresolveTimer.current !== null) {
      window.clearTimeout(preresolveTimer.current);
      preresolveTimer.current = null;
    }
  }, []);
  const refreshChangelogEntries = useCallback(async (forceRefresh = false) => {
    await window.desktop.updates
      .getReleaseNotes(forceRefresh)
      .then((markdown) => {
        if (!markdown) return;
        const remoteEntries = parseChangelog(markdown);
        if (remoteEntries.length === 0) return;
        setChangelogEntries(
          mergeChangelogEntries(remoteEntries, bundledChangelogEntries),
        );
      })
      .catch(() => undefined);
  }, []);

  const openChatUserCard = useCallback((message: ChatMessage, anchor: DOMRect) => {
    setSelectedChatUser(message);
    setSelectedChatUserAnchor(anchor);
    // Native controls are a separate transparent BrowserWindow. A DOM
    // z-index cannot rise above it, so temporarily lower that overlay while
    // this card (which is rendered in the main window) is open.
    if (activeMode === "native" && activeNativeBackend === "window") {
      window.desktop.player.setNativeControlsVisible(false);
      setNativeControlsVisible(false);
    }
  }, [activeMode, activeNativeBackend]);

  function toggleOledMode(): void {
    setOledMode((current) => !current);
  }

  function openChangelog(returnToSettings = false): void {
    void refreshChangelogEntries(true);
    setChangelogReturnsToSettings(returnToSettings);
    setSettingsOpen(false);
    setChangelogOpen(true);
    if (updateStatus.currentVersion) {
      void window.desktop.preferences
        .update({ lastSeenChangelogVersion: updateStatus.currentVersion })
        .catch(() => undefined);
    }
  }

  function closeChangelog(): void {
    setChangelogOpen(false);
    if (changelogReturnsToSettings) {
      setSettingsOpen(true);
    }
    setChangelogReturnsToSettings(false);
  }

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

  // Side-chat width drag. The width lives in a CSS variable that both the
  // player toolbar and the viewer layout grid read, so the two stay aligned.
  // During drag the variable is written straight to the DOM (no React render
  // per move); state and the persisted preference update only on release.
  function beginChatResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const layout = playerPageRef.current?.querySelector<HTMLElement>(".viewer-layout");
    if (!layout) return;
    const rect = layout.getBoundingClientRect();
    chatResizeState.current = { layoutLeft: rect.left, layoutRight: rect.right };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    setChatResizing(true);
  }

  function clampChatWidth(desired: number, layoutWidth: number): number {
    // Never starve the video below its 400px minimum, and keep the drag within
    // the schema's persisted bounds.
    const max = Math.min(620, Math.max(300, layoutWidth - 420));
    return Math.round(Math.min(max, Math.max(300, desired)));
  }

  function updateChatResize(event: React.PointerEvent<HTMLDivElement>) {
    const bounds = chatResizeState.current;
    const page = playerPageRef.current;
    if (!bounds || !page) return;
    const layoutWidth = bounds.layoutRight - bounds.layoutLeft;
    const desired = chatOnLeft
      ? event.clientX - bounds.layoutLeft
      : bounds.layoutRight - event.clientX;
    page.style.setProperty("--chat-sidebar-width", `${clampChatWidth(desired, layoutWidth)}px`);
  }

  function endChatResize(event: React.PointerEvent<HTMLDivElement>) {
    if (!chatResizeState.current) return;
    chatResizeState.current = null;
    setChatResizing(false);
    const value = playerPageRef.current?.style.getPropertyValue("--chat-sidebar-width");
    const parsed = value ? Number.parseInt(value, 10) : NaN;
    if (Number.isFinite(parsed)) setChatSidebarWidth(parsed);
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  useEffect(() => {
    void loadAuthState();
    void window.desktop.twitch.getPlaybackSessionState().then(setPlaybackSession);
    void window.desktop.updates.getStatus().then(setUpdateStatus);
    void refreshChangelogEntries();
    return window.desktop.updates.onStatus(setUpdateStatus);
  }, [refreshChangelogEntries]);

  // Auto-open the changelog once per release. The seen-version lives in the
  // main-process preferences file because the packaged renderer's localStorage
  // is wiped by its per-launch random origin.
  useEffect(() => {
    if (changelogAutoShown.current || !preferencesReady) return;
    const currentVersion = updateStatus.currentVersion;
    if (updateStatus.state === "disabled" || !currentVersion) return;
    changelogAutoShown.current = true;
    if (lastSeenChangelogVersion === currentVersion) return;
    let cancelled = false;
    void (async () => {
      // A cached GitHub response can be one release behind immediately after
      // an install. Resolve a fresh set of release notes before opening the
      // automatic modal so it never flashes stale notes and then changes only
      // when the user opens it manually.
      await refreshChangelogEntries(true);
      if (cancelled) return;
      await window.desktop.preferences
        .update({ lastSeenChangelogVersion: currentVersion })
        .catch(() => undefined);
      if (!cancelled) {
        setChangelogReturnsToSettings(false);
        setChangelogOpen(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    lastSeenChangelogVersion,
    preferencesReady,
    refreshChangelogEntries,
    updateStatus.currentVersion,
    updateStatus.state,
  ]);

  useEffect(
    () =>
      window.desktop.player.onChannelActionState((action, state) => {
        if (action === "subscribe") setSubscriptionDrawerState(state);
      }),
    [],
  );

  useEffect(() => {
    if (authState.status !== "signed-in") return;
    void loadFollowedChannels();
    // Keep the followed sidebar and home grid current: channels go live and
    // offline all the time. Background failures stay silent — a transient
    // refresh error must not surface a notice every minute.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void loadFollowedChannels({ silent: true });
    }, 60_000);
    const refreshOnReturn = () => {
      if (document.visibilityState === "visible") {
        void loadFollowedChannels({ silent: true });
      }
    };
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [authState.status]);

  useEffect(() => {
    const query = channelInput.trim();
    if (authState.status !== "signed-in" || query.length < 2 || !topSearchOpen) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.desktop.twitch
        .search(query)
        .then((results) => {
          if (!cancelled) setTopSearchResults(results);
        })
        .catch(() => {
          if (!cancelled) setTopSearchResults(emptySearchResults);
        })
        .finally(() => {
          if (!cancelled) setTopSearchLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [authState.status, channelInput, topSearchOpen]);

  useEffect(() => {
    if (
      activeSection === "browse" &&
      authState.status === "signed-in" &&
      !selectedBrowseCategory &&
      browseCategories.length === 0
    ) {
      let cancelled = false;
      void window.desktop.twitch
        .getBrowseCategories()
        .then((result) => {
          if (cancelled) return;
          setBrowseCategories(result.items);
          setBrowseCategoryCursor(result.cursor);
        })
        .catch((reason: unknown) => {
          if (!cancelled) {
            setBrowseError(
              reason instanceof Error ? reason.message : "Unable to load Twitch categories.",
            );
          }
        })
        .finally(() => {
          if (!cancelled) setBrowseLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, [activeSection, authState.status, browseCategories.length, selectedBrowseCategory]);

  useEffect(() => {
    const sentinel = browseCategoryLoadSentinel.current;
    if (
      !sentinel ||
      activeSection !== "browse" ||
      selectedBrowseCategory ||
      !browseCategoryCursor
    ) {
      return;
    }
    let timer: number | null = null;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || browseCategoryLoadPending.current) return;
        observer.disconnect();
        timer = window.setTimeout(() => void loadNextBrowseCategories(), 220);
      },
      {
        root: sentinel.closest(".browse-page"),
        rootMargin: "320px 0px",
      },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    activeSection,
    browseCategoryCursor,
    loadNextBrowseCategories,
    selectedBrowseCategory,
  ]);

  useEffect(() => {
    const sentinel = categoryStreamLoadSentinel.current;
    if (
      !sentinel ||
      activeSection !== "browse" ||
      !selectedBrowseCategory ||
      !categoryStreamCursor
    ) {
      return;
    }
    let timer: number | null = null;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || categoryStreamLoadPending.current) return;
        observer.disconnect();
        timer = window.setTimeout(() => void loadNextCategoryStreams(), 220);
      },
      {
        root: sentinel.closest(".browse-page"),
        rootMargin: "320px 0px",
      },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    activeSection,
    categoryStreamCursor,
    loadNextCategoryStreams,
    selectedBrowseCategory,
  ]);

  useEffect(() => {
    if (!activeChannel || authState.status !== "signed-in") return;
    let cancelled = false;
    void window.desktop.twitch
      .getStreamMetadata(activeChannel)
      .then((metadata) => {
        if (!cancelled) setStreamMetadata(metadata);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          const message = reason instanceof Error ? reason.message : String(reason);
          setNotice(`Channel information unavailable: ${message}`);
        }
      });
    const refresh = window.setInterval(() => {
      void window.desktop.twitch.getStreamMetadata(activeChannel).then((metadata) => {
        if (!cancelled) setStreamMetadata(metadata);
      }).catch(() => undefined);
      // 30s keeps the "stream ended" detection reasonably prompt without
      // hammering Helix; mpv itself won't reliably report a live stream ending.
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(refresh);
    };
  }, [activeChannel, authState.status]);

  useEffect(() => {
    if (nativeControlsTimer.current !== null) {
      window.clearTimeout(nativeControlsTimer.current);
      nativeControlsTimer.current = null;
    }

    if (!activeChannel || activeMode !== "native") return;

    nativeControlsTimer.current = window.setTimeout(
      () => setNativeControlsVisible(false),
      controlsHideDelay,
    );
    return () => {
      if (nativeControlsTimer.current !== null) {
        window.clearTimeout(nativeControlsTimer.current);
        nativeControlsTimer.current = null;
      }
    };
  }, [activeChannel, activeMode, controlsHideDelay]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  // One shared tick keeps every visible uptime label fresh without a per-card
  // interval — but only while a label can actually be on screen. It re-renders
  // the whole app, so it must not run when nothing is live and nothing is open.
  const hasLiveFollowedChannel = followedChannels.some((channel) => channel.isLive);
  useEffect(() => {
    if (!activeChannel && !hasLiveFollowedChannel) return;
    const timer = window.setInterval(() => setUptimeNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [activeChannel, hasLiveFollowedChannel]);

  useEffect(() => {
    // Player shortcuts must not fire while the player is minimized to the
    // floating mini view and the user is browsing.
    if (!activeChannel || miniPlayerActive) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          'input, textarea, select, button, a, [contenteditable="true"], [role="textbox"], [role="menu"], [role="dialog"]',
        )
      ) {
        return;
      }
      revealNativeControls();

      if (event.key.toLowerCase() === "t") {
        setTheaterMode((current) => !current);
      } else if (event.key.toLowerCase() === "c") {
        setChatLayout(chatVisible ? "hidden" : "side");
      } else if (event.key.toLowerCase() === "f") {
        void setFullscreenMode(!fullscreen);
      } else if (event.code === "Space" && activeMode === "native") {
        event.preventDefault();
        window.desktop.player.controlNative({
          command: nativeState.paused ? "go-live" : "toggle-pause",
        });
      } else if (event.key.toLowerCase() === "m" && activeMode === "native") {
        window.desktop.player.controlNative({ command: "toggle-mute" });
      } else if (event.key === "Escape" && fullscreen) {
        void setFullscreenMode(false);
      } else if (event.key === "Escape" && theaterMode) {
        setTheaterMode(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activeChannel,
    activeMode,
    chatVisible,
    fullscreen,
    miniPlayerActive,
    nativeState.paused,
    revealNativeControls,
    theaterMode,
  ]);

  // Multistream shortcuts: T = theater, F = fullscreen. Same guards as the
  // single player — ignore modifier combos (Alt+F etc.) and keys typed into
  // chat inputs, buttons, and other interactive controls.
  useEffect(() => {
    if (!multiStreamActive) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
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
        setMultiTheater((current) => !current);
      } else if (key === "f") {
        void window.desktop.player.setFullscreen(!fullscreen);
      } else if (event.key === "Escape" && fullscreen) {
        void window.desktop.player.setFullscreen(false);
      } else if (event.key === "Escape" && multiTheater) {
        setMultiTheater(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [multiStreamActive, fullscreen, multiTheater]);

  useEffect(() => {
    if (!activeChannel || activeMode !== "native") {
      window.desktop.player.setNativeControlsVisible(false);
      return;
    }
    window.desktop.player.setNativeControlsContext({
      channel: activeChannel,
      fullscreen,
      theaterMode,
      chatVisible,
      chatPresentation,
      viewerLogin,
    });
    window.desktop.player.setNativeControlsVisible(nativeControlsVisible);
  }, [
    activeChannel,
    activeMode,
    chatPresentation,
    chatVisible,
    fullscreen,
    nativeControlsVisible,
    theaterMode,
    viewerLogin,
  ]);

  useEffect(
    () =>
      window.desktop.player.onNativeControlAction((action) => {
        if (action === "activity" && !selectedChatUser) {
          revealNativeControls();
        } else if (action === "toggle-theater") {
          setTheaterMode((current) => !current);
        } else if (action === "toggle-fullscreen") {
          void setFullscreenMode(!fullscreen);
        } else if (action === "hide-chat") {
          setChatLayout("hidden");
        } else if (action === "side-chat") {
          setChatLayout("side");
        } else if (action === "overlay-chat") {
          setChatLayout("overlay");
        }
      }),
    [fullscreen, revealNativeControls, selectedChatUser],
  );

  async function refreshNativeAvailability() {
    const availability = await window.desktop.player.getNativeAvailability();
    setNativeAvailability(availability);
  }

  async function savePreferredMode(mode: PlayerMode): Promise<boolean> {
    setPreferredMode(mode);
    try {
      await window.desktop.preferences.update({ preferredPlayerMode: mode });
      return true;
    } catch {
      setNotice("VioletWire could not save the playback engine setting.");
      return false;
    }
  }

  async function choosePreferredMode(mode: PlayerMode) {
    if (!(await savePreferredMode(mode))) return;
    if (mode === "native" && nativeAvailability && !nativeAvailability.available) {
      setNotice(
        `Native is now the default, but it will fall back to Standard until ${nativeAvailability.reason ?? "its dependencies are available"}`,
      );
    } else {
      setNotice(
        mode === "native"
          ? "Native Experimental will be used when you open the next stream."
          : "Standard Twitch playback will be used when you open the next stream.",
      );
    }
  }

  async function loadAuthState() {
    setAuthBusy(true);
    try {
      setAuthState(await window.desktop.twitch.getAuthState());
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Unable to read Twitch sign-in.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function loadFollowedChannels(options?: { silent?: boolean }) {
    try {
      setFollowedChannels(await window.desktop.twitch.getFollowedChannels());
    } catch (reason) {
      if (options?.silent) return;
      setNotice(reason instanceof Error ? reason.message : "Unable to load followed channels.");
    }
  }

  async function loadBrowseCategories(query: string, append: boolean) {
    if (authState.status !== "signed-in") return;
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const result = await window.desktop.twitch.getBrowseCategories(
        query,
        append ? browseCategoryCursor : undefined,
      );
      setBrowseCategories((current) => append ? [...current, ...result.items] : result.items);
      setBrowseCategoryCursor(result.cursor);
    } catch (reason) {
      setBrowseError(reason instanceof Error ? reason.message : "Unable to load Twitch categories.");
    } finally {
      setBrowseLoading(false);
    }
  }

  function searchBrowseCategories(event: FormEvent) {
    event.preventDefault();
    setSelectedBrowseCategory(null);
    setCategoryStreams([]);
    setCategoryStreamCursor(undefined);
    void loadBrowseCategories(browseSearch, false);
  }

  async function openBrowseCategory(category: BrowseCategory) {
    setSelectedBrowseCategory(category);
    setCategoryStreams([]);
    setCategoryStreamCursor(undefined);
    setCategoryStreamsLoading(true);
    setBrowseError(null);
    try {
      const result = await window.desktop.twitch.getCategoryStreams(category.id);
      setCategoryStreams(result.items);
      setCategoryStreamCursor(result.cursor);
    } catch (reason) {
      setBrowseError(
        reason instanceof Error ? reason.message : `Unable to load ${category.name} streams.`,
      );
    } finally {
      setCategoryStreamsLoading(false);
    }
  }

  async function beginSignIn() {
    if (authState.status === "unconfigured") {
      setSettingsOpen(true);
      setNotice("Add your Twitch developer Client ID, then sign in.");
      return;
    }
    setAuthBusy(true);
    try {
      const device = await window.desktop.twitch.beginSignIn();
      setDeviceAuthorization(device);
      setCopiedCode(false);
      const signedIn = await window.desktop.twitch.completeSignIn();
      setAuthState(signedIn);
      setDeviceAuthorization(null);
      setNotice("Signed in with Twitch.");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (!message.toLowerCase().includes("cancel")) setNotice(message || "Twitch sign-in failed.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function cancelSignIn() {
    await window.desktop.twitch.cancelSignIn();
    setDeviceAuthorization(null);
    setAuthBusy(false);
  }

  async function signOut() {
    setAuthBusy(true);
    try {
      setAuthState(await window.desktop.twitch.signOut());
      setFollowedChannels([]);
      setStreamMetadata(null);
      setNotice("Signed out and removed saved Twitch credentials.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function linkPlaybackSession() {
    setPlaybackSessionBusy(true);
    setNotice(
      "Sign in only in the dedicated Twitch window. The isolated session is shared with the Standard player and used for Twitch playback requests.",
    );
    try {
      const state = await window.desktop.twitch.linkPlaybackSession();
      setPlaybackSession(state);
      setNotice(
        state.linked
          ? "Twitch website playback session linked. Restart the current stream to use it."
          : "Playback session was not linked.",
      );
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Unable to link the playback session.");
    } finally {
      setPlaybackSessionBusy(false);
    }
  }

  async function unlinkPlaybackSession() {
    setPlaybackSessionBusy(true);
    try {
      setPlaybackSession(await window.desktop.twitch.unlinkPlaybackSession());
      setNotice("Playback token, cookies, and isolated Twitch website storage were removed.");
    } finally {
      setPlaybackSessionBusy(false);
    }
  }

  async function testSevenTv() {
    setSevenTvBusy(true);
    try {
      const result = await window.desktop.emotes.getSevenTvGlobal();
      setSevenTvStatus(result);
      setNotice(`7TV is available: ${result.emotes.length.toLocaleString()} global emotes loaded.`);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "7TV is currently unavailable.");
    } finally {
      setSevenTvBusy(false);
    }
  }

  function setChatLayout(layout: ChatLayout) {
    if (layout === "hidden") {
      setChatVisible(false);
      window.desktop.player.setChatVisible(false);
      return;
    }

    setChatPresentation(layout);
    setChatVisible(true);
    window.desktop.player.setChatPresentation(layout);
    window.desktop.player.setChatVisible(true);
  }

  async function openChannel(event: FormEvent) {
    event.preventDefault();
    setTopSearchOpen(false);
    const normalizedLogin = channelInput.trim().toLowerCase();
    await watchChannel(
      channelInput,
      topSearchResults.channels.find((channel) => channel.login.toLowerCase() === normalizedLogin),
    );
  }

  function updateTopSearch(value: string) {
    setChannelInput(value);
    const canSearch = authState.status === "signed-in" && value.trim().length >= 2;
    setTopSearchOpen(canSearch);
    setTopSearchLoading(canSearch);
    if (!canSearch) setTopSearchResults(emptySearchResults);
  }

  async function chooseSearchCategory(category: BrowseCategory) {
    setTopSearchOpen(false);
    setChannelInput("");
    leaveMultiStream();
    if (activeChannel) await closePlayer();
    setActiveSection("browse");
    await openBrowseCategory(category);
  }

  async function chooseStreamCategory() {
    const metadata = streamMetadata;
    if (!metadata?.categoryId || !metadata.category) return;

    try {
      let category = browseCategories.find((item) => item.id === metadata.categoryId);
      if (!category) {
        const result = await window.desktop.twitch.getBrowseCategories(metadata.category);
        category = result.items.find((item) => item.id === metadata.categoryId);
      }
      category ??= {
        id: metadata.categoryId,
        name: metadata.category,
        boxArtUrl: `https://static-cdn.jtvnw.net/ttv-boxart/${encodeURIComponent(metadata.categoryId)}-570x760.jpg`,
      };

      await closePlayer();
      setActiveSection("browse");
      await openBrowseCategory(category);
    } catch (reason) {
      setNotice(
        reason instanceof Error
          ? reason.message
          : `Unable to open the ${metadata.category} category.`,
      );
    }
  }

  function chooseSearchChannel(channel: SearchChannelResult) {
    setTopSearchOpen(false);
    void watchChannel(channel.login, channel);
  }

  async function watchChannel(
    channel: string,
    identity?: ChannelNavigationIdentity,
  ) {
    // Opening a single stream replaces multistream rather than layering over it.
    leaveMultiStream();
    // Re-clicking the channel that is already playing must not restart or
    // reset anything (metadata, chat, player) — just surface the full player.
    if (activeChannel && activeChannel === channel.trim().toLowerCase()) {
      setSettingsOpen(false);
      restoreMiniPlayer();
      return;
    }
    const generation = ++watchChannelGeneration.current;
    const returnSection = activeChannel ? playerReturnSection : activeSection;
    const optimisticMode = preferredMode;
    const optimisticBackend =
      optimisticMode === "native"
        ? experimentalTexturePlayer
          ? "texture"
          : "window"
        : null;
    setSettingsOpen(false);
    setError(null);
    setStreamMetadata(null);
    resetChatFeed();
    setReplyingTo(null);
    setEmotePickerOpen(false);
    setMiniPlayerActive(false);
    // Mount the player shell immediately so clicking a card feels instant and
    // the texture receiver has a canvas before Streamlink finishes resolving.
    setPlayerReturnSection(returnSection);
    setActiveSection("home");
    setActiveChannel(channel);
    setActiveMode(optimisticMode);
    setActiveNativeBackend(optimisticBackend);
    setNativeControlsVisible(true);
    setChatVisible(true);
    setChatPresentation("side");
    setTheaterMode(false);
    setActiveChannelIdentity(
      identity ??
        followedChannels.find(
          (followedChannel) => followedChannel.login.toLowerCase() === channel.trim().toLowerCase(),
        ),
    );
    try {
      const savedPreferences = await window.desktop.preferences.getOrMigrate();
      if (generation !== watchChannelGeneration.current) return;
      setActiveMode(savedPreferences.preferredPlayerMode);
      setActiveNativeBackend(
        savedPreferences.preferredPlayerMode === "native"
          ? savedPreferences.experimentalTexturePlayer
            ? "texture"
            : "window"
          : null,
      );
      const result = await window.desktop.player.open(
        channel,
        savedPreferences.preferredPlayerMode,
      );
      if (generation !== watchChannelGeneration.current) return;
      setActiveChannel(result.channel);
      setActiveMode(result.mode);
      setActiveNativeBackend(result.nativeBackend ?? null);
      setNativeControlsVisible(true);
      setChatVisible(true);
      setChatPresentation("side");
      setTheaterMode(false);
      if (result.fallbackReason) {
        setNotice(
          result.mode === "native"
            ? result.fallbackReason
            : `Native player unavailable: ${result.fallbackReason} Using the official player.`,
        );
      }
    } catch (reason) {
      if (generation !== watchChannelGeneration.current) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      setActiveChannel(null);
      setActiveChannelIdentity(undefined);
      setActiveMode(null);
      setActiveNativeBackend(null);
      setActiveSection(returnSection);
      setError(message || "Unable to open the Twitch player.");
    }
  }

  async function closePlayer(returnToSection = true) {
    watchChannelGeneration.current += 1;
    if (activeMode === "native") window.desktop.player.setNativeEmotePicker(false);
    const exitFullscreen = fullscreen;
    // Unmount the player page before the IPC teardown: the main process
    // pushes intermediate "idle" states while retiring the session, and
    // awaiting first repaints the loading surface for the round-trip time.
    setFullscreen(false);
    setTheaterMode(false);
    setActiveChannel(null);
    setActiveMode(null);
    setActiveNativeBackend(null);
    setReplyingTo(null);
    setEmotePickerOpen(false);
    setMiniPlayerActive(false);
    setMiniPlayerPosition(null);
    if (returnToSection) setActiveSection(playerReturnSection);
    if (exitFullscreen) await window.desktop.player.setFullscreen(false);
    await window.desktop.player.close();
  }

  function restoreMiniPlayer() {
    setMiniPlayerActive(false);
    setActiveSection("home");
  }

  async function enterMultiStream() {
    // Carry the currently-watched channel in as the first tile, if any.
    const seed = activeChannel ? [activeChannel] : [];
    // Tear down the single-player renderer state; the main process frees its
    // mpv session as part of multiStart.
    setMiniPlayerActive(false);
    setMiniPlayerPosition(null);
    setActiveChannel(null);
    setActiveMode(null);
    setActiveNativeBackend(null);
    setFullscreen(false);
    setTheaterMode(false);
    setEmotePickerOpen(false);
    setMultiStreamActive(true);
    setMultiTiles(await window.desktop.player.multiStart(seed));
  }

  // Tear down multistream without navigating — used both by the explicit exit
  // and whenever another view (opening a stream, Home/Browse) takes over.
  function leaveMultiStream() {
    if (!multiStreamActive) return;
    window.desktop.player.multiStop();
    setMultiTiles([]);
    setMultiChatChannel(null);
    setMultiStreamActive(false);
    setMultiTheater(false);
    // Start the next session with clean chat buffers.
    multiChatPending.current = new Map();
    setMultiChatBuffers(new Map());
    setMultiChatStates(new Map());
  }

  function exitMultiStream() {
    leaveMultiStream();
    setActiveSection("home");
  }

  async function addMultiTile(channel: string) {
    const tile = await window.desktop.player.multiAddTile(channel);
    if (!tile) return;
    setMultiTiles((current) => {
      const next = current.filter((existing) => existing.id !== tile.id);
      next.push(tile);
      next.sort((left, right) => left.id - right.id);
      return next;
    });
  }

  function removeMultiTile(id: number) {
    window.desktop.player.multiRemoveTile(id);
    setMultiTiles((current) => current.filter((tile) => tile.id !== id));
  }

  function activateMultiTile(id: number) {
    window.desktop.player.multiSetActive(id);
    // Moving audio focus to a tile also switches its chat into view.
    const tile = multiTiles.find((entry) => entry.id === id);
    if (tile) setMultiChatChannel(tile.channel);
  }

  function nameForChannel(login: string): string {
    return followedChannels.find((channel) => channel.login === login)?.displayName ?? login;
  }

  async function navigateTo(section: AppSection) {
    if (section === "settings") {
      setSettingsOpen(true);
      return;
    }
    setSettingsOpen(false);
    // Home/Browse leave multistream rather than sitting behind it.
    leaveMultiStream();
    if (activeChannel && !miniPlayerActive) {
      // The embedded texture player keeps running as a floating mini player
      // while browsing, exactly because its video is an in-page canvas. The
      // window-hosted and official players cannot follow the page, so they
      // still close on navigation.
      if (activeMode === "native" && activeNativeBackend === "texture") {
        setMiniPlayerActive(true);
        if (fullscreen) await window.desktop.player.setFullscreen(false);
        setFullscreen(false);
        setTheaterMode(false);
        setEmotePickerOpen(false);
      } else {
        await closePlayer(false);
      }
    }
    if (section === "browse" && activeSection === "browse") {
      setSelectedBrowseCategory(null);
      setCategoryStreams([]);
      setCategoryStreamCursor(undefined);
      setBrowseError(null);
    }
    setActiveSection(section);
  }

  async function switchPlayerMode(mode: PlayerMode) {
    if (!(await savePreferredMode(mode))) return;
    if (!activeChannel || mode === activeMode) return;

    try {
      const result = await window.desktop.player.open(activeChannel, mode);
      setActiveMode(result.mode);
      setActiveNativeBackend(result.nativeBackend ?? null);
      setNativeControlsVisible(true);
      if (result.fallbackReason) {
        setNotice(
          result.mode === "native"
            ? result.fallbackReason
            : `Native player unavailable: ${result.fallbackReason} Using the official player.`,
        );
      } else {
        setNotice(mode === "native" ? "Experimental native player started." : "Official player restored.");
      }
    } catch {
      setNotice("Unable to switch player modes.");
    }
  }

  async function retryNativePlayer() {
    if (!activeChannel) return;
    const result = await window.desktop.player.open(activeChannel, "native", nativeState.quality);
    setActiveMode(result.mode);
    setActiveNativeBackend(result.nativeBackend ?? null);
    setNativeControlsVisible(true);
    if (result.fallbackReason) setNotice(result.fallbackReason);
  }

  async function setFullscreenMode(nextFullscreen: boolean) {
    try {
      const actualState = await window.desktop.player.setFullscreen(nextFullscreen);
      setFullscreen(actualState);
      setNativeControlsVisible(true);
    } catch {
      setNotice("Unable to change fullscreen mode.");
    }
  }

  async function openChannelAction(action: "channel" | "subscribe" | "clip", label: string) {
    if (!activeChannel) return;
    try {
      await window.desktop.player.openChannelAction(activeChannel, action);
      if (authState.status === "signed-in") {
        setStreamMetadata(await window.desktop.twitch.getStreamMetadata(activeChannel));
      }
      if (action !== "subscribe") {
        setNotice(`${label} opened in VioletWire's isolated Twitch window.`);
      }
    } catch {
      setNotice(`Unable to open ${label.toLowerCase()}.`);
    }
  }

  async function openChannelInBrowser() {
    if (!activeChannel) return;
    try {
      await window.desktop.twitch.openChannel(activeChannel);
      setNotice("Opened the channel in your default browser.");
    } catch {
      setNotice("Unable to open the channel in your browser.");
    }
  }

  async function handleFollow() {
    if (!activeChannel) return;
    await window.desktop.player.openChannelAction(activeChannel, "channel");
    if (authState.status === "signed-in") {
      setStreamMetadata(await window.desktop.twitch.getStreamMetadata(activeChannel));
    }
    setNotice(
      streamMetadata?.isFollowed
        ? "This channel is already followed. Twitch opened in VioletWire."
        : "Use Twitch's Follow button in the VioletWire popup. Close it when finished.",
    );
  }

  async function createClip() {
    if (!activeChannel) return;
    if (authState.status !== "signed-in") {
      await beginSignIn();
      return;
    }
    setNotice("Creating a clip at the current live moment…");
    try {
      await window.desktop.twitch.createClip(activeChannel);
      setNotice("Clip created. Twitch's editor opened in your browser.");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Unable to create this clip.");
    }
  }

  async function sendChatMessage(event: FormEvent) {
    event.preventDefault();
    if (!chatChannel || !chatInput.trim()) return;
    if (authState.status !== "signed-in") {
      setNotice("Sign in with Twitch to send chat messages.");
      return;
    }
    const message = chatInput.trim();
    const replyTarget = replyingTo;
    setChatInput("");
    setReplyingTo(null);
    try {
      await window.desktop.chat.send(chatChannel, message, replyTarget?.id);
    } catch (reason) {
      setChatInput(message);
      setReplyingTo(replyTarget);
      setNotice(reason instanceof Error ? reason.message : "Unable to send the chat message.");
    }
  }

  const liveFollowedChannels = useMemo(
    () => followedChannels.filter((channel) => channel.isLive),
    [followedChannels],
  );
  const offlineFollowedChannels = useMemo(
    () => followedChannels.filter((channel) => !channel.isLive),
    [followedChannels],
  );
  // Favorites stay inside their Live/Offline group but sort to the top of it,
  // so an offline favorite never outranks a channel that's actually live.
  // Partitioning keeps each group's existing order (Twitch sorts by viewers).
  const sortFavoritesFirst = useCallback(
    (channels: FollowedChannel[]) => [
      ...channels.filter((channel) => favoriteChannels.has(channel.login)),
      ...channels.filter((channel) => !favoriteChannels.has(channel.login)),
    ],
    [favoriteChannels],
  );
  const sidebarLiveChannels = useMemo(
    () => sortFavoritesFirst(liveFollowedChannels),
    [liveFollowedChannels, sortFavoritesFirst],
  );
  const sidebarOfflineChannels = useMemo(
    () => sortFavoritesFirst(offlineFollowedChannels),
    [offlineFollowedChannels, sortFavoritesFirst],
  );

  function toggleFavoriteChannel(login: string) {
    setFavoriteChannels((current) => {
      const next = new Set(current);
      if (next.has(login)) next.delete(login);
      else next.add(login);
      void window.desktop.preferences
        .update({ favoriteChannels: [...next] })
        .catch(() => undefined);
      return next;
    });
    setChannelMenu(null);
  }

  useEffect(() => {
    if (!channelMenu) return;
    const close = () => setChannelMenu(null);
    const closeOutside = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".channel-context-menu")) return;
      setChannelMenu(null);
    };
    // Only the followed list scrolling matters — that's what moves the row the
    // menu points at. A capture-phase listener sees every scroll in the app,
    // and live chat auto-scrolls constantly, which was closing the menu on its
    // own after a second.
    const closeOnListScroll = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".followed-list")) {
        setChannelMenu(null);
      }
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChannelMenu(null);
    };
    window.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("scroll", closeOnListScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", closeOnKey);
    return () => {
      window.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("scroll", closeOnListScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", closeOnKey);
    };
  }, [channelMenu]);

  // A live native stream that ends usually leaves mpv stalled on the HLS
  // playlist rather than emitting EOF, so the canvas freezes on the last frame
  // with no state change. The reliable "it ended" signal is the Twitch metadata
  // poll flipping isLive to false for the channel we're actually watching.
  const nativeStreamOffline =
    activeMode === "native" &&
    !!activeChannel &&
    !!streamMetadata &&
    streamMetadata.login.toLowerCase() === activeChannel.toLowerCase() &&
    !streamMetadata.isLive;
  const toolbarProfileImage = streamMetadata?.profileImageUrl || activeChannelIdentity?.profileImageUrl;
  const toolbarTitle =
    streamMetadata?.title ??
    activeChannelIdentity?.title ??
    ((streamMetadata && !streamMetadata.isLive) || activeChannelIdentity?.isLive === false
      ? "Offline"
      : "Loading channel…");
  const toolbarIsLive = streamMetadata?.isLive ?? activeChannelIdentity?.isLive ?? false;
  const toolbarViewerCount = streamMetadata?.viewerCount ?? activeChannelIdentity?.viewerCount ?? 0;
  const toolbarStartedAt = streamMetadata?.startedAt ?? activeChannelIdentity?.startedAt;
  const toolbarCategory = streamMetadata?.category ?? activeChannelIdentity?.category;
  const toolbarLanguage = streamMetadata?.language ?? activeChannelIdentity?.language;
  const toolbarTags = streamMetadata?.tags ?? activeChannelIdentity?.tags;
  const toolbarIsMature = streamMetadata?.isMature ?? activeChannelIdentity?.isMature;

  function renderFollowedChannel(channel: FollowedChannel) {
    return (
      <button
        className={channel.isLive ? "followed-channel" : "followed-channel offline"}
        key={channel.id}
        onClick={() => void watchChannel(channel.login, channel)}
        onContextMenu={(event) => {
          event.preventDefault();
          setChannelMenu({ login: channel.login, x: event.clientX, y: event.clientY });
        }}
        onMouseEnter={channel.isLive ? () => schedulePreresolve(channel.login) : undefined}
        onMouseLeave={cancelPreresolve}
        title={sidebarCollapsed ? channel.displayName : undefined}
        type="button"
      >
        <span className="channel-avatar">
          <img alt="" src={channel.profileImageUrl} />
          {channel.isLive && <i className="channel-live-dot" aria-hidden="true" />}
          {favoriteChannels.has(channel.login) && (
            <Star aria-hidden="true" className="channel-favorite-star" size={10} />
          )}
        </span>
        <span className="followed-copy">
          <strong>{channel.displayName}</strong>
          <small>{channel.category}</small>
        </span>
        {channel.isLive && (
          <span className="viewer-count">
            <i /> {Intl.NumberFormat("en", { notation: "compact" }).format(channel.viewerCount)}
          </span>
        )}
      </button>
    );
  }

  return (
    <div
      className={[
        "app-shell",
        oledMode ? "oled-mode" : "",
        chatOnLeft ? "chat-left" : "",
        sidebarCollapsed ? "sidebar-collapsed" : "",
        theaterMode ? "theater-mode" : "",
        multiStreamActive && multiTheater ? "multi-theater" : "",
        fullscreen ? "fullscreen-mode" : "",
        fullscreen && !nativeControlsVisible ? "controls-hidden" : "",
      ].join(" ")}
      style={{
        "--chat-font-size": `${chatFontSize}px`,
        "--chat-emote-size": `${chatEmoteSize}px`,
      } as CSSProperties}
    >
      <ReactTooltipLayer />
      {channelMenu && (
        <div
          className="channel-context-menu"
          role="menu"
          style={{ position: "fixed", left: channelMenu.x, top: channelMenu.y }}
        >
          <button
            onClick={() => toggleFavoriteChannel(channelMenu.login)}
            role="menuitem"
            type="button"
          >
            {favoriteChannels.has(channelMenu.login) ? (
              <>
                <StarOff size={15} /> Remove from favorites
              </>
            ) : (
              <>
                <Star size={15} /> Add to favorites
              </>
            )}
          </button>
        </div>
      )}
      {notice && (
        <div className="app-toast" key={notice} role="status" aria-live="polite">
          {notice}
        </div>
      )}
      {/* Our own title bar. The window is frameless apart from the native
          caption buttons, which the system draws into the reserved space on
          the right, so anything added here goes to the left of them. */}
      <div className="titlebar">
        <span className="titlebar-title">{locationLabel}</span>
      </div>

      <div className="brand">
        <span className="brand-mark"><img alt="" src={violetWireIcon} /></span>
        <span>VioletWire</span>
      </div>

      <aside className="sidebar">
        <section className="followed-rail" aria-labelledby="followed-heading">
          <div className="rail-heading">
            <span id="followed-heading">Followed channels</span>
            <button
              aria-label={sidebarCollapsed ? "Expand followed channels" : "Collapse followed channels"}
              aria-pressed={sidebarCollapsed}
              className="sidebar-collapse-toggle"
              onClick={() => setSidebarCollapsed((current) => !current)}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              type="button"
            >
              {(sidebarCollapsed ? !chatOnLeft : chatOnLeft) ? (
                <ChevronRight size={16} />
              ) : (
                <ChevronLeft size={16} />
              )}
            </button>
          </div>
          <div className="followed-list">
            {sidebarLiveChannels.length > 0 && (
              <>
                <div className="followed-group-label">
                  <span>Live</span>
                  <b>{sidebarLiveChannels.length}</b>
                </div>
                {sidebarLiveChannels.map(renderFollowedChannel)}
              </>
            )}
            {sidebarOfflineChannels.length > 0 && (
              <>
                <div className="followed-group-label offline">
                  <span>Offline</span>
                  <b>{sidebarOfflineChannels.length}</b>
                </div>
                {sidebarOfflineChannels.map(renderFollowedChannel)}
              </>
            )}
            {followedChannels.length === 0 && (
              <div className="followed-empty">
                <div className="empty-orbit"><Heart size={16} /></div>
                <strong>Your channels will live here</strong>
                <span>Sign in to see followed channels and who is live.</span>
              </div>
            )}
          </div>
        </section>

      </aside>

      <main>
        <header className="topbar">
          <nav className="top-navigation" aria-label="Main navigation">
            <button
              aria-current={activeSection === "home" ? "page" : undefined}
              className={activeSection === "home" ? "top-nav-item active" : "top-nav-item"}
              onClick={() => void navigateTo("home")}
              type="button"
            >
              <Home size={17} /> Home
            </button>
            <button
              aria-current={activeSection === "browse" ? "page" : undefined}
              className={activeSection === "browse" ? "top-nav-item active" : "top-nav-item"}
              onClick={() => void navigateTo("browse")}
              type="button"
            >
              <Compass size={17} /> Browse
            </button>
          </nav>
          <form
            className="search-box"
            onBlur={() => window.setTimeout(() => setTopSearchOpen(false), 120)}
            onFocus={() => {
              if (authState.status === "signed-in" && channelInput.trim().length >= 2) {
                setTopSearchOpen(true);
              }
            }}
            onSubmit={openChannel}
          >
            <Search size={18} />
            <input
              aria-label="Twitch channel"
              autoComplete="off"
              onChange={(event) => updateTopSearch(event.target.value)}
              placeholder="Search channels and categories"
              value={channelInput}
            />
            {channelInput ? (
              <button
                aria-label="Clear search"
                className="top-search-clear"
                onClick={() => updateTopSearch("")}
                type="button"
              >
                <X size={16} />
              </button>
            ) : (
              <kbd>Enter</kbd>
            )}
            {topSearchOpen && (
              <div className="top-search-results">
                {topSearchLoading ? (
                  <div className="top-search-state">
                    <RefreshCw className="spin" size={16} /> Searching Twitch…
                  </div>
                ) : (
                  <>
                    {topSearchResults.categories.length > 0 && (
                      <section>
                        <span className="top-search-heading">Categories</span>
                        {topSearchResults.categories.map((category) => (
                          <button
                            className="top-search-result"
                            key={`category-${category.id}`}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => void chooseSearchCategory(category)}
                            type="button"
                          >
                            <img alt="" src={category.boxArtUrl} />
                            <span>
                              <strong>{category.name}</strong>
                              <small>Category</small>
                            </span>
                          </button>
                        ))}
                      </section>
                    )}
                    {topSearchResults.channels.length > 0 && (
                      <section>
                        <span className="top-search-heading">Channels</span>
                        {topSearchResults.channels.map((channel) => (
                          <button
                            className="top-search-result"
                            key={`channel-${channel.id}`}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => chooseSearchChannel(channel)}
                            onMouseEnter={channel.isLive ? () => schedulePreresolve(channel.login) : undefined}
                            onMouseLeave={cancelPreresolve}
                            type="button"
                          >
                            {channel.profileImageUrl ? (
                              <img className="channel-result-avatar" alt="" src={channel.profileImageUrl} />
                            ) : (
                              <span className="channel-result-fallback">
                                {channel.displayName.slice(0, 1).toUpperCase()}
                              </span>
                            )}
                            <span>
                              <strong>
                                {channel.displayName}
                                {channel.isLive && <i>LIVE</i>}
                              </strong>
                              <small>
                                {channel.isLive
                                  ? [
                                      channel.category || "Live channel",
                                      channel.viewerCount !== undefined
                                        ? `${Intl.NumberFormat("en-US").format(channel.viewerCount)} viewers`
                                        : undefined,
                                      channel.startedAt
                                        ? formatUptime(channel.startedAt, uptimeNow)
                                        : undefined,
                                    ]
                                      .filter(Boolean)
                                      .join(" · ")
                                  : "Offline"}
                              </small>
                            </span>
                          </button>
                        ))}
                      </section>
                    )}
                    {topSearchResults.categories.length === 0 &&
                      topSearchResults.channels.length === 0 && (
                        <div className="top-search-state">No channels or categories found.</div>
                      )}
                    <button
                      className="top-search-direct"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setTopSearchOpen(false);
                        const normalizedLogin = channelInput.trim().toLowerCase();
                        void watchChannel(
                          channelInput,
                          topSearchResults.channels.find(
                            (channel) => channel.login.toLowerCase() === normalizedLogin,
                          ),
                        );
                      }}
                      type="button"
                    >
                      <Search size={16} />
                      Go to <strong>{channelInput.trim()}</strong>
                    </button>
                  </>
                )}
              </div>
            )}
          </form>
          <div className="top-actions">
          <div className="mode-switch top-mode-switch" aria-label="Playback engine">
            <button
              aria-pressed={(activeChannel ? activeMode : preferredMode) === "native"}
              className={(activeChannel ? activeMode : preferredMode) === "native" ? "active experimental" : "experimental"}
              onClick={() =>
                activeChannel
                  ? void switchPlayerMode("native")
                  : void choosePreferredMode("native")
              }
              title="Use the Native player"
              type="button"
            >
              Native
            </button>
            <button
              aria-pressed={(activeChannel ? activeMode : preferredMode) === "official"}
              className={(activeChannel ? activeMode : preferredMode) === "official" ? "active" : ""}
              onClick={() =>
                activeChannel
                  ? void switchPlayerMode("official")
                  : void choosePreferredMode("official")
              }
              title="Use Twitch's Standard player"
              type="button"
            >
              Standard
            </button>
          </div>
          <button
            aria-pressed={multiStreamActive}
            className={multiStreamActive ? "top-multistream active" : "top-multistream"}
            disabled={authState.status !== "signed-in"}
            onClick={() => (multiStreamActive ? exitMultiStream() : void enterMultiStream())}
            title="Watch up to 4 streams at once"
            type="button"
          >
            <LayoutGrid size={16} />
            <span>Multistream</span>
          </button>
          <button
            className="sign-in"
            disabled={authBusy}
            onClick={() =>
              authState.status === "signed-in" ? setSettingsOpen(true) : void beginSignIn()
            }
            type="button"
            title={authState.status === "signed-in" ? "Account settings" : "Sign in with Twitch"}
          >
            {authState.status === "signed-in" ? (
              <>
                <span className="top-account-avatar">
                  <img alt="" src={authState.account.profileImageUrl} />
                  <i aria-label="Twitch connected" title="Twitch connected" />
                </span>
                <span className="top-account-name">{authState.account.displayName}</span>
              </>
            ) : (
              <>
                <LogIn size={17} />
                <span>{authBusy ? "Working…" : "Sign in"}</span>
              </>
            )}
          </button>
          <button
            aria-current={settingsOpen ? "page" : undefined}
            aria-label="Settings"
            className={
              settingsOpen
                ? "top-settings-button active"
                : "top-settings-button"
            }
            onClick={() => setSettingsOpen((current) => !current)}
            title="Settings"
            type="button"
          >
            <Settings size={18} />
          </button>
          </div>
        </header>

        {multiStreamActive ? (
          <div className="multi-stream-layout">
            <MultiStreamView
              tiles={multiTiles}
              followedLive={liveFollowedChannels}
              nameFor={nameForChannel}
              controlsHideDelay={controlsHideDelay}
              onAdd={(channel) => void addMultiTile(channel)}
              onRemove={removeMultiTile}
              onActivate={activateMultiTile}
              onToggleMute={(id) =>
                window.desktop.player.multiControl(id, { command: "toggle-mute" })
              }
              onSetVolume={(id, volume) =>
                window.desktop.player.multiControl(id, { command: "set-volume", value: volume })
              }
              onToggleCompressor={(id, enabled) =>
                window.desktop.player.multiControl(id, { command: "set-compressor", enabled })
              }
              onSetQuality={(id, quality) =>
                void window.desktop.player.multiSetQuality(id, quality)
              }
              theater={multiTheater}
              onToggleTheater={() => setMultiTheater((current) => !current)}
              fullscreen={fullscreen}
              onToggleFullscreen={() => void window.desktop.player.setFullscreen(!fullscreen)}
              onExit={exitMultiStream}
            />
            <aside className="multi-chat" aria-label="Stream chat">
              <div className="multi-chat-tabs multi-chat-tabbar" role="tablist">
                {multiTiles.length === 0 ? (
                  <span className="multi-chat-empty-tabs">Add a stream to see its chat</span>
                ) : (
                  multiTiles.map((tile) => (
                    <button
                      aria-selected={effectiveMultiChatChannel === tile.channel}
                      className={
                        effectiveMultiChatChannel === tile.channel
                          ? "multi-chat-tab active"
                          : "multi-chat-tab"
                      }
                      key={tile.id}
                      onClick={() => setMultiChatChannel(tile.channel)}
                      role="tab"
                      type="button"
                    >
                      {tile.active && <i aria-label="Audio" className="multi-chat-tab-dot" />}
                      <span>{nameForChannel(tile.channel)}</span>
                    </button>
                  ))
                )}
              </div>
              <div
                aria-live="polite"
                className={`chat-messages${multiChatPaused ? " scroll-paused" : ""}`}
                onPointerDown={noteMultiChatUserScroll}
                onScroll={handleMultiChatScroll}
                onWheel={noteMultiChatUserScroll}
                ref={multiChatHost}
              >
                <div ref={multiChatContent}>
                  {multiDisplayMessages.length === 0 && (
                    <div className="chat-empty-state">
                      {!effectiveMultiChatChannel
                        ? "Add a stream to see its chat"
                        : multiChatStates.get(effectiveMultiChatChannel) === "connected"
                          ? "Waiting for the next chat message…"
                          : "Connecting to Twitch chat…"}
                    </div>
                  )}
                  {multiDisplayMessages.map((message) => (
                    <ChatMessageRow
                      badges={twitchBadges}
                      deletedMessageStyle={chatDeletedMessageStyle}
                      deletedRevealed={revealedDeletedMessages.has(message.id)}
                      key={message.id}
                      mentioned={messageMentionsLogin(message, viewerLogin)}
                      message={message}
                      oledMode={oledMode}
                      onOpenThread={setOpenReplyThread}
                      onOpenUser={openChatUserCard}
                      onReply={beginReply}
                      onRevealDeleted={revealDeletedMessage}
                      providerEmotes={chatProviderEmotes}
                      showTimestamp={chatTimestamps}
                    />
                  ))}
                </div>
              </div>
              {multiChatPaused && (
                <button
                  className="scroll-to-current"
                  onClick={scrollMultiChatToBottom}
                  type="button"
                >
                  <Pause aria-hidden="true" size={12} />
                  <span>Chat paused due to scroll</span>
                  <ArrowDown aria-hidden="true" size={14} />
                </button>
              )}
              <form className="native-chat-input" onSubmit={sendChatMessage}>
                {replyingTo && (
                  <div className="chat-reply-composer">
                    <div className="chat-reply-heading">
                      <span>
                        <Reply size={15} /> Replying to {replyingTo.displayName}
                      </span>
                      <button
                        aria-label="Cancel reply"
                        onClick={() => setReplyingTo(null)}
                        title="Cancel reply"
                        type="button"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                )}
                <div className="chat-composer-box">
                  <ChatComposerInput
                    aria-label="Send a chat message"
                    disabled={authState.status !== "signed-in" || !effectiveMultiChatChannel}
                    maxLength={500}
                    mentionCandidates={chatMentionCandidates}
                    onValueChange={setChatInput}
                    placeholder={
                      authState.status !== "signed-in"
                        ? "Sign in to chat"
                        : replyingTo
                          ? "Write a reply"
                          : `Message ${nameForChannel(effectiveMultiChatChannel ?? "")}`
                    }
                    ref={chatInputHost}
                    sevenTvEmotes={chatProviderEmotes}
                    twitchEmotes={twitchPickerEmotes}
                    value={chatInput}
                  />
                  <div className="chat-composer-inline-actions">
                    <div className="emote-picker-anchor">
                      <button
                        aria-expanded={emotePickerOpen}
                        aria-label="Choose Twitch and 7TV emotes"
                        className={
                          emotePickerOpen ? "emote-picker-button active" : "emote-picker-button"
                        }
                        onClick={() => setEmotePickerOpen((current) => !current)}
                        title="Twitch and 7TV emotes"
                        type="button"
                      >
                        <Smile size={17} />
                      </button>
                      {emotePickerOpen && (
                        <EmotePicker
                          channelName={nameForChannel(effectiveMultiChatChannel ?? "Channel")}
                          onClose={() => setEmotePickerOpen(false)}
                          onSelect={(name) =>
                            setChatInput(
                              (current) =>
                                `${current}${current && !current.endsWith(" ") ? " " : ""}${name} `,
                            )
                          }
                          providerChannelEmoteNames={providerChannelNames}
                          providerEmotes={providerEmoteMaps}
                          twitchEmotes={twitchPickerEmotes}
                        />
                      )}
                    </div>
                  </div>
                </div>
                <div className="chat-composer-footer">
                  <div className="chat-header-actions multi-chat-settings">
                    <button
                      aria-expanded={chatSettingsOpen}
                      aria-label="Chat settings"
                      className={chatSettingsOpen ? "toolbar-icon active" : "toolbar-icon"}
                      onClick={() => setChatSettingsOpen((current) => !current)}
                      title="Chat settings"
                      type="button"
                    >
                      <Settings size={16} />
                    </button>
                    {chatSettingsOpen && (
                      <div className="chat-overlay-settings multi-chat-settings-menu">
                        <strong>Chat settings</strong>
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
                            setChatDeletedMessageStyle(checked ? "dimmed" : "placeholder")
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
                      </div>
                    )}
                  </div>
                  <button
                    className="chat-send-button"
                    disabled={authState.status !== "signed-in" || !chatInput.trim()}
                    type="submit"
                  >
                    {replyingTo ? "Reply" : "Chat"}
                  </button>
                </div>
              </form>
              {openReplyThread && (
                <ReplyThread
                  badges={twitchBadges}
                  messages={multiDisplayMessages}
                  oledMode={oledMode}
                  onClose={() => setOpenReplyThread(null)}
                  onOpenUser={openChatUserCard}
                  onReply={beginReply}
                  renderText={renderCardText}
                  selected={openReplyThread}
                />
              )}
              {selectedChatUser && effectiveMultiChatChannel && (
                <ChatUserCard
                  anchor={selectedChatUserAnchor}
                  badges={twitchBadges}
                  channel={effectiveMultiChatChannel}
                  key={`${effectiveMultiChatChannel}:${selectedChatUser.login}`}
                  messages={multiDisplayMessages}
                  onClose={() => {
                    setSelectedChatUser(null);
                    setSelectedChatUserAnchor(undefined);
                  }}
                  renderText={renderCardText}
                  selected={selectedChatUser}
                />
              )}
            </aside>
          </div>
        ) : activeChannel && !miniPlayerActive ? (
          <section
            className={[
              "player-page",
              chatResizing ? "chat-resizing" : "",
              // In theater the toolbar floats over the video, so it fades with
              // the player controls rather than sitting on top permanently.
              activeMode === "native" && !nativeControlsVisible ? "controls-hidden" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            ref={playerPageRef}
            style={{ "--chat-sidebar-width": `${chatSidebarWidth}px` } as CSSProperties}
            onMouseMove={(event) => {
              const previous = lastPlayerPointerPosition.current;
              if (previous?.x === event.clientX && previous.y === event.clientY) return;
              lastPlayerPointerPosition.current = { x: event.clientX, y: event.clientY };
              const overVideo =
                event.target instanceof Element &&
                (event.target.closest(".video-column") ||
                  (theaterMode && event.target.closest(".player-toolbar")));
              if (overVideo) {
                revealNativeControls();
              } else {
                hideNativeControls();
              }
            }}
            onMouseLeave={hideNativeControls}
            onWheel={(event) => {
              const target = event.target;
              if (
                target instanceof Element &&
                target.closest(".chat-messages, .emote-picker-grid")
              ) {
                event.stopPropagation();
                return;
              }
              event.preventDefault();
            }}
          >
            <div
              className={`player-toolbar ${
                !chatVisible || chatPresentation === "overlay" ? "chat-collapsed" : ""
              }`}
            >
              <div className="player-toolbar-main">
              <button
                aria-label="Back to browsing"
                className="back-button"
                onClick={() => void closePlayer()}
                title="Back"
                type="button"
              >
                <ChevronLeft size={25} />
              </button>
              {toolbarProfileImage && (
                <img className="stream-avatar" alt="" src={toolbarProfileImage} />
              )}
              {toolbarIsLive && (
                <div className="toolbar-stream-stats">
                  <span className="toolbar-viewers" title="Current viewers">
                    <Users size={14} />
                    <strong>
                      {Intl.NumberFormat("en-US").format(toolbarViewerCount)}
                    </strong>
                  </span>
                  <span className="toolbar-uptime" title="Stream uptime">
                    <Clock size={13} />
                    {formatUptime(toolbarStartedAt, uptimeNow)}
                  </span>
                </div>
              )}
              <div className="channel-identity">
                <div>
                  <span className="stream-title" title={toolbarTitle}>
                    {toolbarTitle}
                  </span>
                  <div className="channel-name-line">
                    <strong>{activeChannelDisplayName}</strong>
                    {toolbarCategory && (
                      <button
                        className="toolbar-category"
                        disabled={!streamMetadata?.categoryId}
                        onClick={() => void chooseStreamCategory()}
                        title={
                          streamMetadata?.categoryId
                            ? `Browse ${toolbarCategory}`
                            : toolbarCategory
                        }
                        type="button"
                      >
                        {toolbarCategory}
                      </button>
                    )}
                    {toolbarLanguage && (
                      <span className="toolbar-stream-tag">
                        {toolbarLanguage.toUpperCase()}
                      </span>
                    )}
                    {toolbarTags?.slice(0, 2).map((tag) => (
                      <span className="toolbar-stream-tag" key={tag} title={tag}>
                        {tag}
                      </span>
                    ))}
                    {toolbarIsMature && (
                      <span className="toolbar-stream-tag mature">Mature</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="player-actions" aria-label="Channel and player actions">
                <button
                  aria-label={streamMetadata?.isFollowed ? "Following channel" : "Follow channel"}
                  aria-pressed={Boolean(streamMetadata?.isFollowed)}
                  className={streamMetadata?.isFollowed ? "toolbar-icon follow-action active" : "toolbar-icon follow-action"}
                  onClick={() => void handleFollow()}
                  title={streamMetadata?.isFollowed ? "You follow this channel" : "Follow on Twitch"}
                  type="button"
                >
                  <Heart fill={streamMetadata?.isFollowed ? "currentColor" : "none"} size={17} />
                </button>
                <button
                  aria-label={
                    subscriptionDrawerState === "loading"
                      ? "Loading subscription panel"
                      : subscriptionDrawerState === "open"
                        ? "Close subscription panel"
                        : streamMetadata?.subscription?.isSubscribed
                          ? "Subscribed"
                          : "Subscribe"
                  }
                  aria-expanded={subscriptionDrawerState !== "closed"}
                  className={[
                    "toolbar-icon",
                    "subscribe-action",
                    streamMetadata?.subscription?.isSubscribed ? "active" : "",
                    subscriptionDrawerState !== "closed" ? "panel-open" : "",
                  ].filter(Boolean).join(" ")}
                  onClick={() => void openChannelAction("subscribe", "Subscription")}
                  title={
                    subscriptionDrawerState === "loading"
                      ? "Loading Twitch subscription panel…"
                      : subscriptionDrawerState === "open"
                        ? "Close Twitch subscription panel"
                        : "Open Twitch subscription panel"
                  }
                  type="button"
                >
                  {subscriptionDrawerState === "loading" ? (
                    <RefreshCw className="spin" size={16} />
                  ) : (
                    <Star
                      fill={streamMetadata?.subscription?.isSubscribed ? "currentColor" : "none"}
                      size={17}
                    />
                  )}
                </button>
                <button
                  className="toolbar-action"
                  onClick={() => void createClip()}
                  title="Create a clip with Twitch's official API"
                  type="button"
                >
                  <Scissors size={16} /> <span>Clip</span>
                </button>
                {activeMode !== "native" && (
                  <>
                    <button
                      aria-pressed={theaterMode}
                      className={theaterMode ? "toolbar-action active" : "toolbar-action"}
                      onClick={() => setTheaterMode((current) => !current)}
                      title="Toggle theater mode (T)"
                      type="button"
                    >
                      <Tv size={16} /> <span>Theater</span>
                    </button>
                    <button
                      aria-pressed={fullscreen}
                      className={fullscreen ? "toolbar-action active" : "toolbar-action"}
                      onClick={() => void setFullscreenMode(!fullscreen)}
                      title="Toggle fullscreen window (F)"
                      type="button"
                    >
                      {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
                      <span>{fullscreen ? "Exit full" : "Fullscreen"}</span>
                    </button>
                  </>
                )}
                <button
                  aria-label="Open channel on Twitch"
                  className="toolbar-icon"
                  onClick={() => void openChannelInBrowser()}
                  title="Open channel on Twitch"
                  type="button"
                >
                  <ExternalLink size={16} />
                </button>
              </div>
              </div>
            </div>

            <div
              className={[
                "viewer-layout",
                !chatVisible || chatPresentation === "overlay" ? "chat-collapsed" : "",
                chatPresentation === "overlay" ? "chat-overlay-mode" : "",
              ].join(" ")}
            >
              {!chatVisible && activeMode !== "native" && (
                <button
                  aria-label="Show stream chat"
                  className="chat-edge-restore"
                  onClick={() => setChatLayout("side")}
                  title="Show stream chat"
                  type="button"
                >
                  {chatOnLeft ? <ChevronRight size={19} /> : <ChevronLeft size={19} />}
                </button>
              )}
              <div
                className={[
                  "video-column",
                  activeMode === "native" ? "native" : "",
                  activeMode === "native" && !nativeControlsVisible ? "controls-hidden" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <div
                  className="player-host"
                  ref={playerHost}
                  aria-label={`${activeMode === "native" ? "Native" : "Official Twitch"} player for ${activeChannel}`}
                >
                  {activeMode === "official" && (
                    <iframe
                      allow="autoplay; fullscreen; picture-in-picture"
                      allowFullScreen
                      className="standard-player-frame"
                      key={`standard-player:${activeChannel}`}
                      sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts"
                      src={`https://player.twitch.tv/?channel=${encodeURIComponent(activeChannel)}&parent=${encodeURIComponent(window.location.hostname)}&autoplay=true&muted=false`}
                      aria-label={`Official Twitch player for ${activeChannel}`}
                    />
                  )}
                  {activeMode === "native" && activeNativeBackend === "texture" && (
                    <>
                      <canvas
                        className="native-texture-canvas"
                        data-native-texture-canvas="main"
                        aria-hidden="true"
                      />
                      <NativeControls
                        inline
                        key={`inline-native-controls:${activeChannel}`}
                        inlineContext={{
                          channel: activeChannel,
                          fullscreen,
                          theaterMode,
                          chatVisible,
                          chatPresentation,
                          viewerLogin,
                        }}
                        inlineVisible={nativeControlsVisible}
                      />
                    </>
                  )}
                  {activeMode === "native" &&
                    (nativeState.status !== "playing" || nativeStreamOffline) && (
                    <div className="native-player-placeholder">
                      {!nativeStreamOffline && (
                        <span className={`native-status-orb ${nativeState.status}`} />
                      )}
                      <strong>
                        {nativeStreamOffline
                          ? `${streamMetadata?.displayName ?? activeChannel} has ended the stream`
                          : nativeState.error === "Stream is offline."
                            ? "Stream offline"
                            : nativeState.status === "error"
                              ? "Native player could not start"
                              : nativeState.transition?.kind === "quality"
                                ? `Switching to ${formatQualityLabel(nativeState.transition.detail as NativeQualityValue)}`
                                : nativeState.transition?.kind === "channel"
                                  ? `Loading ${streamMetadata?.displayName ?? activeChannel}`
                                  : "Starting native player"}
                      </strong>
                      <p>
                        {nativeStreamOffline
                          ? "The channel is now offline. This will update automatically if they go live again."
                          : (nativeState.error ??
                            (nativeState.transition?.kind === "quality"
                              ? "Reconnecting the stream at the new quality."
                              : "Streamlink is resolving the Twitch stream and connecting it to mpv."))}
                      </p>
                      {(nativeStreamOffline || nativeState.status === "error") && (
                        <button onClick={() => void retryNativePlayer()} type="button">
                          <RotateCcw size={15} /> Retry
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {!(activeMode === "native" && chatPresentation === "overlay") && (
                <aside
                  className={[
                    "chat-panel",
                    chatPresentation === "overlay" ? "overlay" : "",
                    // Keep the panel mounted and just hide it, so re-showing is
                    // instant instead of re-rendering the whole message list.
                    chatVisible ? "" : "chat-hidden",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-label={`${activeChannel} chat`}
                  onMouseEnter={revealChatComposer}
                  style={
                    chatPresentation === "overlay"
                      ? { backgroundColor: `rgb(24 24 27 / ${chatOpacity}%)` }
                      : undefined
                  }
                >
                  {chatPresentation === "side" && (
                    <div
                      aria-label="Resize chat"
                      className={
                        chatOnLeft
                          ? "chat-resize-handle chat-resize-handle-right"
                          : "chat-resize-handle chat-resize-handle-left"
                      }
                      onDoubleClick={() => setChatSidebarWidth(384)}
                      onPointerDown={beginChatResize}
                      onPointerMove={updateChatResize}
                      onPointerUp={endChatResize}
                      role="separator"
                    />
                  )}
                  {chatPresentation === "overlay" && (
                    <div className="chat-overlay-tools">
                      <button
                        aria-label="Hide chat overlay"
                        onClick={() => setChatLayout("hidden")}
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
                        <div className="chat-overlay-settings">
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
                          <ChatToggleSetting
                            checked={chatOnLeft}
                            label="Chat on left"
                            onChange={setChatOnLeft}
                          />
                          <label>
                            <span>History: {chatHistoryLimit}</span>
                            <input
                              aria-label="Chat history message count"
                              max="100"
                              min="20"
                              onChange={(event) =>
                                setChatHistoryLimit(Number(event.target.value))
                              }
                              step="10"
                              type="range"
                              value={chatHistoryLimit}
                            />
                          </label>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="chat-panel-header">
                    <button
                      aria-label="Collapse chat"
                      className="toolbar-icon chat-collapse-button"
                      onClick={() => setChatLayout("hidden")}
                      title="Collapse chat"
                      type="button"
                    >
                      {chatOnLeft && chatPresentation === "side" ? (
                        <ChevronLeft size={18} />
                      ) : (
                        <ChevronRight size={18} />
                      )}
                    </button>
                    <strong>Stream Chat</strong>
                    <div className="chat-header-actions">
                      <button
                        aria-expanded={chatSettingsOpen}
                        aria-label="Chat settings"
                        className={chatSettingsOpen ? "toolbar-icon active" : "toolbar-icon"}
                        onClick={() => setChatSettingsOpen((current) => !current)}
                        title="Chat settings"
                        type="button"
                      >
                        <Settings size={16} />
                      </button>
                      {chatSettingsOpen && (
                        <div className="chat-overlay-settings chat-header-settings">
                          <strong>Chat settings</strong>
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
                          <ChatToggleSetting
                            checked={chatOnLeft}
                            label="Chat on left"
                            onChange={setChatOnLeft}
                          />
                          <label>
                            <span>History: {chatHistoryLimit}</span>
                            <input
                              aria-label="Chat history message count"
                              max="100"
                              min="20"
                              onChange={(event) =>
                                setChatHistoryLimit(Number(event.target.value))
                              }
                              step="10"
                              type="range"
                              value={chatHistoryLimit}
                            />
                          </label>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="chat-host native-chat" ref={chatHost}>
                    <div
                      className={`chat-messages${chatAutoScroll ? "" : " scroll-paused"}`}
                      ref={chatMessagesHost}
                      aria-live="polite"
                      onScroll={handleChatScroll}
                      onWheel={handleChatWheel}
                      onPointerDown={handleChatPointerDown}
                    >
                      {chatMessages.length === 0 && (
                        <div className="chat-empty-state">
                          {chatConnectionState === "connected"
                            ? "Waiting for the next chat message…"
                            : "Connecting to Twitch chat…"}
                        </div>
                      )}
                      {chatMessages.map((message, index) => (
                        <Fragment key={message.id}>
                        <ChatMessageRow
                          badges={twitchBadges}
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
                        badges={twitchBadges}
                        messages={chatMessages}
                        oledMode={oledMode}
                        onClose={() => setOpenReplyThread(null)}
                        onOpenUser={openChatUserCard}
                        onReply={beginReply}
                        renderText={renderCardText}
                        selected={openReplyThread}
                      />
                    )}
                    {selectedChatUser && activeChannel && (
                      <ChatUserCard
                        anchor={selectedChatUserAnchor}
                        badges={twitchBadges}
                        channel={activeChannel}
                        key={`${activeChannel}:${selectedChatUser.login}`}
                        messages={chatMessages}
                        onClose={() => {
                          setSelectedChatUser(null);
                          setSelectedChatUserAnchor(undefined);
                          window.desktop.player.setNativeControlsVisible(true);
                          setNativeControlsVisible(true);
                        }}
                        renderText={renderCardText}
                        selected={selectedChatUser}
                      />
                    )}
                    {!chatAutoScroll && (
                      <button
                        className="scroll-to-current"
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
                    <form className="native-chat-input" onSubmit={sendChatMessage} ref={chatComposerHost}>
                      {replyingTo && (
                        <div className="chat-reply-composer">
                          <div className="chat-reply-heading">
                            <span><Reply size={15} /> Replying to {replyingTo.displayName}:</span>
                            <button
                              aria-label="Cancel reply"
                              onClick={() => setReplyingTo(null)}
                              title="Cancel reply"
                              type="button"
                            >
                              <X size={14} />
                            </button>
                          </div>
                          <div className="chat-reply-preview">
                            {replyingTo.badges.slice(0, 1).map((badgeKey) => {
                              const badge = twitchBadges.get(badgeKey);
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
                      <div className="chat-composer-box">
                        <ChatComposerInput
                          aria-label="Send a chat message"
                          disabled={authState.status !== "signed-in"}
                          maxLength={500}
                          mentionCandidates={chatMentionCandidates}
                          onValueChange={setChatInput}
                          placeholder={
                            authState.status === "signed-in"
                              ? replyingTo
                                ? "Write a reply"
                                : "Send a message"
                              : "Sign in to send messages"
                          }
                          ref={chatInputHost}
                          sevenTvEmotes={chatProviderEmotes}
                          twitchEmotes={twitchPickerEmotes}
                          value={chatInput}
                        />
                        <div className="chat-composer-inline-actions">
                          <div className="emote-picker-anchor">
                            <button
                              aria-expanded={emotePickerOpen}
                              aria-label="Choose Twitch and 7TV emotes"
                              className={emotePickerOpen ? "emote-picker-button active" : "emote-picker-button"}
                              onClick={() => {
                                const next = !emotePickerOpen;
                                setEmotePickerOpen(next);
                                if (
                                  activeMode === "native" &&
                                  activeNativeBackend === "window"
                                ) {
                                  window.desktop.player.setNativeEmotePicker(next);
                                }
                              }}
                              title="Twitch and 7TV emotes"
                              type="button"
                            >
                              <Smile size={17} />
                            </button>
                            {emotePickerOpen &&
                              !(
                                activeMode === "native" &&
                                activeNativeBackend === "window"
                              ) && (
                              <>
                                <EmotePicker
                                  channelAvatarUrl={streamMetadata?.profileImageUrl}
                                  channelName={streamMetadata?.displayName ?? activeChannel ?? "Channel"}
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
                              <div className="emote-picker">
                            <input
                              aria-label="Search emotes"
                              autoFocus
                              onChange={(event) => setEmoteSearch(event.target.value)}
                              placeholder="Search Twitch and 7TV"
                              value={emoteSearch}
                            />
                            <div className="emote-picker-tabs" role="tablist">
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
                              <div className="emote-picker-grid">
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
                                  <span className="emote-group-empty">No matching emotes</span>
                                )}
                              </div>
                            ) : emoteProvider ? (
                              <div className="emote-picker-groups">
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
                                    <div className="emote-picker-grid">
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
                      <div className="chat-composer-footer">
                        <span />
                        <button
                          className="chat-send-button"
                          disabled={authState.status !== "signed-in" || !chatInput.trim()}
                          type="submit"
                        >
                          {replyingTo ? "Reply" : "Chat"}
                        </button>
                      </div>
                    </form>
                  </div>
                </aside>
              )}
            </div>
          </section>
        ) : activeSection === "browse" ? (
          <section className="browse-page">
            {authState.status !== "signed-in" ? (
              <div className="browse-signed-out">
                <span><Compass size={26} /></span>
                <h1>Browse Twitch categories</h1>
                <p>Twitch requires an authorized API session to provide its category directory.</p>
                <button
                  className="primary-button"
                  disabled={authBusy}
                  onClick={() => void beginSignIn()}
                  type="button"
                >
                  <LogIn size={15} /> Sign in with Twitch
                </button>
              </div>
            ) : selectedBrowseCategory ? (
              <>
                <header className="browse-category-header">
                  <button
                    className="browse-back"
                    onClick={() => {
                      setSelectedBrowseCategory(null);
                      setCategoryStreams([]);
                      setCategoryStreamCursor(undefined);
                      setBrowseError(null);
                    }}
                    title="Back to categories"
                    type="button"
                  >
                    <ChevronLeft size={22} />
                  </button>
                  <img alt="" src={selectedBrowseCategory.boxArtUrl} />
                  <div>
                    <span>LIVE STREAMS</span>
                    <h1>{selectedBrowseCategory.name}</h1>
                    <p>Channels streaming this category now</p>
                  </div>
                </header>

                {browseError && <p className="home-error" role="alert">{browseError}</p>}
                {categoryStreams.length > 0 ? (
                  <div className="stream-grid browse-stream-grid">
                    {categoryStreams.map((stream) => (
                      <button
                        className="stream-card"
                        key={stream.id}
                        onClick={() => void watchChannel(stream.login, stream)}
                        onMouseEnter={() => schedulePreresolve(stream.login)}
                        onMouseLeave={cancelPreresolve}
                        title={`Watch ${stream.displayName}`}
                        type="button"
                      >
                        <span className="stream-card-media">
                          <img
                            alt={`Preview of ${stream.displayName}'s stream`}
                            loading="lazy"
                            src={stream.thumbnailUrl}
                          />
                          <span className="stream-live-badge">LIVE</span>
                          <span className="stream-card-viewers">
                            {Intl.NumberFormat("en", {
                              notation: "compact",
                              maximumFractionDigits: 1,
                            }).format(stream.viewerCount)} viewers
                          </span>
                          <span className="stream-card-uptime">{formatUptime(stream.startedAt, uptimeNow)}</span>
                          <span className="stream-card-play">
                            <Play fill="currentColor" size={21} />
                          </span>
                        </span>
                        <span className="stream-card-info">
                          {stream.profileImageUrl ? (
                            <img className="stream-card-avatar" alt="" src={stream.profileImageUrl} />
                          ) : (
                            <span className="stream-card-avatar stream-card-avatar-fallback">
                              {stream.displayName.slice(0, 1).toUpperCase()}
                            </span>
                          )}
                          <span className="stream-card-copy">
                            <strong title={stream.title}>{stream.title}</strong>
                            <span className="stream-card-channel">{stream.displayName}</span>
                            <span className="stream-card-category">{stream.category}</span>
                            <span className="stream-card-tags">
                              <i>{stream.language.toUpperCase()}</i>
                              {visibleStreamTags(stream.tags, stream.language).map((tag) => (
                                <i key={tag} title={tag}>{tag}</i>
                              ))}
                              {stream.isMature && <i>Mature</i>}
                            </span>
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : !categoryStreamsLoading && !browseError ? (
                  <div className="home-empty-state browse-empty">
                    <span><Tv size={24} /></span>
                    <h2>No live streams found</h2>
                    <p>This category does not have any live channels right now.</p>
                  </div>
                ) : null}
                {categoryStreamsLoading && (
                  <div className="browse-loading" role="status">
                    <RefreshCw className="spin" size={18} /> Loading live streams…
                  </div>
                )}
                {categoryStreamCursor && !categoryStreamsLoading && (
                  <div
                    aria-label="Load more streams when reached"
                    className="browse-load-sentinel"
                    ref={categoryStreamLoadSentinel}
                    role="status"
                  />
                )}
              </>
            ) : (
              <>
                <header className="browse-header">
                  <div>
                    <span className="following-home-kicker">DISCOVER</span>
                    <h1>Browse</h1>
                    <p>Find a category, then choose a live channel.</p>
                  </div>
                  <form className="browse-search" onSubmit={searchBrowseCategories}>
                    <Search size={17} />
                    <input
                      aria-label="Search Twitch categories"
                      onChange={(event) => setBrowseSearch(event.target.value)}
                      placeholder="Search categories"
                      value={browseSearch}
                    />
                    {browseSearch && (
                      <button
                        aria-label="Clear category search"
                        onClick={() => {
                          setBrowseSearch("");
                          void loadBrowseCategories("", false);
                        }}
                        type="button"
                      >
                        <X size={15} />
                      </button>
                    )}
                  </form>
                </header>

                {browseError && <p className="home-error" role="alert">{browseError}</p>}
                <div className="browse-category-grid">
                  {browseCategories.map((category) => (
                    <button
                      className="browse-category-card"
                      key={category.id}
                      onClick={() => void openBrowseCategory(category)}
                      title={`Browse ${category.name}`}
                      type="button"
                    >
                      <span className="browse-category-art">
                        <img alt="" loading="lazy" src={category.boxArtUrl} />
                        <span><Play fill="currentColor" size={24} /></span>
                      </span>
                      <strong>{category.name}</strong>
                      <small>View live channels</small>
                    </button>
                  ))}
                </div>
                {browseLoading && (
                  <div className="browse-loading" role="status">
                    <RefreshCw className="spin" size={18} /> Loading categories…
                  </div>
                )}
                {!browseLoading && browseCategories.length === 0 && !browseError && (
                  <div className="home-empty-state browse-empty">
                    <span><Search size={24} /></span>
                    <h2>No categories found</h2>
                    <p>Try a different category name.</p>
                  </div>
                )}
                {browseCategoryCursor && !browseLoading && (
                  <div
                    aria-label="Load more categories when reached"
                    className="browse-load-sentinel"
                    ref={browseCategoryLoadSentinel}
                    role="status"
                  />
                )}
              </>
            )}
          </section>
        ) : activeSection === "settings" ? (
          <section className="section-page settings-page">
            <div className="section-icon violetwire-section-icon">
              <img alt="" src={violetWireIcon} />
            </div>
            <p className="section-kicker">SETTINGS</p>
            <h2>Make VioletWire yours</h2>
            <p>Connect Twitch securely, choose playback, and control optional chat providers.</p>
            <div className="settings-stack">
              <div className="settings-card">
                <div>
                  <strong>Twitch account</strong>
                  <span>
                    {authState.status === "signed-in"
                      ? `Connected as ${authState.account.displayName}`
                      : authState.status === "unconfigured"
                        ? "A developer Client ID is required."
                        : "Not signed in"}
                  </span>
                </div>
                {authState.status === "signed-in" ? (
                  <div className="settings-card-actions">
                    <button
                      className="secondary-button"
                      disabled={authBusy}
                      onClick={() => void beginSignIn()}
                      title="Authorize again to pick up newly added Twitch permissions"
                      type="button"
                    >
                      <RefreshCw size={14} /> Refresh access
                    </button>
                    <button
                      className="secondary-button"
                      disabled={authBusy}
                      onClick={() => void signOut()}
                      type="button"
                    >
                      Sign out
                    </button>
                  </div>
                ) : authState.status === "signed-out" ? (
                  <button className="primary-button" onClick={() => void beginSignIn()} type="button">
                    <LogIn size={15} /> Sign in
                  </button>
                ) : null}
              </div>
              <div className="settings-card">
                <div>
                  <strong>Twitch website session</strong>
                  <span>
                    {playbackSession.linked
                      ? `Linked${playbackSession.login ? ` as ${playbackSession.login}` : ""}. Used for higher Twitch playback qualities when available (such as Source or 1440p); Streamlink receives its token only for Twitch playback requests.`
                      : "Optional. Link a Twitch website session for higher playback qualities when available (such as Source or 1440p). This remains separate from VioletWire's official API sign-in."}
                  </span>
                </div>
                {playbackSession.linked ? (
                  <button
                    className="secondary-button"
                    disabled={playbackSessionBusy}
                    onClick={() => void unlinkPlaybackSession()}
                    type="button"
                  >
                    <Unlink size={14} /> Remove
                  </button>
                ) : (
                  <button
                    className="secondary-button"
                    disabled={playbackSessionBusy}
                    onClick={() => void linkPlaybackSession()}
                    type="button"
                  >
                    <ExternalLink size={14} />
                    {playbackSessionBusy ? "Waiting…" : "Link session"}
                  </button>
                )}
              </div>
              <div className="settings-card">
                <div>
                  <strong>7TV emotes</strong>
                  <span>
                    {sevenTvStatus
                      ? `${sevenTvStatus.emotes.length.toLocaleString()} global emotes cached${sevenTvStatus.stale ? " (stale fallback)" : ""}.`
                      : "Native provider with validated, cached global and channel emote sets."}
                  </span>
                </div>
                <button
                  className="secondary-button"
                  disabled={sevenTvBusy}
                  onClick={() => void testSevenTv()}
                  type="button"
                >
                  <RefreshCw size={14} /> {sevenTvBusy ? "Testing…" : "Test 7TV"}
                </button>
              </div>
              <div className="settings-card">
                <div>
                  <strong>Controls auto-hide delay</strong>
                  <span>
                    How long the player controls and cursor stay visible before hiding while
                    a stream is playing.
                  </span>
                </div>
                <label className="settings-slider">
                  <span>{Math.round(controlsHideDelay / 1000)}s</span>
                  <input
                    aria-label="Controls auto-hide delay in seconds"
                    max="10"
                    min="1"
                    onChange={(event) =>
                      setControlsHideDelay(Number(event.target.value) * 1000)
                    }
                    type="range"
                    value={Math.round(controlsHideDelay / 1000)}
                  />
                </label>
              </div>
              <div className="settings-card">
                <div>
                  <strong>OLED mode</strong>
                  <span>Use true black backgrounds throughout VioletWire and its Native overlays.</span>
                </div>
                <button
                  aria-pressed={oledMode}
                  className={oledMode ? "settings-switch active" : "settings-switch"}
                  onClick={toggleOledMode}
                  title="Toggle OLED mode"
                  type="button"
                >
                  <span />
                </button>
              </div>
              <div className="settings-card">
                <div>
                  <strong>VioletWire updates</strong>
                  <span>
                    {updateStatus.currentVersion
                      ? `Version ${updateStatus.currentVersion} · `
                      : ""}
                    {updateStatus.message ??
                      (updateStatus.state === "idle"
                        ? "Automatically checks GitHub Releases."
                        : "Ready to check for updates.")}
                  </span>
                </div>
                <div className="settings-card-actions">
                  <button
                    aria-label="View changelog"
                    className="secondary-button icon-button"
                    onClick={() => openChangelog(false)}
                    title="View changelog"
                    type="button"
                  >
                    <History size={16} />
                  </button>
                  <button
                    className="secondary-button"
                    disabled={
                      updateStatus.state === "disabled" ||
                      updateStatus.state === "checking" ||
                      updateStatus.state === "downloading"
                    }
                    onClick={() => {
                      if (updateStatus.state === "downloaded") {
                        window.desktop.updates.install();
                      } else {
                        void window.desktop.updates.check().then(setUpdateStatus);
                      }
                    }}
                    type="button"
                  >
                    <RefreshCw
                      className={
                        updateStatus.state === "checking" || updateStatus.state === "downloading"
                          ? "spin"
                          : undefined
                      }
                      size={14}
                    />
                    {updateStatus.state === "downloaded"
                      ? "Restart to update"
                      : updateStatus.state === "checking"
                        ? "Checking…"
                        : updateStatus.state === "downloading"
                          ? `${Math.round(updateStatus.progress ?? 0)}%`
                          : "Check now"}
                  </button>
                </div>
              </div>
            </div>
            <div className="settings-preview">
              <span>
                <strong>Default playback engine</strong>
                <small>
                  {preferredMode === "native"
                    ? nativeAvailability?.available
                      ? "Native Experimental is ready"
                      : nativeAvailability?.reason ?? "Checking Native availability…"
                    : "Twitch’s official player and controls"}
                </small>
              </span>
              <div className="mode-switch">
                <button
                  aria-pressed={preferredMode === "native"}
                  className={preferredMode === "native" ? "active experimental" : "experimental"}
                  onClick={() => void choosePreferredMode("native")}
                  type="button"
                >
                  {preferredMode === "native" && <Check size={13} />}
                  Native
                </button>
                <button
                  aria-pressed={preferredMode === "official"}
                  className={preferredMode === "official" ? "active" : ""}
                  onClick={() => void choosePreferredMode("official")}
                  type="button"
                >
                  {preferredMode === "official" && <Check size={13} />}
                  Standard
                </button>
              </div>
            </div>
            <div className="settings-card">
              <div>
                <strong>Embedded Native texture prototype</strong>
                <span>
                  Render libmpv inside VioletWire so React menus can cover the video normally.
                  This experimental Windows path automatically falls back to the existing Native
                  window if it cannot start.
                  {nativeAvailability?.textureAvailable === false &&
                    ` ${nativeAvailability.textureReason ?? ""}`}
                </span>
              </div>
              <button
                aria-pressed={experimentalTexturePlayer}
                className={
                  experimentalTexturePlayer ? "settings-switch active" : "settings-switch"
                }
                onClick={() => setExperimentalTexturePlayer((current) => !current)}
                title="Toggle the experimental embedded Native renderer"
                type="button"
              >
                <span />
              </button>
            </div>
          </section>
        ) : (
          <section className="following-home">
            <header className="following-home-header">
              <div>
                <span className="following-home-kicker">YOUR FOLLOWING</span>
                <h1>Live channels</h1>
                <p>
                  {authState.status === "signed-in"
                    ? `${liveFollowedChannels.length} followed ${
                        liveFollowedChannels.length === 1 ? "channel is" : "channels are"
                      } live`
                    : "Connect Twitch to see the channels you follow"}
                </p>
              </div>
              {authState.status === "signed-in" && (
                <button
                  className="home-refresh"
                  onClick={() => void loadFollowedChannels()}
                  type="button"
                >
                  <RefreshCw size={15} />
                  Refresh
                </button>
              )}
            </header>

            {error && <p className="home-error" role="alert">{error}</p>}

            {authState.status !== "signed-in" ? (
              <div className="home-empty-state">
                <span><Users size={24} /></span>
                <h2>Your followed streams will appear here</h2>
                <p>Sign in securely with Twitch to build your live home feed.</p>
                <button
                  className="primary-button"
                  disabled={authBusy}
                  onClick={() => void beginSignIn()}
                  type="button"
                >
                  <LogIn size={15} />
                  Sign in with Twitch
                </button>
              </div>
            ) : liveFollowedChannels.length === 0 ? (
              <div className="home-empty-state">
                <span><Tv size={24} /></span>
                <h2>No followed channels are live</h2>
                <p>Offline channels are still available in the followed list on the left.</p>
              </div>
            ) : (
              <div className="stream-grid">
                {liveFollowedChannels.map((channel) => (
                  <button
                    className="stream-card"
                    key={channel.id}
                    onClick={() => void watchChannel(channel.login, channel)}
                    onMouseEnter={() => schedulePreresolve(channel.login)}
                    onMouseLeave={cancelPreresolve}
                    title={`Watch ${channel.displayName}`}
                    type="button"
                  >
                    <span className="stream-card-media">
                      {channel.thumbnailUrl ? (
                        <img
                          alt={`Preview of ${channel.displayName}'s stream`}
                          loading="lazy"
                          src={channel.thumbnailUrl}
                        />
                      ) : (
                        <span className="stream-card-placeholder"><Tv size={30} /></span>
                      )}
                      <span className="stream-live-badge">LIVE</span>
                      <span className="stream-card-viewers">
                        {Intl.NumberFormat("en", {
                          notation: "compact",
                          maximumFractionDigits: 1,
                        }).format(channel.viewerCount)} viewers
                      </span>
                      <span className="stream-card-uptime">{formatUptime(channel.startedAt, uptimeNow)}</span>
                      <span className="stream-card-play">
                        <Play fill="currentColor" size={21} />
                      </span>
                    </span>
                    <span className="stream-card-info">
                      {channel.profileImageUrl ? (
                        <img
                          className="stream-card-avatar"
                          alt=""
                          loading="lazy"
                          src={channel.profileImageUrl}
                        />
                      ) : (
                        <span className="stream-card-avatar stream-card-avatar-fallback">
                          {channel.displayName.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <span className="stream-card-copy">
                        <strong>{channel.title || `${channel.displayName} is live`}</strong>
                        <span className="stream-card-channel">{channel.displayName}</span>
                        <span className="stream-card-category">{channel.category}</span>
                        <span className="stream-card-tags">
                          {channel.language && <i>{channel.language.toUpperCase()}</i>}
                          {visibleStreamTags(channel.tags, channel.language).map((tag) => (
                            <i key={tag} title={tag}>{tag}</i>
                          ))}
                          {channel.isMature && <i>Mature</i>}
                        </span>
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
        {settingsOpen && (
          <div
            className="settings-modal-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setSettingsOpen(false);
            }}
            role="presentation"
          >
            <section
              aria-labelledby="settings-modal-title"
              aria-modal="true"
              className="settings-modal-panel"
              role="dialog"
            >
              <header className="settings-modal-header">
                <div>
                  <span>VIOLETWIRE</span>
                  <h2 id="settings-modal-title">Settings</h2>
                  <p>Changes save automatically without closing your stream.</p>
                </div>
                <button
                  aria-label="Close settings"
                  onClick={() => setSettingsOpen(false)}
                  title="Close settings"
                  type="button"
                >
                  <X size={19} />
                </button>
              </header>
              <div className="settings-modal-content">
                <section>
                  <h3>Account</h3>
                  <div className="settings-card">
                    <div>
                      <strong>Twitch API account</strong>
                      <span>
                        {authState.status === "signed-in"
                          ? `Connected as ${authState.account.displayName}`
                          : "Not signed in"}
                      </span>
                    </div>
                    {authState.status === "signed-in" ? (
                      <div className="settings-card-actions">
                        <button
                          className="secondary-button"
                          disabled={authBusy}
                          onClick={() => void beginSignIn()}
                          title="Authorize again to pick up newly added Twitch permissions"
                          type="button"
                        >
                          <RefreshCw size={14} /> Refresh access
                        </button>
                        <button
                          className="secondary-button"
                          disabled={authBusy}
                          onClick={() => void signOut()}
                          type="button"
                        >
                          Sign out
                        </button>
                      </div>
                    ) : authState.status === "signed-out" ? (
                      <button className="primary-button" onClick={() => void beginSignIn()} type="button">
                        <LogIn size={15} /> Sign in
                      </button>
                    ) : null}
                  </div>
                  <div className="settings-card">
                    <div>
                      <strong>Twitch website session</strong>
                      <span>
                        {playbackSession.linked
                          ? `Linked${playbackSession.login ? ` as ${playbackSession.login}` : ""}. Used for higher Twitch playback qualities when available (such as Source or 1440p).`
                          : "Optional session used for higher Twitch playback qualities when available (such as Source or 1440p)."}
                      </span>
                    </div>
                    <button
                      className="secondary-button"
                      disabled={playbackSessionBusy}
                      onClick={() =>
                        playbackSession.linked
                          ? void unlinkPlaybackSession()
                          : void linkPlaybackSession()
                      }
                      type="button"
                    >
                      {playbackSession.linked ? <Unlink size={14} /> : <ExternalLink size={14} />}
                      {playbackSession.linked ? "Remove" : "Link session"}
                    </button>
                  </div>
                </section>
                <section>
                  <h3>Playback</h3>
                  <div className="settings-preview">
                    <span>
                      <strong>Default playback engine</strong>
                      <small>
                        {preferredMode === "native"
                          ? nativeAvailability?.available
                            ? "Native Experimental is ready"
                            : nativeAvailability?.reason ?? "Checking Native availability…"
                          : "Twitch’s official player and controls"}
                      </small>
                    </span>
                    <div className="mode-switch">
                      <button
                        aria-pressed={preferredMode === "native"}
                        className={preferredMode === "native" ? "active experimental" : "experimental"}
                        onClick={() => void choosePreferredMode("native")}
                        type="button"
                      >
                        Native
                      </button>
                      <button
                        aria-pressed={preferredMode === "official"}
                        className={preferredMode === "official" ? "active" : ""}
                        onClick={() => void choosePreferredMode("official")}
                        type="button"
                      >
                        Standard
                      </button>
                    </div>
                  </div>
                  <div className="settings-card">
                    <div>
                      <strong>Embedded Native texture prototype</strong>
                      <span>
                        Draw libmpv inside the app compositor instead of a separate Windows
                        surface. Applies the next time Native playback starts and falls back
                        automatically.
                        {nativeAvailability?.textureAvailable === false &&
                          ` ${nativeAvailability.textureReason ?? ""}`}
                      </span>
                    </div>
                    <button
                      aria-pressed={experimentalTexturePlayer}
                      className={
                        experimentalTexturePlayer
                          ? "settings-switch active"
                          : "settings-switch"
                      }
                      onClick={() => setExperimentalTexturePlayer((current) => !current)}
                      type="button"
                    >
                      <span />
                    </button>
                  </div>
                  <div className="settings-card">
                    <div>
                      <strong>Controls auto-hide delay</strong>
                      <span>
                        How long the player controls and cursor stay visible before hiding
                        while a stream is playing.
                      </span>
                    </div>
                    <label className="settings-slider">
                      <span>{Math.round(controlsHideDelay / 1000)}s</span>
                      <input
                        aria-label="Controls auto-hide delay in seconds"
                        max="10"
                        min="1"
                        onChange={(event) =>
                          setControlsHideDelay(Number(event.target.value) * 1000)
                        }
                        type="range"
                        value={Math.round(controlsHideDelay / 1000)}
                      />
                    </label>
                  </div>
                </section>
                <section>
                  <h3>Chat and appearance</h3>
                  <div className="settings-card">
                    <div>
                      <strong>Third-party emotes</strong>
                      <span>7TV, FrankerFaceZ, and BetterTTV global and channel sets are enabled and cached.</span>
                    </div>
                    <span className="status-pill">Enabled</span>
                  </div>
                  <div className="settings-card">
                    <div>
                      <strong>OLED mode</strong>
                      <span>Use true black backgrounds throughout VioletWire.</span>
                    </div>
                    <button
                      aria-pressed={oledMode}
                      className={oledMode ? "settings-switch active" : "settings-switch"}
                      onClick={toggleOledMode}
                      type="button"
                    >
                      <span />
                    </button>
                  </div>
                </section>
                <section>
                  <h3>Updates</h3>
                  <div className="settings-card">
                    <div>
                      <strong>VioletWire updates</strong>
                      <span>
                        {updateStatus.currentVersion
                          ? `Version ${updateStatus.currentVersion} · `
                          : ""}
                        {updateStatus.message ?? "Checks GitHub Releases automatically."}
                      </span>
                    </div>
                    <div className="settings-card-actions">
                      <button
                        aria-label="View changelog"
                        className="secondary-button icon-button"
                        onClick={() => openChangelog(true)}
                        title="View changelog"
                        type="button"
                      >
                        <History size={16} />
                      </button>
                      <button
                        className="secondary-button"
                        disabled={
                          updateStatus.state === "disabled" ||
                          updateStatus.state === "checking" ||
                          updateStatus.state === "downloading"
                        }
                        onClick={() => {
                          if (updateStatus.state === "downloaded") {
                            window.desktop.updates.install();
                          } else {
                            void window.desktop.updates.check().then(setUpdateStatus);
                          }
                        }}
                        type="button"
                      >
                        <RefreshCw size={14} />
                        {updateStatus.state === "downloaded" ? "Restart to update" : "Check now"}
                      </button>
                    </div>
                  </div>
                </section>
              </div>
            </section>
          </div>
        )}
        {changelogOpen && (
          <div
            className="settings-modal-backdrop changelog-modal-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeChangelog();
            }}
            role="presentation"
          >
            <section
              aria-labelledby="changelog-modal-title"
              aria-modal="true"
              className="settings-modal-panel changelog-modal-panel"
              role="dialog"
            >
              <header className="settings-modal-header">
                <div>
                  <span>WHAT&apos;S NEW</span>
                  <h2 id="changelog-modal-title">VioletWire changelog</h2>
                  <p>
                    {updateStatus.currentVersion
                      ? `You are running version ${updateStatus.currentVersion}.`
                      : "Additions, improvements, and fixes included with VioletWire."}
                  </p>
                </div>
                <button
                  aria-label="Close changelog"
                  onClick={closeChangelog}
                  title="Close changelog"
                  type="button"
                >
                  <X size={19} />
                </button>
              </header>
              <div className="changelog-modal-content">
                {changelogEntries.map((entry) => (
                  <article
                    className={
                      entry.version === updateStatus.currentVersion
                        ? "changelog-release current"
                        : "changelog-release"
                    }
                    key={entry.version}
                  >
                    <header>
                      <div>
                        <span>
                          {entry.version === "Unreleased"
                            ? "IN DEVELOPMENT"
                            : `VERSION ${entry.version}`}
                        </span>
                        <h3>
                          {entry.version === "Unreleased"
                            ? "Coming next"
                            : entry.version}
                        </h3>
                      </div>
                      {entry.date && <time>{entry.date}</time>}
                    </header>
                    {entry.additions.length > 0 && (
                      <section>
                        <h4>Additions</h4>
                        <ul>
                          {entry.additions.map((addition) => (
                            <li key={addition}>{addition}</li>
                          ))}
                        </ul>
                      </section>
                    )}
                    {entry.improvements.length > 0 && (
                      <section>
                        <h4>Improvements</h4>
                        <ul>
                          {entry.improvements.map((improvement) => (
                            <li key={improvement}>{improvement}</li>
                          ))}
                        </ul>
                      </section>
                    )}
                    {entry.fixes.length > 0 && (
                      <section>
                        <h4>Fixes</h4>
                        <ul>
                          {entry.fixes.map((fix) => (
                            <li key={fix}>{fix}</li>
                          ))}
                        </ul>
                      </section>
                    )}
                  </article>
                ))}
              </div>
            </section>
          </div>
        )}
        {activeChannel && miniPlayerActive && activeNativeBackend === "texture" && (
          <div
            aria-label={`Mini player: ${streamMetadata?.displayName ?? activeChannel}`}
            className="mini-player"
            ref={miniPlayerRef}
            role="region"
            style={{ ...(miniPlayerPosition ?? {}), width: miniPlayerWidth }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              if (event.target instanceof Element && event.target.closest("button")) return;
              const host = miniPlayerRef.current;
              if (!host) return;
              const rect = host.getBoundingClientRect();
              miniPlayerDragOffset.current = {
                x: event.clientX - rect.left,
                y: event.clientY - rect.top,
                moved: false,
              };
              setMiniPlayerPosition({ left: rect.left, top: rect.top });
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const offset = miniPlayerDragOffset.current;
              const host = miniPlayerRef.current;
              if (!offset || !host) return;
              const left = event.clientX - offset.x;
              const top = event.clientY - offset.y;
              const current = miniPlayerPosition;
              if (
                !offset.moved &&
                current &&
                Math.abs(left - current.left) < 4 &&
                Math.abs(top - current.top) < 4
              ) {
                return;
              }
              offset.moved = true;
              const margin = 8;
              setMiniPlayerPosition({
                left: Math.max(
                  margin,
                  Math.min(window.innerWidth - host.offsetWidth - margin, left),
                ),
                top: Math.max(
                  margin,
                  Math.min(window.innerHeight - host.offsetHeight - margin, top),
                ),
              });
            }}
            onPointerUp={() => {
              const offset = miniPlayerDragOffset.current;
              miniPlayerDragOffset.current = null;
              // A press without a drag is a click: bring the player back.
              if (offset && !offset.moved) restoreMiniPlayer();
            }}
          >
            <canvas className="native-texture-canvas mini-player-canvas" data-native-texture-canvas="main" />
            <button
              aria-label="Close the stream"
              className="mini-player-close"
              onClick={() => void closePlayer(false)}
              title="Close the stream"
              type="button"
            >
              <X size={15} />
            </button>
            <button
              aria-label="Resize mini player"
              className="mini-player-resize"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const host = miniPlayerRef.current;
                if (!host) return;
                const startWidth = miniPlayerWidth;
                const startX = event.clientX;
                const rect = host.getBoundingClientRect();
                // Grow from the top-left handle while the bottom-right corner
                // stays planted, matching the default anchor.
                const anchorRight = rect.right;
                const anchorBottom = rect.bottom;
                const move = (moveEvent: PointerEvent) => {
                  const next = Math.min(
                    560,
                    Math.max(240, startWidth + (startX - moveEvent.clientX)),
                  );
                  setMiniPlayerWidth(next);
                  setMiniPlayerPosition({
                    left: Math.max(8, anchorRight - next),
                    top: Math.max(8, anchorBottom - (next * 9) / 16),
                  });
                };
                const stop = () => {
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", stop);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", stop, { once: true });
              }}
              title="Drag to resize"
              type="button"
            >
              <MoveDiagonal2 size={13} />
            </button>
            <div className="mini-player-controls">
              <button
                aria-label={nativeState.paused ? "Play" : "Pause"}
                onClick={() =>
                  window.desktop.player.controlNative({ command: "toggle-pause" })
                }
                title={nativeState.paused ? "Play" : "Pause"}
                type="button"
              >
                {nativeState.paused ? <Play size={15} /> : <Pause size={15} />}
              </button>
              <button
                aria-label={nativeState.muted ? "Unmute" : "Mute"}
                onClick={() =>
                  window.desktop.player.controlNative({ command: "toggle-mute" })
                }
                title={nativeState.muted ? "Unmute" : "Mute"}
                type="button"
              >
                {nativeState.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
              </button>
              <span className="mini-player-title">
                {streamMetadata?.displayName ?? activeChannel}
              </span>
              <button
                aria-label="Return to the player"
                onClick={restoreMiniPlayer}
                title="Return to the player"
                type="button"
              >
                <Maximize size={14} />
              </button>
            </div>
          </div>
        )}
        {deviceAuthorization && (
          <div className="modal-backdrop" role="presentation">
            <section className="app-modal" role="dialog" aria-modal="true" aria-labelledby="signin-title">
              <button
                className="modal-close"
                onClick={() => void cancelSignIn()}
                aria-label="Cancel sign in"
                type="button"
              >
                <X size={18} />
              </button>
              <div className="modal-icon"><LogIn size={22} /></div>
              <h3 id="signin-title">Finish signing in on Twitch</h3>
              <p>
                Your browser has opened Twitch’s official activation page. Confirm the permissions and
                enter this one-time code if Twitch asks for it.
              </p>
              <button
                className="device-code"
                onClick={() => {
                  void navigator.clipboard.writeText(deviceAuthorization.userCode);
                  setCopiedCode(true);
                }}
                type="button"
              >
                <strong>{deviceAuthorization.userCode}</strong>
                {copiedCode ? <Check size={17} /> : <Copy size={17} />}
              </button>
              <span className="waiting-label"><i /> Waiting for Twitch authorization…</span>
              <button className="secondary-button" onClick={() => void cancelSignIn()} type="button">
                Cancel
              </button>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
