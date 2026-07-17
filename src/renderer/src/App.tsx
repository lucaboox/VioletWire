import {
  FormEvent,
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Clock,
  ChevronLeft,
  ChevronRight,
  Compass,
  Check,
  Copy,
  ExternalLink,
  Heart,
  Home,
  Layers,
  LogIn,
  Maximize,
  Minimize,
  Play,
  RotateCcw,
  RefreshCw,
  Scissors,
  Search,
  Settings,
  Star,
  Tv,
  Users,
  Unlink,
  X,
} from "lucide-react";
import type {
  ChatPresentation,
  NativePlayerAvailability,
  NativePlayerState,
  PlayerMode,
} from "../../shared/player";
import type {
  BrowseCategory,
  BrowseStream,
  FollowedChannel,
  TwitchSearchResults,
  StreamMetadata,
  TwitchAuthState,
  TwitchDeviceAuthorization,
  PlaybackSessionState,
} from "../../shared/twitch";
import type { EmoteSetResult } from "../../shared/emotes";
import type { ProviderEmote } from "../../shared/emotes";
import type {
  ChatBadgeAsset,
  ChatConnectionState,
  ChatMessage,
  TwitchPickerEmote,
} from "../../shared/chat";
import { formatChatTimestamp } from "../../shared/chat";
import { readableUsernameColor } from "../../shared/chat-color";
import { ChatComposerInput } from "./ChatComposerInput";
import type { AppUpdateStatus } from "../../shared/updates";
import violetWireIcon from "./assets/violetwire-icon.png";

const NATIVE_CONTROLS_HIDE_DELAY = 5_000;

type AppSection = "home" | "browse" | "settings";
type ChatLayout = "hidden" | ChatPresentation;

const signedOutState: TwitchAuthState = { status: "signed-out", account: null };
const anonymousPlaybackState: PlaybackSessionState = { linked: false };
const emptySearchResults: TwitchSearchResults = { channels: [], categories: [] };

function formatUptime(startedAt?: string): string {
  if (!startedAt) return "";
  const elapsed = Math.max(0, Date.now() - new Date(startedAt).getTime());
  const hours = Math.floor(elapsed / 3_600_000);
  const minutes = Math.floor((elapsed % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function renderSevenTvText(text: string, emotes: Map<string, ProviderEmote>, key: string): ReactNode[] {
  return text.split(/(\s+)/).map((token, index) => {
    const emote = emotes.get(token);
    const variant = emote?.variants.find((item) => item.scale === 2) ?? emote?.variants.at(-1);
    return variant ? (
      <img
        className="chat-emote"
        key={`${key}-${index}`}
        src={variant.url}
        alt={emote?.name ?? token}
        title={`${emote?.name ?? token} · 7TV`}
        loading="lazy"
      />
    ) : (
      token
    );
  });
}

function renderChatMessageText(
  message: ChatMessage,
  sevenTvEmotes: Map<string, ProviderEmote>,
): ReactNode[] {
  const ranges = [...message.twitchEmotes].sort((left, right) => left.start - right.start);
  if (ranges.length === 0) return renderSevenTvText(message.text, sevenTvEmotes, message.id);
  const output: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) {
      output.push(
        ...renderSevenTvText(
          message.text.slice(cursor, range.start),
          sevenTvEmotes,
          `${message.id}-text-${index}`,
        ),
      );
    }
    const name = message.text.slice(range.start, range.end + 1);
    output.push(
      <img
        className="chat-emote"
        key={`${message.id}-twitch-${index}`}
        src={`https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(range.id)}/default/dark/2.0`}
        alt={name}
        title={`${name} · Twitch`}
        loading="lazy"
      />,
    );
    cursor = range.end + 1;
  });
  if (cursor < message.text.length) {
    output.push(...renderSevenTvText(message.text.slice(cursor), sevenTvEmotes, `${message.id}-tail`));
  }
  return output;
}

