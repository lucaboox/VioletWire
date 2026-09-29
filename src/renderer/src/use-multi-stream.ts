import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatConnectionState, ChatMessage } from "../../shared/chat";
import { applyChatMessageBatch } from "../../shared/chat-messages";
import { parseChannelKey } from "../../shared/platform";
import {
  MAX_MULTISTREAM_TILES,
  MULTISTREAM_PRESET_LIMIT,
  type MultiStreamTileState,
  type NativeQualityValue,
} from "../../shared/player";
import type { MultiStreamPreset } from "../../shared/preferences";
import { isChatterBlocked, useBlockedChatters } from "./blocked-chatters";
import { shouldAlertMention, type ViewerNames } from "./mention-alert";
import {
  moveTilePosition,
  swapTilePositions,
  tileDisplayOrder,
} from "./multi-stream-order";

/** How long chat is gathered before the tab on screen is redrawn. */
const CHAT_FLUSH_INTERVAL = 150;

/**
 * What a chat tab that is not on screen has been sent since it was last
 * looked at. A mention outranks ordinary messages and is never downgraded.
 */
export type TabActivity = "message" | "mention";

export interface MultiStreamOptions {
  fullscreen: boolean;
  /** Shows the viewer a short message. */
  notify: (message: string) => void;
  /** The viewer's name on each service, to spot mentions in any tile's chat. */
  viewerNames: ViewerNames;
  /** A live message naming the viewer arrived in one of the tiles' chats. */
  onMention: (message: ChatMessage) => void;
}

function upsertTile(
  current: MultiStreamTileState[],
  tile: MultiStreamTileState,
): MultiStreamTileState[] {
  const next = current.filter((existing) => existing.id !== tile.id);
  next.push(tile);
  next.sort((left, right) => left.id - right.id);
  return next;
}

function withoutActivity(
  current: ReadonlyMap<string, TabActivity>,
  channel: string | null,
): ReadonlyMap<string, TabActivity> {
  if (channel === null || !current.has(channel)) return current;
  const next = new Map(current);
  next.delete(channel);
  return next;
}

/**
 * Everything multistream keeps between renders: the tiles and where each is
 * drawn, the saved line-ups, and the tabbed chat over every tile's channel.
 * App renders it; the rules about it live here.
 *
 * Two things are arranged so the grid does not redraw the whole app when it
 * has no reason to. Every tile's chat is buffered outside React state and only
 * the tab on screen is copied in, so a busy chat in a tab nobody is reading
 * costs nothing but a flag on its tab. And every callback handed to the grid
 * keeps one identity for the life of the view, which is what lets each tile
 * skip a render when only another tile changed.
 */
