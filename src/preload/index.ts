import { contextBridge, ipcRenderer } from "electron";
import type {
  ChannelAction,
  DesktopApi,
  MultiStreamTileState,
  NativeControlAction,
  NativeHlsStateReport,
  NativePlayerCommand,
  NativePlayerState,
  NativeQualityValue,
  PlayerMode,
} from "../shared/player";
import type { TwitchApi, BrowseCategory, BrowseStream, BrowsePage } from "../shared/twitch";
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

const api: DesktopApi = {
  system: {
    openExternal: (url: string) => ipcRenderer.invoke("system:open-external", url),
    getLinkPreview: (url: string, allowGeneric = false) =>
      ipcRenderer.invoke("system:get-link-preview", { url, allowGeneric }),
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
    getPinnedChatMessage: (broadcasterId: string) =>
      ipcRenderer.invoke("twitch:get-pinned-chat-message", broadcasterId),
    getChatColor: () => ipcRenderer.invoke("twitch:get-chat-color"),
    updateChatColor: (color) => ipcRenderer.invoke("twitch:update-chat-color", color),
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
    getChatUserProfile: (channel: string, login: string) =>
      ipcRenderer.invoke("kick:get-chat-user-profile", channel, login),
    getPinnedChatMessage: (channelId: string) =>
      ipcRenderer.invoke("kick:get-pinned-chat-message", channelId),
    getChatColor: () => ipcRenderer.invoke("kick:get-chat-color"),
    updateChatColor: (color: string) => ipcRenderer.invoke("kick:update-chat-color", color),
    setFollowing: (slug: string, follow: boolean): Promise<void> =>
      ipcRenderer.invoke("kick:set-following", slug, follow),
    openWindow: (slug: string): Promise<void> => ipcRenderer.invoke("kick:open-window", slug),
    getCategories: (query: string, cursor?: string): Promise<BrowsePage<BrowseCategory>> =>
      ipcRenderer.invoke("kick:get-categories", query, cursor),
    getCategoryStreams: (slug: string, cursor?: string): Promise<BrowsePage<BrowseStream>> =>
      ipcRenderer.invoke("kick:get-category-streams", slug, cursor),
  },
  chat: {
    send: (channel: string, message: string, replyParentMessageId?: string) =>
      ipcRenderer.invoke("chat:send", channel, message, replyParentMessageId),
    getAssets: (channel: string) => ipcRenderer.invoke("chat:get-assets", channel),
    setHistoryLimit: (limit: number) => ipcRenderer.send("chat:set-history-limit", limit),
    clearEmoteCache: () => ipcRenderer.invoke("chat:clear-emote-cache"),
    getDisplays: () => ipcRenderer.invoke("chat-window:get-displays"),
    placeWindow: (displayId: number, side: "left" | "right") =>
      ipcRenderer.invoke("chat-window:place", { displayId, side }),
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
    preresolveStream: (channel: string) => ipcRenderer.send("player:preresolve", channel),
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
      ipcRenderer.invoke("subscription:open", channel, title),
    getNativeAvailability: () => ipcRenderer.invoke("native-player:get-availability"),
    getNativeQualities: (channel: string) => ipcRenderer.invoke("native-player:get-qualities", channel),
    setNativeQuality: (channel: string, quality: NativeQualityValue) =>
      ipcRenderer.invoke("native-player:set-quality", channel, quality),
    controlNative: (command: NativePlayerCommand) => ipcRenderer.send("native-player:control", command),
    reportNativeHlsState: (report: NativeHlsStateReport) =>
      ipcRenderer.send("native-hls:state", report),
    onNativeHlsCommand: (
      listener: (target: string, command: NativePlayerCommand) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: { target: string; command: NativePlayerCommand },
      ) => listener(payload.target, payload.command);
      ipcRenderer.on("native-hls:command", handler);
      return () => ipcRenderer.removeListener("native-hls:command", handler);
    },
    getNativeStats: (): Promise<Record<string, string> | null> =>
      ipcRenderer.invoke("native-player:stats"),
    onNativeState: (listener: (state: NativePlayerState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: NativePlayerState) => listener(state);
      ipcRenderer.on("native-player:state", handler);
      return () => ipcRenderer.removeListener("native-player:state", handler);
    },
    sendNativeControlAction: (action: NativeControlAction) =>
      ipcRenderer.send("native-controls:action", action),
    onNativeControlAction: (listener: (action: NativeControlAction) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, action: NativeControlAction) =>
        listener(action);
      ipcRenderer.on("native-controls:action", handler);
      return () => ipcRenderer.removeListener("native-controls:action", handler);
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

contextBridge.exposeInMainWorld("desktop", api);
