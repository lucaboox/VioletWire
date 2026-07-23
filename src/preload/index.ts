import { contextBridge, ipcRenderer, sharedTexture } from "electron";
import type {
  ChannelAction,
  ChatPresentation,
  DesktopApi,
  MultiStreamTileState,
  NativeControlAction,
  NativeControlsContext,
  NativeRenderBackend,
  NativePlayerCommand,
  NativePlayerState,
  NativeQualityValue,
  PlayerBounds,
  PlayerMode,
} from "../shared/player";
import type { TwitchApi } from "../shared/twitch";
import type {
  KickChannelDetails,
  KickChannelResult,
  KickEmoteGroup,
  KickUserAccount,
} from "../shared/platform";
import type { EmoteApi } from "../shared/emotes";
import type {
  ChatApi,
  ChatConnectionState,
  ChatMessage,
  ChatRestrictions,
} from "../shared/chat";
import type { AppUpdateStatus, UpdateApi } from "../shared/updates";
import type {
  AppPreferences,
  AppPreferencesPatch,
  PreferencesApi,
} from "../shared/preferences";

// Each render target ("main" for the single full-window/mini player, or a
// multistream tile id) tracks its own newest sequence and cached canvas so
// tiles never drop one another's frames or paint onto the wrong <canvas>.
const newestTextureSequence = new Map<string, number>();
const textureCanvases = new Map<string, HTMLCanvasElement>();

function readTransferTarget(userData: unknown): { target: string; sequence: number } {
  if (typeof userData === "object" && userData !== null) {
    const record = userData as { target?: unknown; sequence?: unknown };
    return {
      target: typeof record.target === "string" ? record.target : "main",
      sequence: typeof record.sequence === "number" ? record.sequence : Number.NaN,
    };
  }
  // Back-compat with the pre-multistream protocol where userData was the raw
  // sequence number and there was only the "main" target.
  return { target: "main", sequence: typeof userData === "number" ? userData : Number.NaN };
}

sharedTexture.setSharedTextureReceiver(async (received, userData: unknown) => {
  const imported = received.importedSharedTexture;
  const frame = imported.getVideoFrame();
  let bitmap: ImageBitmap | null = null;
  const { target, sequence } = readTransferTarget(userData);
  try {
    const newest = newestTextureSequence.get(target) ?? -1;
    if (Number.isFinite(sequence) && sequence <= newest) return;
    if (Number.isFinite(sequence)) newestTextureSequence.set(target, sequence);
    // Nothing can be seen while the document is hidden; skip the bitmap and
    // canvas work. Decode and audio continue, and the next frame after the
    // window becomes visible repaints the canvas.
    if (document.visibilityState === "hidden") return;
    bitmap = await createImageBitmap(frame);
    if (Number.isFinite(sequence) && sequence < (newestTextureSequence.get(target) ?? -1)) return;
    // Cached: querying the DOM per frame at 60 FPS is measurable waste.
    let canvas = textureCanvases.get(target);
    if (!canvas?.isConnected) {
      canvas =
        document.querySelector<HTMLCanvasElement>(
          `[data-native-texture-canvas="${target}"]`,
        ) ?? undefined;
      if (canvas) textureCanvases.set(target, canvas);
    }
    if (!canvas) return;
    const width = bitmap.width;
    const height = bitmap.height;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const bitmapContext = canvas.getContext("bitmaprenderer", { alpha: false });
    if (bitmapContext) {
      bitmapContext.transferFromImageBitmap(bitmap);
      bitmap = null;
    } else {
      const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
      context?.drawImage(bitmap, 0, 0, width, height);
    }
  } finally {
    bitmap?.close();
    frame.close();
    imported.release();
  }
});