export function useMultiStream(options: MultiStreamOptions) {
  const [active, setActive] = useState(false);
  const [theater, setTheater] = useState(false);
  const [tiles, setTiles] = useState<MultiStreamTileState[]>([]);
  // Tile ids in the arrangement the viewer dragged them into. The tiles keep
  // their place in the DOM so a swap never re-attaches a playing video; this
  // list only decides which grid cell each one is drawn in.
  const [tileOrder, setTileOrder] = useState<number[]>([]);
  // Saved line-ups, mirrored from preferences so the bar can list them.
  const [presets, setPresets] = useState<MultiStreamPreset[]>([]);
  // Whether the grid keeps its chat column. Held for the run of the app like
  // the single player's own chat toggle rather than saved.
  const [chatVisible, setChatVisible] = useState(true);
  // Which tile's chat the tabbed chat is showing, as the viewer last chose it.
  const [chosenChatChannel, setChosenChatChannel] = useState<string | null>(null);
  const [broadcasterResult, setBroadcasterResult] = useState<{
    channel: string;
    id: string | null;
  } | null>(null);
  const [chatStates, setChatStates] = useState<Map<string, ChatConnectionState>>(new Map());
  const [chatPaused, setChatPaused] = useState(false);
  // The tab on screen's messages — the only chat kept in React state.
  const [shownChat, setShownChat] = useState<{
    channel: string | null;
    messages: ChatMessage[];
  }>({ channel: null, messages: [] });
  const [tabActivity, setTabActivity] = useState<ReadonlyMap<string, TabActivity>>(
    () => new Map(),
  );

  const chatHost = useRef<HTMLDivElement>(null);
  const chatContent = useRef<HTMLDivElement>(null);
  const chatPinned = useRef(true);
  const chatUserScrollAt = useRef(0);
  // Every tile's chat, and what has arrived since the last flush.
  const chatStore = useRef(new Map<string, ChatMessage[]>());
  const chatPending = useRef(new Map<string, ChatMessage[]>());
  // The channel whose messages are in shownChat, and the one that should be.
  const shownChannel = useRef<string | null>(null);
  const wantedChannel = useRef<string | null>(null);
  // Bumped by every start and stop, so a line-up that finishes starting after
  // the viewer has already left does not reappear.
  const startGeneration = useRef(0);
  const tilesRef = useRef(tiles);
  const orderedTilesRef = useRef<MultiStreamTileState[]>([]);
  const presetsRef = useRef(presets);
  const optionsRef = useRef(options);

  useEffect(() => {
    optionsRef.current = options;
  });

  // Tile ids as the grid draws them: the dragged arrangement, with any tile
  // added since put after it.
  const shownOrder = useMemo(
    () => tileDisplayOrder(tiles.map((tile) => tile.id), tileOrder),
    [tiles, tileOrder],
  );
  // The same tiles in that order, so the chat tabs read left to right like the
  // grid does and a dragged stream takes its tab along with it.
  const orderedTiles = useMemo(
    () =>
      shownOrder
        .map((id) => tiles.find((tile) => tile.id === id))
        .filter((tile): tile is MultiStreamTileState => tile !== undefined),
    [shownOrder, tiles],
  );
  // The selected chat tab, falling back to the tile with audio (or the first)
  // when the chosen one has gone — derived rather than stored so no effect
  // writes it.
  const chatChannel = useMemo(() => {
    if (!active) return null;
    if (chosenChatChannel && tiles.some((tile) => tile.channel === chosenChatChannel)) {
      return chosenChatChannel;
    }
    const fallback = tiles.find((tile) => tile.active) ?? orderedTiles[0];
    return fallback ? fallback.channel : null;
  }, [active, chosenChatChannel, tiles, orderedTiles]);

  useEffect(() => {
    tilesRef.current = tiles;
    orderedTilesRef.current = orderedTiles;
    presetsRef.current = presets;
    wantedChannel.current = chatChannel;
  }, [tiles, orderedTiles, presets, chatChannel]);

  // The chat feed engine is not used here, so the blocked list is applied to
  // what is shown as well as to what raises a tab's flag.
  const blockedChatters = useBlockedChatters();
  const displayMessages = useMemo(() => {
    const messages = shownChat.channel === chatChannel ? shownChat.messages : [];
    return blockedChatters.size === 0
      ? messages
      : messages.filter((message) => !isChatterBlocked(message.login));
  }, [blockedChatters, chatChannel, shownChat]);

  const chatBroadcasterId =
    broadcasterResult?.channel === chatChannel ? broadcasterResult.id : null;

  const resetChat = useCallback(() => {
    chatPending.current = new Map();
    chatStore.current = new Map();
    shownChannel.current = null;
    setShownChat({ channel: null, messages: [] });
    setChatStates(new Map());
    setTabActivity(new Map());
    setChosenChatChannel(null);
  }, []);

  // Keep the tile list in step with the main process: upsert each tile by id,
  // and drop the ones it reports removed — from the arrangement as well, so a
  // stream added later goes after the others instead of inheriting a cell.
  useEffect(() => {
    const removeState = window.desktop.player.onMultiTileState((tile) => {
      setTiles((current) => upsertTile(current, tile));
    });
    const removeRemoved = window.desktop.player.onMultiTileRemoved((id) => {
      setTiles((current) => current.filter((tile) => tile.id !== id));
      setTileOrder((current) => current.filter((entry) => entry !== id));
    });
    return () => {
      removeState();
      removeRemoved();
    };
  }, []);

  // The selected tab's broadcaster id, for its channel emotes and badges. The
  // messages themselves come from the always-connected per-channel buffers.
  useEffect(() => {
    if (!active || !chatChannel) return;
    const target = parseChannelKey(chatChannel);
    let cancelled = false;
    const request =
      target.platform === "kick"
        ? window.desktop.kick.getChannel(target.login).then((channel) => channel?.id ?? null)
        : window.desktop.twitch
            .getStreamMetadata(chatChannel)
            .then((meta) => meta?.broadcasterId ?? null);
    void request
      .then((broadcasterId) => {
        if (!cancelled) setBroadcasterResult({ channel: chatChannel, id: broadcasterId });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [active, chatChannel]);

  // Every tile's chat. Listeners stay registered so nothing is missed between
  // starting multistream and the flush below starting; they are idle when the
  // main process is not sending. A mention sounds as it arrives rather than
  // waiting for the batch.
  useEffect(() => {
    const removeMessage = window.desktop.player.onMultiChatMessage((channel, message) => {
      const pending = chatPending.current.get(channel);
      if (pending) pending.push(message);
      else chatPending.current.set(channel, [message]);
      if (
        !isChatterBlocked(message.login) &&
        shouldAlertMention(message, optionsRef.current.viewerNames, [channel])
      ) {
        optionsRef.current.onMention(message);
      }
    });
    const removeState = window.desktop.player.onMultiChatState((channel, state) => {
      setChatStates((current) => {
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

  // Apply what has arrived. Only the tab on screen is copied into state; the
  // others just have their flag raised, once, the first time something new
  // turns up in them. This also catches the tab on screen changing without a
  // click — when the one being read is closed — within one tick.
  useEffect(() => {
    if (!active) return;
    const flush = window.setInterval(() => {
      const wanted = wantedChannel.current;
      const batch = chatPending.current;
      if (batch.size === 0 && shownChannel.current === wanted) return;
      chatPending.current = new Map();
      let shownChanged = shownChannel.current !== wanted;
      const activity = new Map<string, TabActivity>();
      const names = optionsRef.current.viewerNames;
      for (const [channel, messages] of batch) {
        chatStore.current.set(
          channel,
          applyChatMessageBatch(chatStore.current.get(channel) ?? [], messages),
        );
        if (channel === wanted) {
          shownChanged = true;
          continue;
        }
        for (const message of messages) {
          if (message.historical || message.deleted || isChatterBlocked(message.login)) continue;
          if (shouldAlertMention(message, names, [channel])) {
            activity.set(channel, "mention");
            break;
          }
          activity.set(channel, "message");
        }
      }
      if (shownChanged) {
        shownChannel.current = wanted;
        setShownChat({
          channel: wanted,
          messages: wanted === null ? [] : (chatStore.current.get(wanted) ?? []),
        });
        // A tab that has come on screen has been read.
        setTabActivity((current) => withoutActivity(current, wanted));
      }
      if (activity.size > 0) {
        setTabActivity((current) => {
          let next: Map<string, TabActivity> | null = null;
          for (const [channel, kind] of activity) {
            const had = current.get(channel);
            if (had === kind || had === "mention") continue;
            next ??= new Map(current);
            next.set(channel, kind);
          }
          return next ?? current;
        });
      }
    }, CHAT_FLUSH_INTERVAL);
    return () => window.clearInterval(flush);
  }, [active]);

  const selectChatTab = useCallback((channel: string) => {
    setChosenChatChannel(channel);
    // Shown at once from the buffer rather than on the next tick. The flush is
    // told too, so a tick landing before the next render cannot put the
    // previous tab back.
    wantedChannel.current = channel;
    shownChannel.current = channel;
    setShownChat({ channel, messages: chatStore.current.get(channel) ?? [] });
    setTabActivity((current) => withoutActivity(current, channel));
  }, []);

  const scrollChatToBottom = useCallback(() => {
    const host = chatHost.current;
    if (host) host.scrollTop = host.scrollHeight;
    chatPinned.current = true;
    setChatPaused(false);
  }, []);

  // Only a real wheel or pointer scroll pauses the feed. Programmatic scrolls
  // (tab switches, jump-to-bottom) and content-driven reflow (emote images
  // loading) must not — otherwise switching chats can leave it stuck
  // "scrolled up".
  const handleChatScroll = useCallback(() => {
    const host = chatHost.current;
    if (!host) return;
    const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 40;
    if (atBottom) {
      chatPinned.current = true;
      setChatPaused(false);
      return;
    }
    if (Date.now() - chatUserScrollAt.current < 700) {
      chatPinned.current = false;
      setChatPaused(true);
    }
  }, []);

  const noteChatUserScroll = useCallback(() => {
    chatUserScrollAt.current = Date.now();
  }, []);

  // A new tab starts pinned to the newest message. Clear the paused state
  // directly (a short new chat may not fire a scroll event to clear it) and
  // drop any stale scroll intent so the first reflow can't re-pause it.
  useLayoutEffect(() => {
    chatPinned.current = true;
    chatUserScrollAt.current = 0;
    const host = chatHost.current;
    if (host) host.scrollTop = host.scrollHeight;
    const frame = requestAnimationFrame(() => setChatPaused(false));
    return () => cancelAnimationFrame(frame);
  }, [chatChannel, chatVisible]);

  // Land on the newest message in the same commit that adds it, before the
  // browser paints — exactly what the side chat's feed does (see useChatFeed).
  // The ResizeObserver below cannot cover this on its own: once a busy chat
  // fills its buffer every batch drops as many rows off the top as it appends,
  // so the content box often does not change size at all, no observation
  // fires, and the browser's own scroll anchoring holds the view where the
  // trimmed rows used to be — leaving the newest lines below the fold until
  // some later batch happens to change the height.
  useLayoutEffect(() => {
    if (!chatPinned.current) return;
    const host = chatHost.current;
    if (host) host.scrollTop = host.scrollHeight;
  }, [displayMessages]);

  // Keep the chat glued to the bottom while pinned even as content grows — new
  // messages and, crucially, late-loading emote/badge images that expand rows
  // after they first render.
  useEffect(() => {
    if (!active) return;
    const host = chatHost.current;
    const content = chatContent.current;
    if (!host || !content) return;
    const observer = new ResizeObserver(() => {
      if (chatPinned.current) host.scrollTop = host.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
    // Hiding the chat throws these nodes away, so bringing it back has to
    // observe the new ones.
  }, [active, chatChannel, chatVisible]);

  // T = theater, F = fullscreen, Esc backs out of either. Same guards as the
  // single player — ignore modifier combos (Alt+F etc.) and keys typed into
  // chat inputs, buttons, and other interactive controls.
  useEffect(() => {
    if (!active) return;
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
      const fullscreen = optionsRef.current.fullscreen;
      const key = event.key.toLowerCase();
      if (key === "t") {
        setTheater((current) => !current);
      } else if (key === "f") {
        void window.desktop.player.setFullscreen(!fullscreen);
      } else if (event.key === "Escape" && fullscreen) {
        void window.desktop.player.setFullscreen(false);
      } else if (event.key === "Escape") {
        setTheater(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active]);

  /** Starts, or replaces, the grid with these channels. */
  const start = useCallback(
    async (channels: string[]) => {
      const generation = ++startGeneration.current;
      resetChat();
      setTileOrder([]);
      setActive(true);
      const started = await window.desktop.player.multiStart(channels);
      if (generation === startGeneration.current) setTiles(started);
    },
    [resetChat],
  );

  /** Takes the grid down. The caller decides where the viewer goes next. */
  const stop = useCallback(() => {
    startGeneration.current += 1;
    window.desktop.player.multiStop();
    setTiles([]);
    setTileOrder([]);
    setActive(false);
    setTheater(false);
    resetChat();
  }, [resetChat]);

  // Picking a channel anywhere — the sidebar, the search box, the picker —
  // joins the grid rather than replacing it with a single player.
  const addChannel = useCallback(async (channel: string) => {
    if (tilesRef.current.length >= MAX_MULTISTREAM_TILES) {
      optionsRef.current.notify(
        `Multistream is full at ${MAX_MULTISTREAM_TILES} streams. Remove one first.`,
      );
      return;
    }
    const tile = await window.desktop.player.multiAddTile(channel);
    if (tile) setTiles((current) => upsertTile(current, tile));
  }, []);

  const removeTile = useCallback((id: number) => {
    window.desktop.player.multiRemoveTile(id);
    setTiles((current) => current.filter((tile) => tile.id !== id));
    setTileOrder((current) => current.filter((entry) => entry !== id));
  }, []);

  const activateTile = useCallback(
    (id: number) => {
      window.desktop.player.multiSetActive(id);
      // Moving audio focus to a tile also switches its chat into view.
      const tile = tilesRef.current.find((entry) => entry.id === id);
      if (tile) selectChatTab(tile.channel);
    },
    [selectChatTab],
  );

  // Dropping one stream on another trades their cells; the keyboard walks a
  // stream along one cell at a time. Both work off the order as it is being
  // shown, so a tile added since the last drag keeps the place it was given.
  const swapTiles = useCallback((one: number, other: number) => {
    setTileOrder((current) =>
      swapTilePositions(
        tileDisplayOrder(
          tilesRef.current.map((tile) => tile.id),
          current,
        ),
        one,
        other,
      ),
    );
  }, []);

  const moveTile = useCallback((id: number, delta: number) => {
    setTileOrder((current) =>
      moveTilePosition(
        tileDisplayOrder(
          tilesRef.current.map((tile) => tile.id),
          current,
        ),
        id,
        delta,
      ),
    );
  }, []);

  const toggleMute = useCallback((id: number) => {
    window.desktop.player.multiControl(id, { command: "toggle-mute" });
  }, []);

  const setVolume = useCallback((id: number, value: number) => {
    window.desktop.player.multiControl(id, { command: "set-volume", value });
  }, []);

  const toggleCompressor = useCallback((id: number, enabled: boolean) => {
    window.desktop.player.multiControl(id, { command: "set-compressor", enabled });
  }, []);

  const setQuality = useCallback((id: number, quality: NativeQualityValue) => {
    void window.desktop.player.multiSetQuality(id, quality);
  }, []);

  const toggleTheater = useCallback(() => setTheater((current) => !current), []);
  const toggleChat = useCallback(() => setChatVisible((visible) => !visible), []);
  const toggleFullscreen = useCallback(() => {
    void window.desktop.player.setFullscreen(!optionsRef.current.fullscreen);
  }, []);

  const savePresets = useCallback((next: MultiStreamPreset[]) => {
    presetsRef.current = next;
    setPresets(next);
    void window.desktop.preferences
      .update({ multiStreamPresets: next })
      .catch(() =>
        optionsRef.current.notify("VioletWire could not save that multistream preset."),
      );
  }, []);

  // Saving under a name that already exists replaces it, so re-saving a
  // line-up after adding a stream to it does the obvious thing.
  const savePreset = useCallback(
    (name: string) => {
      const label = name.trim().slice(0, 40);
      const channels = orderedTilesRef.current.map((tile) => tile.channel);
      if (!label || channels.length === 0) return;
      const kept = presetsRef.current.filter(
        (preset) => preset.name.toLowerCase() !== label.toLowerCase(),
      );
      if (kept.length >= MULTISTREAM_PRESET_LIMIT) {
        optionsRef.current.notify(
          `Presets are limited to ${MULTISTREAM_PRESET_LIMIT}. Delete one first.`,
        );
        return;
      }
      savePresets([...kept, { name: label, channels }]);
      optionsRef.current.notify(`Saved "${label}".`);
    },
    [savePresets],
  );

  // Editing a preset means pointing it at the streams that are up now, so a
  // line-up gains or loses somebody by opening it, changing the grid, and
  // saving it back. It keeps its place in the list.
  const updatePreset = useCallback(
    (name: string) => {
      const channels = orderedTilesRef.current.map((tile) => tile.channel);
      if (channels.length === 0) return;
      savePresets(
        presetsRef.current.map((preset) =>
          preset.name === name ? { ...preset, channels } : preset,
        ),
      );
      optionsRef.current.notify(`Updated "${name}".`);
    },
    [savePresets],
  );

  const deletePreset = useCallback(
    (name: string) => {
      savePresets(presetsRef.current.filter((preset) => preset.name !== name));
    },
    [savePresets],
  );

  // Starting the manager again replaces the running grid outright, so a preset
  // simply becomes the new line-up.
  const openPreset = useCallback(
    (preset: MultiStreamPreset) => {
      void start(preset.channels);
    },
    [start],
  );

  return {
    active,
    theater,
    tiles,
    orderedTiles,
    shownOrder,
    presets,
    setPresets,
    chatVisible,
    chatChannel,
    chatStates,
    chatPaused,
    chatBroadcasterId,
    displayMessages,
    tabActivity,
    chatHost,
    chatContent,
    start,
    stop,
    addChannel,
    removeTile,
    activateTile,
    swapTiles,
    moveTile,
    toggleMute,
    setVolume,
    toggleCompressor,
    setQuality,
    toggleTheater,
    toggleChat,
    toggleFullscreen,
    selectChatTab,
    scrollChatToBottom,
    handleChatScroll,
    noteChatUserScroll,
    savePreset,
    updatePreset,
    deletePreset,
    openPreset,
  };
}
