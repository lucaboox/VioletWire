import { contextBridge, ipcRenderer, sharedTexture } from "electron";
import type {
  ChannelAction,
  ChannelActionWindowState,
  ChatPresentation,
  DesktopApi,
  NativeControlAction,
  NativeControlsContext,
  NativePlayerCommand,
  NativePlayerState,
  NativeQualityValue,
  PlayerBounds,
  PlayerMode,
} from "../shared/player";
import type { TwitchApi } from "../shared/twitch";
import type { EmoteApi } from "../shared/emotes";
import type { ChatApi, ChatConnectionState, ChatMessage } from "../shared/chat";
import type { AppUpdateStatus, UpdateApi } from "../shared/updates";
import type {
  AppPreferences,
  AppPreferencesPatch,
  PreferencesApi,
} from "../shared/preferences";

let lastTextureSequence = -1;
sharedTexture.setSharedTextureReceiver(async (received, sequence: unknown) => {
  const imported = received.importedSharedTexture;
  const frame = imported.getVideoFrame();
  try {
    if (typeof sequence === "number" && sequence < lastTextureSequence) return;
    if (typeof sequence === "number") lastTextureSequence = sequence;
    const canvas = document.querySelector<HTMLCanvasElement>("[data-native-texture-canvas]");
    if (!canvas) return;
    const width = frame.codedWidth;
    const height = frame.codedHeight;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
    context?.drawImage(frame, 0, 0, width, height);
  } finally {
    frame.close();
    imported.release();
  }
});

const api: DesktopApi = {
  system: {
    openExternal: (url: string) => ipcRenderer.invoke("system:open-external", url),
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
    createClip: (channel: string) => ipcRenderer.invoke("twitch:create-clip", channel),
    openSubscription: (channel: string) =>
      ipcRenderer.invoke("twitch:open-subscription", channel),
    openChannel: (channel: string) => ipcRenderer.invoke("twitch:open-channel", channel),
  } satisfies TwitchApi,
  emotes: {
    getSevenTvGlobal: () => ipcRenderer.invoke("emotes:7tv-global"),
    getSevenTvChannel: (broadcasterId: string) =>
      ipcRenderer.invoke("emotes:7tv-channel", broadcasterId),
    getFfzGlobal: () => ipcRenderer.invoke("emotes:ffz-global"),
    getFfzChannel: (broadcasterId: string) =>
      ipcRenderer.invoke("emotes:ffz-channel", broadcasterId),
    getBttvGlobal: () => ipcRenderer.invoke("emotes:bttv-global"),
    getBttvChannel: (broadcasterId: string) =>
      ipcRenderer.invoke("emotes:bttv-channel", broadcasterId),
    clearCache: () => ipcRenderer.invoke("emotes:clear-cache"),
  } satisfies EmoteApi,
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
  } satisfies ChatApi,
  updates: {
    getStatus: () => ipcRenderer.invoke("updates:get-status"),
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
    setChatBounds: (bounds: PlayerBounds) => ipcRenderer.send("player:set-chat-bounds", bounds),
    setChatVisible: (visible) => ipcRenderer.send("player:set-chat-visible", visible),
    setChatPresentation: (presentation: ChatPresentation) =>
      ipcRenderer.send("player:set-chat-presentation", presentation),
    setFullscreen: (fullscreen) => ipcRenderer.invoke("window:set-fullscreen", fullscreen),
    openChannelAction: (channel: string, action: ChannelAction) =>
      ipcRenderer.invoke("channel:open-action", channel, action),
    onChannelActionState: (
      listener: (action: ChannelAction, state: ChannelActionWindowState) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        action: ChannelAction,
        state: ChannelActionWindowState,
      ) => listener(action, state);
      ipcRenderer.on("channel-action:state", handler);
      return () => ipcRenderer.removeListener("channel-action:state", handler);
    },
    getNativeAvailability: () => ipcRenderer.invoke("native-player:get-availability"),
    getNativeQualities: (channel: string) => ipcRenderer.invoke("native-player:get-qualities", channel),
    setNativeQuality: (channel: string, quality: NativeQualityValue) =>
      ipcRenderer.invoke("native-player:set-quality", channel, quality),
    controlNative: (command: NativePlayerCommand) => ipcRenderer.send("native-player:control", command),
    onNativeState: (listener: (state: NativePlayerState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: NativePlayerState) => listener(state);
      ipcRenderer.on("native-player:state", handler);
      return () => ipcRenderer.removeListener("native-player:state", handler);
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
  },
};

contextBridge.exposeInMainWorld("desktop", api);