export function App() {
  const [activeSection, setActiveSection] = useState<AppSection>("home");
  const [playerReturnSection, setPlayerReturnSection] = useState<AppSection>("home");
  const [channelInput, setChannelInput] = useState("");
  const [topSearchResults, setTopSearchResults] =
    useState<TwitchSearchResults>(emptySearchResults);
  const [topSearchOpen, setTopSearchOpen] = useState(false);
  const [topSearchLoading, setTopSearchLoading] = useState(false);
  const [activeChannel, setActiveChannel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatVisible, setChatVisible] = useState(true);
  const [chatPresentation, setChatPresentation] = useState<ChatPresentation>("side");
  const [theaterMode, setTheaterMode] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [nativeControlsVisible, setNativeControlsVisible] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>({
    state: "disabled",
    currentVersion: "0.1.0-alpha.1",
  });
  const [authState, setAuthState] = useState<TwitchAuthState>(signedOutState);
  const [authBusy, setAuthBusy] = useState(true);
  const [deviceAuthorization, setDeviceAuthorization] =
    useState<TwitchDeviceAuthorization | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [followedChannels, setFollowedChannels] = useState<FollowedChannel[]>([]);
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
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatConnectionState, setChatConnectionState] =
    useState<ChatConnectionState>("disconnected");
  const [chatInput, setChatInput] = useState("");
  const [sevenTvEmotes, setSevenTvEmotes] = useState<Map<string, ProviderEmote>>(new Map());
  const [sevenTvChannelEmoteNames, setSevenTvChannelEmoteNames] = useState<Set<string>>(new Set());
  const [twitchBadges, setTwitchBadges] = useState<Map<string, ChatBadgeAsset>>(new Map());
  const [twitchPickerEmotes, setTwitchPickerEmotes] = useState<TwitchPickerEmote[]>([]);
  const [emotePickerOpen, setEmotePickerOpen] = useState(false);
  const [emoteSearch, setEmoteSearch] = useState("");
  const [emoteProvider, setEmoteProvider] = useState<"twitch" | "7tv" | null>("twitch");
  const [chatSettingsOpen, setChatSettingsOpen] = useState(false);
  const [chatTimestamps, setChatTimestamps] = useState(
    () => window.localStorage.getItem("glint.chat.timestamps") !== "false",
  );
  const [chatHistoryLimit, setChatHistoryLimit] = useState(() => {
    const stored = Number(window.localStorage.getItem("glint.chat.historyLimit"));
    return Number.isInteger(stored) && stored >= 20 && stored <= 100 ? stored : 20;
  });
  const [revealedDeletedMessages, setRevealedDeletedMessages] = useState<Set<string>>(
    new Set(),
  );
  const [chatOpacity, setChatOpacity] = useState(() => {
    const stored = Number(window.localStorage.getItem("glint.chat.overlayOpacity"));
    return Number.isFinite(stored) && stored >= 25 && stored <= 100 ? stored : 88;
  });
  const [chatAutoScroll, setChatAutoScroll] = useState(true);
  const [oledMode, setOledMode] = useState(
    () => window.localStorage.getItem("glint.appearance.oled") === "true",
  );
  const [preferredMode, setPreferredMode] = useState<PlayerMode>(() =>
    window.localStorage.getItem("glint.playback.default") === "native" ? "native" : "official",
  );
  const [activeMode, setActiveMode] = useState<PlayerMode | null>(null);
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
  const playerHost = useRef<HTMLDivElement>(null);
  const chatHost = useRef<HTMLDivElement>(null);
  const chatMessagesHost = useRef<HTMLDivElement>(null);
  const chatInputHost = useRef<HTMLDivElement>(null);
  const chatComposerHost = useRef<HTMLFormElement>(null);
  const browseCategoryLoadSentinel = useRef<HTMLDivElement>(null);
  const categoryStreamLoadSentinel = useRef<HTMLDivElement>(null);
  const browseCategoryLoadPending = useRef(false);
  const categoryStreamLoadPending = useRef(false);
  const nativeControlsTimer = useRef<number | null>(null);
  const lastPlayerPointerPosition = useRef<{ x: number; y: number } | null>(null);
  const revealNativeControls = useCallback(() => {
    if (!activeChannel || activeMode !== "native") return;
    setNativeControlsVisible(true);
    if (nativeControlsTimer.current !== null) {
      window.clearTimeout(nativeControlsTimer.current);
    }
    nativeControlsTimer.current = window.setTimeout(
      () => setNativeControlsVisible(false),
      NATIVE_CONTROLS_HIDE_DELAY,
    );
  }, [activeChannel, activeMode]);

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
  }, [activeChannel, activeMode, chatPresentation, chatVisible, fullscreen, theaterMode]);

  useEffect(() => {
    void refreshNativeAvailability();
    return window.desktop.player.onNativeState(setNativeState);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("glint.playback.default", preferredMode);
  }, [preferredMode]);

  useEffect(() => {
    window.localStorage.setItem("glint.chat.overlayOpacity", String(chatOpacity));
  }, [chatOpacity]);

  useEffect(() => {
    window.localStorage.setItem("glint.chat.timestamps", String(chatTimestamps));
  }, [chatTimestamps]);

  useEffect(() => {
    window.localStorage.setItem("glint.chat.historyLimit", String(chatHistoryLimit));
    window.desktop.chat.setHistoryLimit(chatHistoryLimit);
  }, [chatHistoryLimit]);

  useEffect(() => {
    const syncChatAppearance = (event: StorageEvent) => {
      if (event.key === "glint.chat.timestamps") {
        setChatTimestamps(event.newValue !== "false");
      } else if (event.key === "glint.chat.historyLimit") {
        const nextLimit = Number(event.newValue);
        if (Number.isInteger(nextLimit) && nextLimit >= 20 && nextLimit <= 100) {
          setChatHistoryLimit(nextLimit);
        }
      }
    };
    window.addEventListener("storage", syncChatAppearance);
    return () => window.removeEventListener("storage", syncChatAppearance);
  }, []);

  useEffect(() => {
    const removeMessageListener = window.desktop.chat.onMessage((message) => {
      if (message.deleted) {
        setRevealedDeletedMessages((revealed) => {
          const next = new Set(revealed);
          next.delete(message.id);
          return next;
        });
      }
      setChatMessages((current) => {
        const existingIndex = current.findIndex((item) => item.id === message.id);
        if (message.deleted) {
          if (existingIndex < 0) return current;
          return current.map((item, index) =>
            index === existingIndex ? { ...item, deleted: true } : item,
          );
        }
        return existingIndex >= 0
          ? current
          : [...current, message]
              .sort((left, right) => left.sentAt - right.sentAt)
              .slice(-500);
      });
    });
    const removeStateListener = window.desktop.chat.onState(setChatConnectionState);
    return () => {
      removeMessageListener();
      removeStateListener();
    };
  }, []);

  useEffect(() => {
    if (!activeChannel) return;
    let cancelled = false;
    const requests = [window.desktop.emotes.getSevenTvGlobal()];
    if (streamMetadata?.broadcasterId) {
      requests.push(window.desktop.emotes.getSevenTvChannel(streamMetadata.broadcasterId));
    }
    void Promise.allSettled(requests).then((results) => {
      if (cancelled) return;
      const combined = new Map<string, ProviderEmote>();
      const channelNames = new Set<string>();
      // Channel results are last in the request list. Read them first so the
      // picker shows channel-specific emotes before the large global set.
      for (const result of [...results].reverse()) {
        if (result.status !== "fulfilled") continue;
        for (const emote of result.value.emotes) {
          if (!combined.has(emote.name)) combined.set(emote.name, emote);
          if (result.value.scope === "channel") channelNames.add(emote.name);
        }
      }
      setSevenTvEmotes(combined);
      setSevenTvChannelEmoteNames(channelNames);
    });
    return () => {
      cancelled = true;
    };
  }, [activeChannel, streamMetadata?.broadcasterId]);

  useEffect(() => {
    if (!activeChannel || authState.status !== "signed-in") return;
    let cancelled = false;
    void window.desktop.chat.getAssets(activeChannel)
      .then((assets) => {
        if (cancelled) return;
        setTwitchBadges(new Map(assets.badges.map((badge) => [badge.key, badge])));
        setTwitchPickerEmotes(assets.emotes);
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
  }, [activeChannel, authState.status]);

  const pickerEmoteGroups = useMemo(() => {
    const query = emoteSearch.trim().toLowerCase();
    const twitch = twitchPickerEmotes
      .filter((emote) => !query || emote.name.toLowerCase().includes(query))
      .map((emote) => ({
        name: emote.name,
        imageUrl: emote.imageUrl,
        provider: "Twitch",
        scope: emote.scope,
        subscriptionOnly: emote.subscriptionOnly,
        wide: false,
      }));
    const sevenTv = [...sevenTvEmotes.values()]
      .filter((emote) => !query || emote.name.toLowerCase().includes(query))
      .map((emote) => ({
        name: emote.name,
        imageUrl: emote.variants.find((item) => item.scale === 2)?.url ?? emote.variants.at(-1)?.url ?? "",
        provider: "7TV",
        scope: sevenTvChannelEmoteNames.has(emote.name) ? "channel" as const : "global" as const,
        subscriptionOnly: false,
        wide: (emote.variants.at(-1)?.width ?? 0) >= (emote.variants.at(-1)?.height ?? 1) * 1.8,
      }));
    const visibleTwitch = twitch.filter((emote) => emote.imageUrl);
    const visibleSevenTv = sevenTv.filter((emote) => emote.imageUrl);
    return {
      twitch: visibleTwitch,
      sevenTv: visibleSevenTv,
      twitchChannel: visibleTwitch.filter((emote) => emote.scope === "channel"),
      twitchGlobal: visibleTwitch.filter((emote) => emote.scope === "global"),
      sevenTvChannel: visibleSevenTv.filter((emote) => emote.scope === "channel"),
      sevenTvGlobal: visibleSevenTv.filter((emote) => emote.scope === "global"),
    };
  }, [emoteSearch, sevenTvChannelEmoteNames, sevenTvEmotes, twitchPickerEmotes]);
  const searchedPickerEmotes = useMemo(
    () =>
      emoteSearch.trim()
        ? [...pickerEmoteGroups.twitch, ...pickerEmoteGroups.sevenTv]
        : null,
    [emoteSearch, pickerEmoteGroups],
  );
  const chatHistoryBoundary = chatMessages.reduce(
    (lastIndex, message, index) => (message.historical ? index : lastIndex),
    -1,
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

  function handleChatScroll() {
    const host = chatMessagesHost.current;
    if (!host) return;
    const distanceFromBottom = host.scrollHeight - host.scrollTop - host.clientHeight;
    setChatAutoScroll(distanceFromBottom < 36);
  }

  function scrollChatToCurrent() {
    const host = chatMessagesHost.current;
    if (!host) return;
    host.scrollTo({ top: host.scrollHeight, behavior: "smooth" });
    setChatAutoScroll(true);
  }

  function toggleOledMode(): void {
    setOledMode((current) => {
      const next = !current;
      window.localStorage.setItem("glint.appearance.oled", String(next));
      return next;
    });
  }

  function revealChatComposer() {
    if (!chatAutoScroll) return;
    window.requestAnimationFrame(() => {
      const host = chatMessagesHost.current;
      if (host) host.scrollTop = host.scrollHeight;
    });
  }

  useEffect(() => {
    void loadAuthState();
    void window.desktop.twitch.getPlaybackSessionState().then(setPlaybackSession);
    void window.desktop.updates.getStatus().then(setUpdateStatus);
    return window.desktop.updates.onStatus(setUpdateStatus);
  }, []);

  useEffect(() => {
    if (authState.status === "signed-in") void loadFollowedChannels();
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
    }, 60_000);
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
      NATIVE_CONTROLS_HIDE_DELAY,
    );
    return () => {
      if (nativeControlsTimer.current !== null) {
        window.clearTimeout(nativeControlsTimer.current);
        nativeControlsTimer.current = null;
      }
    };
  }, [activeChannel, activeMode]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!activeChannel) return;

    const handleKeyDown = (event: KeyboardEvent) => {
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
        window.desktop.player.controlNative({ command: "toggle-pause" });
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
    revealNativeControls,
    theaterMode,
  ]);

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
  ]);

  useEffect(
    () =>
      window.desktop.player.onNativeControlAction((action) => {
        if (action === "activity") {
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
    [fullscreen, revealNativeControls],
  );

  async function refreshNativeAvailability() {
    const availability = await window.desktop.player.getNativeAvailability();
    setNativeAvailability(availability);
  }

  function choosePreferredMode(mode: PlayerMode) {
    setPreferredMode(mode);
    window.localStorage.setItem("glint.playback.default", mode);
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

  async function loadFollowedChannels() {
    try {
      setFollowedChannels(await window.desktop.twitch.getFollowedChannels());
    } catch (reason) {
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
      setActiveSection("settings");
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
      "Sign in only in the dedicated Twitch window. This experimental session is used only for native playback.",
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
    await watchChannel(channelInput);
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
    if (activeChannel) await closePlayer();
    setActiveSection("browse");
    await openBrowseCategory(category);
  }

  function chooseSearchChannel(login: string) {
    setTopSearchOpen(false);
    void watchChannel(login);
  }

  async function watchChannel(channel: string) {
    setError(null);
    setStreamMetadata(null);
    setChatMessages([]);
    setRevealedDeletedMessages(new Set());
    setChatAutoScroll(true);
    setChannelInput(channel);
    try {
      const result = await window.desktop.player.open(channel, preferredMode);
      setPlayerReturnSection(activeSection);
      setActiveSection("home");
      setActiveChannel(result.channel);
      setActiveMode(result.mode);
      setNativeControlsVisible(true);
      setChatVisible(true);
      setChatPresentation("side");
      setTheaterMode(false);
      if (result.fallbackReason) {
        setNotice(`Native player unavailable: ${result.fallbackReason} Using the official player.`);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message || "Unable to open the Twitch player.");
    }
  }

  async function closePlayer() {
    if (fullscreen) await window.desktop.player.setFullscreen(false);
    await window.desktop.player.close();
    setFullscreen(false);
    setTheaterMode(false);
    setActiveChannel(null);
    setActiveMode(null);
    setActiveSection(playerReturnSection);
  }

  async function navigateTo(section: AppSection) {
    if (activeChannel) await closePlayer();
    if (section === "browse" && activeSection === "browse") {
      setSelectedBrowseCategory(null);
      setCategoryStreams([]);
      setCategoryStreamCursor(undefined);
      setBrowseError(null);
    }
    setActiveSection(section);
  }

  async function switchPlayerMode(mode: PlayerMode) {
    setPreferredMode(mode);
    if (!activeChannel || mode === activeMode) return;

    try {
      const result = await window.desktop.player.open(activeChannel, mode);
      setActiveMode(result.mode);
      setNativeControlsVisible(true);
      if (result.fallbackReason) {
        setNotice(`Native player unavailable: ${result.fallbackReason} Using the official player.`);
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
      setNotice(`${label} opened in VioletWire's isolated Twitch window.`);
    } catch {
      setNotice(`Unable to open ${label.toLowerCase()}.`);
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
    if (!activeChannel || !chatInput.trim()) return;
    if (authState.status !== "signed-in") {
      setNotice("Sign in with Twitch to send chat messages.");
      return;
    }
    const message = chatInput.trim();
    setChatInput("");
    try {
      await window.desktop.chat.send(activeChannel, message);
    } catch (reason) {
      setChatInput(message);
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

  function renderFollowedChannel(channel: FollowedChannel) {
    return (
      <button
        className="followed-channel"
        key={channel.id}
        onClick={() => void watchChannel(channel.login)}
        title={channel.displayName}
        type="button"
      >
        <span className="channel-avatar">
          <img alt="" src={channel.profileImageUrl} />
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
        theaterMode ? "theater-mode" : "",
        fullscreen ? "fullscreen-mode" : "",
        fullscreen && !nativeControlsVisible ? "controls-hidden" : "",
      ].join(" ")}
    >
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><img alt="" src={violetWireIcon} /></span>
          <span>VioletWire</span>
        </div>

        <section className="followed-rail" aria-labelledby="followed-heading">
          <div className="rail-heading">
            <span id="followed-heading">Followed channels</span>
            <Users size={15} aria-hidden="true" />
          </div>
          <div className="followed-list">
            {liveFollowedChannels.length > 0 && (
              <>
                <div className="followed-group-label">
                  <span>Live</span>
                  <b>{liveFollowedChannels.length}</b>
                </div>
                {liveFollowedChannels.map(renderFollowedChannel)}
              </>
            )}
            {offlineFollowedChannels.length > 0 && (
              <>
                <div className="followed-group-label offline">
                  <span>Offline</span>
                  <b>{offlineFollowedChannels.length}</b>
                </div>
                {offlineFollowedChannels.map(renderFollowedChannel)}
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
                            onClick={() => chooseSearchChannel(channel.login)}
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
                                {channel.isLive ? channel.category || "Live channel" : "Offline"}
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
                        void watchChannel(channelInput);
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
              aria-pressed={(activeChannel ? activeMode : preferredMode) === "official"}
              className={(activeChannel ? activeMode : preferredMode) === "official" ? "active" : ""}
              onClick={() =>
                activeChannel
                  ? void switchPlayerMode("official")
                  : choosePreferredMode("official")
              }
              title="Use Twitch's Standard player"
              type="button"
            >
              Standard
            </button>
            <button
              aria-pressed={(activeChannel ? activeMode : preferredMode) === "native"}
              className={
                (activeChannel ? activeMode : preferredMode) === "native"
                  ? "active experimental"
                  : "experimental"
              }
              onClick={() =>
                activeChannel ? void switchPlayerMode("native") : choosePreferredMode("native")
              }
              title="Use the Native player"
              type="button"
            >
              Native
            </button>
          </div>
          <button
            className="sign-in"
            disabled={authBusy}
            onClick={() =>
              authState.status === "signed-in" ? void navigateTo("settings") : void beginSignIn()
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
            aria-current={activeSection === "settings" ? "page" : undefined}
            aria-label="Settings"
            className={
              activeSection === "settings"
                ? "top-settings-button active"
                : "top-settings-button"
            }
            onClick={() => void navigateTo("settings")}
            title="Settings"
            type="button"
          >
            <Settings size={18} />
          </button>
          </div>
        </header>

        {activeChannel ? (
          <section
            className="player-page"
            onMouseMove={(event) => {
              const previous = lastPlayerPointerPosition.current;
              if (previous?.x === event.clientX && previous.y === event.clientY) return;
              lastPlayerPointerPosition.current = { x: event.clientX, y: event.clientY };
              revealNativeControls();
            }}
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
                onClick={closePlayer}
                title="Back"
                type="button"
              >
                <ChevronLeft size={25} />
              </button>
              {streamMetadata?.profileImageUrl ? (
                <img className="stream-avatar" alt="" src={streamMetadata.profileImageUrl} />
              ) : (
                <div className="live-dot" />
              )}
              {streamMetadata?.isLive && (
                <div className="toolbar-stream-stats">
                  <span className="toolbar-viewers" title="Current viewers">
                    <Users size={14} />
                    <strong>
                      {Intl.NumberFormat("en-US").format(streamMetadata.viewerCount ?? 0)}
                    </strong>
                  </span>
                  <span className="toolbar-uptime" title="Stream uptime">
                    <Clock size={13} />
                    {formatUptime(streamMetadata.startedAt)}
                  </span>
                </div>
              )}
              <div className="channel-identity">
                <div>
                  <strong>{streamMetadata?.displayName ?? activeChannel}</strong>
                  <span className="stream-title" title={streamMetadata?.title}>
                    {streamMetadata?.title ??
                      (activeMode === "native"
                        ? "Native playback · experimental"
                        : "Official Twitch playback")}
                  </span>
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
                  aria-label={streamMetadata?.subscription?.isSubscribed ? "Subscribed" : "Subscribe"}
                  aria-pressed={Boolean(streamMetadata?.subscription?.isSubscribed)}
                  className={streamMetadata?.subscription?.isSubscribed ? "toolbar-icon subscribe-action active" : "toolbar-icon subscribe-action"}
                  onClick={() => void openChannelAction("subscribe", "Subscription")}
                  title="Toggle Twitch subscription panel"
                  type="button"
                >
                  <Star fill={streamMetadata?.subscription?.isSubscribed ? "currentColor" : "none"} size={17} />
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
                  onClick={() => void openChannelAction("channel", "Channel")}
                  title="Open channel on Twitch"
                  type="button"
                >
                  <ExternalLink size={16} />
                </button>
              </div>
              </div>
              <div className="player-chat-actions" aria-label="Chat layout controls">
                <button
                  aria-label={chatVisible && chatPresentation === "overlay" ? "Use side chat" : "Overlay chat"}
                  aria-pressed={chatVisible && chatPresentation === "overlay"}
                  className={
                    chatVisible && chatPresentation === "overlay"
                      ? "toolbar-icon active"
                      : "toolbar-icon"
                  }
                  onClick={() =>
                    setChatLayout(
                      chatVisible && chatPresentation === "overlay" ? "side" : "overlay",
                    )
                  }
                  title={
                    chatVisible && chatPresentation === "overlay"
                      ? "Move chat beside the video"
                      : "Overlay chat on the video"
                  }
                  type="button"
                >
                  <Layers size={17} />
                </button>
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
                  <ChevronLeft size={19} />
                </button>
              )}
              <div className={activeMode === "native" ? "video-column native" : "video-column"}>
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
                      src={`twitch-player.html?channel=${encodeURIComponent(activeChannel)}`}
                      title={`Official Twitch player for ${activeChannel}`}
                    />
                  )}
                  {activeMode === "native" && nativeState.status !== "playing" && (
                    <div className="native-player-placeholder">
                      <span className={`native-status-orb ${nativeState.status}`} />
                      <strong>
                        {nativeState.error === "Stream is offline."
                          ? "Stream offline"
                          : nativeState.status === "error"
                            ? "Native player could not start"
                          : "Starting native player"}
                      </strong>
                      <p>
                        {nativeState.error ??
                          "Streamlink is resolving the Twitch stream and connecting it to mpv."}
                      </p>
                      {nativeState.status === "error" && (
                        <button onClick={() => void retryNativePlayer()} type="button">
                          <RotateCcw size={15} /> Retry
                        </button>
                      )}
                    </div>
                  )}
                </div>

              </div>
              {chatVisible && !(activeMode === "native" && chatPresentation === "overlay") && (
                <aside
                  className={chatPresentation === "overlay" ? "chat-panel overlay" : "chat-panel"}
                  aria-label={`${activeChannel} chat`}
                  onMouseEnter={revealChatComposer}
                  style={
                    chatPresentation === "overlay"
                      ? { backgroundColor: `rgb(24 24 27 / ${chatOpacity}%)` }
                      : undefined
                  }
                >
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
                          <label className="chat-toggle-setting">
                            <span>Show timestamps</span>
                            <input
                              checked={chatTimestamps}
                              onChange={(event) => setChatTimestamps(event.target.checked)}
                              type="checkbox"
                            />
                          </label>
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
                      <ChevronRight size={18} />
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
                          <label className="chat-toggle-setting">
                            <span>Show timestamps</span>
                            <input
                              checked={chatTimestamps}
                              onChange={(event) => setChatTimestamps(event.target.checked)}
                              type="checkbox"
                            />
                          </label>
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
                        <div className="native-chat-message">
                          {chatTimestamps && (
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
                                const badge = twitchBadges.get(badgeKey);
                                return badge ? (
                                  <img
                                    alt={badge.title}
                                    key={badgeKey}
                                    loading="lazy"
                                    src={badge.imageUrl}
                                    title={badge.title}
                                  />
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
                          <span className="chat-colon">:</span>{" "}
                          <span className="native-chat-text">
                            {message.deleted &&
                            !revealedDeletedMessages.has(message.id) ? (
                              <button
                                className="deleted-message-toggle"
                                onClick={() =>
                                  setRevealedDeletedMessages((revealed) => {
                                    const next = new Set(revealed);
                                    next.add(message.id);
                                    return next;
                                  })
                                }
                                title="Show the deleted message locally"
                                type="button"
                              >
                                &lt;deleted&gt;
                              </button>
                            ) : (
                              renderChatMessageText(message, sevenTvEmotes)
                            )}
                          </span>
                        </div>
                        {index === chatHistoryBoundary && (
                          <div className="live-chat-divider" role="separator">
                            <span>Live chat</span>
                          </div>
                        )}
                        </Fragment>
                      ))}
                    </div>
                    {!chatAutoScroll && (
                      <button
                        className="scroll-to-current"
                        onClick={scrollChatToCurrent}
                        type="button"
                      >
                        Scroll to current
                      </button>
                    )}
                    <form className="native-chat-input" onSubmit={sendChatMessage} ref={chatComposerHost}>
                      <div className="chat-composer-box">
                        <ChatComposerInput
                          aria-label="Send a chat message"
                          disabled={authState.status !== "signed-in"}
                          maxLength={500}
                          onValueChange={setChatInput}
                          placeholder={
                            authState.status === "signed-in"
                              ? "Send a message"
                              : "Sign in to send messages"
                          }
                          ref={chatInputHost}
                          sevenTvEmotes={sevenTvEmotes}
                          twitchEmotes={twitchPickerEmotes}
                          value={chatInput}
                        />
                        <div className="chat-composer-inline-actions">
                          <div className="emote-picker-anchor">
                            <button
                              aria-expanded={emotePickerOpen}
                              aria-label="Choose Twitch and 7TV emotes"
                              className={emotePickerOpen ? "emote-picker-button active" : "emote-picker-button"}
                              onClick={() => setEmotePickerOpen((current) => !current)}
                              title="Twitch and 7TV emotes"
                              type="button"
                            >
                              <span className="seven-tv-mark">7TV</span>
                            </button>
                            {emotePickerOpen && (
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
                                {searchedPickerEmotes.map((emote) => (
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
                                    <img alt="" loading="lazy" src={emote.imageUrl} />
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
                                      {group.emotes.map((emote) => (
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
                                          <img alt="" loading="lazy" src={emote.imageUrl} />
                                        </button>
                                      ))}
                                    </div>
                                  </details>
                                ))}
                              </div>
                            ) : null}
                              </div>
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
                          Chat
                        </button>
                      </div>
                    </form>
                  </div>
                </aside>
              )}
            </div>
            {notice && <div className="player-notice" role="status">{notice}</div>}
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
                        onClick={() => void watchChannel(stream.login)}
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
                          <span className="stream-card-uptime">{formatUptime(stream.startedAt)}</span>
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
                  <button className="secondary-button" onClick={() => void signOut()} type="button">
                    Sign out
                  </button>
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
                      ? `Linked${playbackSession.login ? ` as ${playbackSession.login}` : ""}. The Standard player shares this website session; Streamlink receives its token only for Twitch playback requests.`
                      : "Optional. Sign in once if you want the Standard player to recognize your Twitch website account. This remains separate from VioletWire's official API sign-in."}
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
                    Version {updateStatus.currentVersion}
                    {" · "}
                    {updateStatus.message ??
                      (updateStatus.state === "idle"
                        ? "Automatically checks GitHub Releases."
                        : "Ready to check for updates.")}
                  </span>
                </div>
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
                  aria-pressed={preferredMode === "official"}
                  className={preferredMode === "official" ? "active" : ""}
                  onClick={() => choosePreferredMode("official")}
                  type="button"
                >
                  {preferredMode === "official" && <Check size={13} />}
                  Standard
                </button>
                <button
                  aria-pressed={preferredMode === "native"}
                  className={preferredMode === "native" ? "active experimental" : "experimental"}
                  onClick={() => choosePreferredMode("native")}
                  type="button"
                >
                  {preferredMode === "native" && <Check size={13} />}
                  Native
                </button>
              </div>
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
                    onClick={() => void watchChannel(channel.login)}
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
                      <span className="stream-card-uptime">{formatUptime(channel.startedAt)}</span>
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