const api: DesktopApi = {
  system: {
    openExternal: (url: string) => ipcRenderer.invoke("system:open-external", url),
    getLinkPreview: (url: string) => ipcRenderer.invoke("system:get-link-preview", url),
  },
  twitch: {
    getAuthState: () => ipcRenderer.invoke("twitch:get-auth-state"),
    beginSignIn: () => ipcRenderer.invoke("twitch:begin-sign-in"),
    completeSignIn: () => ipcRenderer.invoke("twitch:complete-sign-in"),
    cancelSignIn: () => ipcRenderer.invoke("twitch:cancel-sign-in"),
    signOut: () => ipcRenderer.invoke("twitch:sign-out"),
    getPlaybackSessionState: () => ipcRenderer.invoke("twitch-playback:get-state"),
    linkPlaybackSession: () => ipcRenderer.invoke("twitch-playback:link"),
    unlinkPlaybackSession: () => ipcRenderer.invoke("twitch-playback:unlink"),
    getFollowedChannels: () => ipcRenderer.invoke("twitch:get-followed-channels"),
    getBrowseCategories: (query?: string, after?: string) =>
      ipcRenderer.invoke("twitch:get-browse-categories", query, after),
    getCategoryStreams: (gameId: string, after?: string) =>
      ipcRenderer.invoke("twitch:get-category-streams", gameId, after),
    search: (query: string) => ipcRenderer.invoke("twitch:search", query),
    getStreamMetadata: (channel: string) =>
      ipcRenderer.invoke("twitch:get-stream-metadata", channel),
    getChatUserProfile: (channel: string, login: string) =>
      ipcRenderer.invoke("twitch:get-chat-user-profile", channel, login),
    createClip: (channel: string) => ipcRenderer.invoke("twitch:create-clip", channel),
    openChannel: (channel: string) => ipcRenderer.invoke("twitch:open-channel", channel),
  } satisfies TwitchApi,
  emotes: {
    getSevenTvGlobal: () => ipcRenderer.invoke("emotes:7tv-global"),
    getSevenTvChannel: (broadcasterId: string, platform?: "twitch" | "kick") =>
      ipcRenderer.invoke("emotes:7tv-channel", broadcasterId, platform),
    getFfzGlobal: () => ipcRenderer.invoke("emotes:ffz-global"),
    getFfzChannel: (broadcasterId: string) =>
      ipcRenderer.invoke("emotes:ffz-channel", broadcasterId),
    getBttvGlobal: () => ipcRenderer.invoke("emotes:bttv-global"),
    getBttvChannel: (broadcasterId: string) =>
      ipcRenderer.invoke("emotes:bttv-channel", broadcasterId),
    clearCache: () => ipcRenderer.invoke("emotes:clear-cache"),
  } satisfies EmoteApi,
  kick: {
    search: (query: string): Promise<KickChannelResult[]> =>
      ipcRenderer.invoke("kick:search", query),
    getChannel: (slug: string): Promise<KickChannelDetails | null> =>
      ipcRenderer.invoke("kick:get-channel", slug),
    getUser: (): Promise<KickUserAccount | null> => ipcRenderer.invoke("kick:get-user"),
    signIn: (): Promise<KickUserAccount | null> => ipcRenderer.invoke("kick:sign-in"),
    signOut: (): Promise<void> => ipcRenderer.invoke("kick:sign-out"),
    getFollowedChannels: (): Promise<KickChannelDetails[]> =>
      ipcRenderer.invoke("kick:get-followed"),
    getEmoteSets: (slug: string): Promise<KickEmoteGroup[]> =>
      ipcRenderer.invoke("kick:get-emote-sets", slug),
    setFollowing: (slug: string, follow: boolean): Promise<void> =>
      ipcRenderer.invoke("kick:set-following", slug, follow),
    openWindow: (slug: string): Promise<void> => ipcRenderer.invoke("kick:open-window", slug),
  },
  chat: {
    send: (channel: string, message: string, replyParentMessageId?: string) =>
      ipcRenderer.invoke("chat:send", channel, message, replyParentMessageId),
    getAssets: (channel: string) => ipcRenderer.invoke("chat:get-assets", channel),
    setHistoryLimit: (limit: number) => ipcRenderer.send("chat:set-history-limit", limit),
    onMessage: (listener: (message: ChatMessage) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: ChatMessage) =>
        listener(message);
      ipcRenderer.on("chat:message", handler);
      return () => ipcRenderer.removeListener("chat:message", handler);
    },
    onState: (listener: (state: ChatConnectionState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: ChatConnectionState) =>
        listener(state);
      ipcRenderer.on("chat:state", handler);
      return () => ipcRenderer.removeListener("chat:state", handler);
    },
    onRestrictions: (listener: (restrictions: ChatRestrictions) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, restrictions: ChatRestrictions) =>
        listener(restrictions);
      ipcRenderer.on("chat:restrictions", handler);
      return () => ipcRenderer.removeListener("chat:restrictions", handler);
    },
  } satisfies ChatApi,
  updates: {
    getStatus: () => ipcRenderer.invoke("updates:get-status"),
    getReleaseNotes: (forceRefresh?: boolean) =>
      ipcRenderer.invoke("updates:get-release-notes", forceRefresh),
    check: () => ipcRenderer.invoke("updates:check"),
    install: () => ipcRenderer.send("updates:install"),
    onStatus: (listener: (status: AppUpdateStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: AppUpdateStatus) =>
        listener(status);
      ipcRenderer.on("updates:status", handler);
      return () => ipcRenderer.removeListener("updates:status", handler);
    },
  } satisfies UpdateApi,
  preferences: {
    getOrMigrate: (legacyPreferences?: AppPreferencesPatch) =>
      ipcRenderer.invoke("preferences:get-or-migrate", legacyPreferences),
    update: (patch: AppPreferencesPatch) => ipcRenderer.invoke("preferences:update", patch),
    onChanged: (listener: (preferences: AppPreferences) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, preferences: AppPreferences) =>
        listener(preferences);
      ipcRenderer.on("preferences:changed", handler);
      return () => ipcRenderer.removeListener("preferences:changed", handler);
    },
  } satisfies PreferencesApi,
  player: {
    open: (channel: string, mode: PlayerMode, quality?: NativeQualityValue) =>
      ipcRenderer.invoke("player:open", channel, mode, quality),
    close: () => ipcRenderer.invoke("player:close"),
    setBounds: (bounds: PlayerBounds) => ipcRenderer.send("player:set-bounds", bounds),
    preresolveStream: (channel: string) => ipcRenderer.send("player:preresolve", channel),
    setChatBounds: (bounds: PlayerBounds) => ipcRenderer.send("player:set-chat-bounds", bounds),
    setChatVisible: (visible) => ipcRenderer.send("player:set-chat-visible", visible),
    setChatPresentation: (presentation: ChatPresentation) =>
      ipcRenderer.send("player:set-chat-presentation", presentation),
    setFullscreen: (fullscreen) => ipcRenderer.invoke("window:set-fullscreen", fullscreen),
    onFullscreenChanged: (listener: (fullscreen: boolean) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, fullscreen: boolean) =>
        listener(fullscreen);
      ipcRenderer.on("window:fullscreen-changed", handler);
      return () => ipcRenderer.removeListener("window:fullscreen-changed", handler);
    },
    openChannelAction: (channel: string, action: ChannelAction) =>
      ipcRenderer.invoke("channel:open-action", channel, action),
    openSubscription: (channel: string, title: string) =>
      ipcRenderer.invoke("twitch:open-subscription", channel, title),
    getNativeAvailability: () => ipcRenderer.invoke("native-player:get-availability"),
    getNativeQualities: (channel: string) => ipcRenderer.invoke("native-player:get-qualities", channel),
    setNativeQuality: (channel: string, quality: NativeQualityValue) =>
      ipcRenderer.invoke("native-player:set-quality", channel, quality),
    controlNative: (command: NativePlayerCommand) => ipcRenderer.send("native-player:control", command),
    getNativeStats: (): Promise<Record<string, string> | null> =>
      ipcRenderer.invoke("native-player:stats"),
    onNativeState: (listener: (state: NativePlayerState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: NativePlayerState) => listener(state);
      ipcRenderer.on("native-player:state", handler);
      return () => ipcRenderer.removeListener("native-player:state", handler);
    },
    onNativeBackendChanged: (listener: (backend: NativeRenderBackend) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, backend: NativeRenderBackend) =>
        listener(backend);
      ipcRenderer.on("native-player:backend-changed", handler);
      return () => ipcRenderer.removeListener("native-player:backend-changed", handler);
    },
    readyNativeControls: () => ipcRenderer.send("native-controls:ready"),
    setNativeControlsVisible: (visible: boolean) =>
      ipcRenderer.send("native-controls:set-visible", visible),
    setNativeControlsExpanded: (expanded: boolean) =>
      ipcRenderer.send("native-controls:set-expanded", expanded),
    setNativeEmotePicker: (open: boolean) =>
      ipcRenderer.send("native-controls:set-emote-picker", open),
    setModalOpen: (open: boolean) =>
      ipcRenderer.send("player:set-modal-open", open),
    setNativeEmotePickerBounds: (bounds: PlayerBounds | null) =>
      ipcRenderer.send("native-controls:set-emote-picker-bounds", bounds),
    setNativeControlsContext: (context: NativeControlsContext) =>
      ipcRenderer.send("native-controls:set-context", context),
    onNativeControlsVisibility: (listener: (visible: boolean) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, visible: boolean) => listener(visible);
      ipcRenderer.on("native-controls:visibility", handler);
      return () => ipcRenderer.removeListener("native-controls:visibility", handler);
    },
    sendNativeControlAction: (action: NativeControlAction) =>
      ipcRenderer.send("native-controls:action", action),
    onNativeControlsContext: (listener: (context: NativeControlsContext) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, context: NativeControlsContext) =>
        listener(context);
      ipcRenderer.on("native-controls:context", handler);
      return () => ipcRenderer.removeListener("native-controls:context", handler);
    },
    onNativeControlAction: (listener: (action: NativeControlAction) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, action: NativeControlAction) =>
        listener(action);
      ipcRenderer.on("native-controls:action", handler);
      return () => ipcRenderer.removeListener("native-controls:action", handler);
    },
    sendNativeEmoteSelection: (name: string) =>
      ipcRenderer.send("native-controls:emote-selected", name),
    onNativeEmotePicker: (listener: (open: boolean) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, open: boolean) => listener(open);
      ipcRenderer.on("native-controls:emote-picker", handler);
      return () => ipcRenderer.removeListener("native-controls:emote-picker", handler);
    },
    onNativeEmoteSelection: (listener: (name: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, name: string) => listener(name);
      ipcRenderer.on("native-controls:emote-selected", handler);
      return () => ipcRenderer.removeListener("native-controls:emote-selected", handler);
    },
    multiStart: (channels: string[]) =>
      ipcRenderer.invoke("native-multi:start", channels) as Promise<MultiStreamTileState[]>,
    multiStop: () => ipcRenderer.send("native-multi:stop"),
    onMultiChatMessage: (listener: (channel: string, message: ChatMessage) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: { channel: string; message: ChatMessage },
      ) => listener(payload.channel, payload.message);
      ipcRenderer.on("native-multi:chat-message", handler);
      return () => ipcRenderer.removeListener("native-multi:chat-message", handler);
    },
    onMultiChatState: (listener: (channel: string, state: ChatConnectionState) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: { channel: string; state: ChatConnectionState },
      ) => listener(payload.channel, payload.state);
      ipcRenderer.on("native-multi:chat-state", handler);
      return () => ipcRenderer.removeListener("native-multi:chat-state", handler);
    },
    multiAddTile: (channel: string) =>
      ipcRenderer.invoke("native-multi:add-tile", channel) as Promise<MultiStreamTileState | null>,
    multiRemoveTile: (id: number) => ipcRenderer.send("native-multi:remove-tile", id),
    multiSetActive: (id: number) => ipcRenderer.send("native-multi:set-active", id),
    multiSetBounds: (id: number, bounds: PlayerBounds) =>
      ipcRenderer.send("native-multi:set-bounds", id, bounds),
    multiControl: (id: number, command: NativePlayerCommand) =>
      ipcRenderer.send("native-multi:control", id, command),
    multiSetQuality: (id: number, quality: NativeQualityValue) =>
      ipcRenderer.invoke("native-multi:set-quality", id, quality) as Promise<void>,
    onMultiTileState: (listener: (tile: MultiStreamTileState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, tile: MultiStreamTileState) =>
        listener(tile);
      ipcRenderer.on("native-multi:tile-state", handler);
      return () => ipcRenderer.removeListener("native-multi:tile-state", handler);
    },
    onMultiTileRemoved: (listener: (id: number) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, id: number) => listener(id);
      ipcRenderer.on("native-multi:tile-removed", handler);
      return () => ipcRenderer.removeListener("native-multi:tile-removed", handler);
    },
  },
};

// The legacy window-hosted player needs a separate transparent controls
// renderer, but that renderer does not need account management, browsing,
// update installation, or general player lifecycle capabilities. Expose only
// the operations its chat and controls UI actually uses.
const controlsApi = {
  system: {
    openExternal: api.system.openExternal,
  },
  twitch: {
    getChatUserProfile: api.twitch.getChatUserProfile,
  },
  emotes: api.emotes,
  chat: api.chat,
  preferences: api.preferences,
  player: {
    getNativeQualities: api.player.getNativeQualities,
    setNativeQuality: api.player.setNativeQuality,
    controlNative: api.player.controlNative,
    getNativeStats: api.player.getNativeStats,
    onNativeState: api.player.onNativeState,
    readyNativeControls: api.player.readyNativeControls,
    setNativeControlsVisible: api.player.setNativeControlsVisible,
    setNativeControlsExpanded: api.player.setNativeControlsExpanded,
    setNativeEmotePicker: api.player.setNativeEmotePicker,
    setNativeEmotePickerBounds: api.player.setNativeEmotePickerBounds,
    sendNativeControlAction: api.player.sendNativeControlAction,
    onNativeControlsVisibility: api.player.onNativeControlsVisibility,
    onNativeControlsContext: api.player.onNativeControlsContext,
    sendNativeEmoteSelection: api.player.sendNativeEmoteSelection,
    onNativeEmotePicker: api.player.onNativeEmotePicker,
  },
};

const exposedApi = window.location.pathname.endsWith("/controls.html")
  ? controlsApi
  : api;
contextBridge.exposeInMainWorld("desktop", exposedApi);
