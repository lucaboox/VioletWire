import {
  app,
  BaseWindow,
  BrowserWindow,
  ipcMain,
  Menu,
  powerMonitor,
  shell,
  WebContentsView,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Rectangle,
} from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  channelActionSchema,
  chatPresentationSchema,
  channelNameSchema,
  nativeControlActionSchema,
  nativeControlsContextSchema,
  nativeQualitySchema,
  nativePlayerCommandSchema,
  playerBoundsSchema,
  playerModeSchema,
  isNativeStreamUnavailable,
  MAX_MULTISTREAM_TILES,
  type ChatPresentation,
  type NativeControlsContext,
  type NativeRenderBackend,
  type PlayerMode,
} from "../shared/player";
import { z } from "zod";
import { channelKeySchema, parseChannelKey, type Platform } from "../shared/platform";
import { NativePlayer } from "./native-player";
import { TextureNativePlayer } from "./texture-native-player";
import { MultiStreamManager } from "./multi-stream-manager";
import { MultiChatService } from "./multi-chat-service";
import { TwitchService } from "./twitch-service";
import { KickService } from "./kick-service";
import { KickChatService } from "./kick-chat-service";
import { PlaybackSessionService } from "./playback-session";
import { SevenTvService } from "./seven-tv-service";
import { ThirdPartyEmoteService } from "./third-party-emote-service";
import { TwitchChatService } from "./twitch-chat-service";
import { UpdateService } from "./update-service";
import { GitHubReleaseNotesService } from "./github-release-notes";
import { LinkPreviewService } from "./link-preview-service";
import { startRendererServer, type RendererServer } from "./renderer-server";
import {
  chatHistoryLimitSchema,
  chatReplyParentIdSchema,
  outgoingChatMessageSchema,
  type TwitchChatAssets,
} from "../shared/chat";
import { PreferencesService } from "./preferences-service";
import {
  APP_UI_PARTITION,
  CONTROLS_PARTITION,
  TWITCH_WEBSITE_PARTITION,
} from "./session-partitions";

// Electron's development console can outlive the shell that launched it. A
// later Chromium diagnostic would otherwise turn a harmless closed stdout or
// stderr pipe into an uncaught EPIPE exception in the main process.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") return;
    // There is no safe console sink left at this point. Keeping the application
    // alive is preferable to throwing recursively from its diagnostic stream.
  });
}

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
// Preserve Glint's original data directory through the VioletWire rename so
// encrypted Twitch credentials, website sessions, and renderer preferences
// continue to load without copying or decrypting them.
app.setPath("userData", path.join(app.getPath("appData"), "twitch-windows-viewer"));
// Twitch's official embedded player is created inside a dedicated local page.
// Allow that trusted player to honor its autoplay option when a channel opens.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
const applicationIcon = app.isPackaged
  ? path.join(process.resourcesPath, "icon.png")
  : path.join(currentDirectory, "../../build/icon.png");
let mainWindow: BrowserWindow | null = null;
let chatView: WebContentsView | null = null;
let chatOverlayWindow: BaseWindow | null = null;
let nativeControlsWindow: BrowserWindow | null = null;
let channelActionWindow: BrowserWindow | null = null;
let subscriptionWindow: BrowserWindow | null = null;
let nativeControlsVisible = true;
let nativeControlsExpanded = false;
let nativePlayerPaused = false;
let nativeEmotePickerOpen = false;
// Measured position of the detached emote picker inside the controls window,
// reported by the renderer so the clickable window region hugs the visible
// picker instead of a fixed-size guess.
let nativeEmotePickerBounds: Rectangle | null = null;
let nativeControlsContext: NativeControlsContext | null = null;
let lastPlayerBounds: Rectangle | null = null;
let chatPresentation: ChatPresentation = "side";
let chatVisible = true;
let lastChatBounds: Rectangle | null = null;
let activePlayerMode: PlayerMode | null = null;
let activeNativeBackend: NativeRenderBackend | null = null;
let activeChannelName: string | null = null;
let textureFallbackInProgress = false;
let playerOpenGeneration = 0;
let rendererServer: RendererServer | null = null;
let trustedRendererOrigin: string | null = null;
const playbackSessionService = new PlaybackSessionService(
  () => mainWindow,
  applicationIcon,
);
const sevenTvService = new SevenTvService();
const thirdPartyEmoteService = new ThirdPartyEmoteService();
function sendToWindow(window: BrowserWindow | null, channel: string, ...args: unknown[]): void {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send(channel, ...args);
}

const updateService = new UpdateService(
  () => mainWindow,
  (status) => sendToWindow(mainWindow, "updates:status", status),
);
const githubReleaseNotesService = new GitHubReleaseNotesService();

function isTrustedRendererUrl(rawUrl: string, kind: "main" | "controls"): boolean {
  if (!trustedRendererOrigin) return false;
  try {
    const url = new URL(rawUrl);
    if (url.origin !== trustedRendererOrigin) return false;
    return kind === "main"
      ? url.pathname === "/" || url.pathname === "/index.html"
      : url.pathname === "/controls.html";
  } catch {
    return false;
  }
}

function isTrustedIpcSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  if (mainWindow && event.sender === mainWindow.webContents) {
    return isTrustedRendererUrl(frame.url, "main");
  }
  if (nativeControlsWindow && event.sender === nativeControlsWindow.webContents) {
    return isTrustedRendererUrl(frame.url, "controls");
  }
  return false;
}

function assertTrustedIpcSender(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (!isTrustedIpcSender(event)) {
    throw new Error("Blocked IPC request from an untrusted renderer.");
  }
}

function handleTrusted<Arguments extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Arguments) => Result,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpcSender(event);
    return listener(event, ...(args as Arguments));
  });
}

function onTrusted<Arguments extends unknown[]>(
  channel: string,
  listener: (event: IpcMainEvent, ...args: Arguments) => void,
): void {
  ipcMain.on(channel, (event, ...args) => {
    if (!isTrustedIpcSender(event)) return;
    listener(event, ...(args as Arguments));
  });
}

function lockLocalRendererNavigation(
  window: BrowserWindow,
  kind: "main" | "controls",
): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const blockUnexpectedNavigation = (event: Electron.Event, url: string) => {
    if (!isTrustedRendererUrl(url, kind)) event.preventDefault();
  };
  window.webContents.on("will-navigate", blockUnexpectedNavigation);
  window.webContents.on("will-redirect", blockUnexpectedNavigation);
}

function suspendDetachedNativeSurfaces(): void {
  if (activePlayerMode !== "native") return;
  if (activeNativeBackend === "window") nativePlayer.suspendSurface();
  if (nativeControlsWindow && !nativeControlsWindow.isDestroyed()) nativeControlsWindow.hide();
  if (chatOverlayWindow && !chatOverlayWindow.isDestroyed()) chatOverlayWindow.hide();
}

function restoreDetachedNativeSurfaces(): void {
  if (activePlayerMode !== "native") return;
  if (activeNativeBackend === "window") nativePlayer.resumeSurface();
  applyChatBounds();
  applyNativeControlsBounds();
  if (
    chatOverlayWindow &&
    !chatOverlayWindow.isDestroyed() &&
    chatVisible &&
    chatPresentation === "overlay"
  ) {
    chatOverlayWindow.showInactive();
    chatOverlayWindow.moveTop();
  }
  if (
    nativeControlsWindow &&
    !nativeControlsWindow.isDestroyed() &&
    nativeControlsVisible
  ) {
    nativeControlsWindow.showInactive();
    nativeControlsWindow.moveTop();
  }
}

const twitchChatService = new TwitchChatService(
  (message) => {
    sendToWindow(mainWindow, "chat:message", message);
    sendToWindow(nativeControlsWindow, "chat:message", message);
  },
  (state) => {
    sendToWindow(mainWindow, "chat:state", state);
    sendToWindow(nativeControlsWindow, "chat:state", state);
  },
  (restrictions) => {
    sendToWindow(mainWindow, "chat:restrictions", restrictions);
    sendToWindow(nativeControlsWindow, "chat:restrictions", restrictions);
  },
);
const nativePlayer = new NativePlayer(
  () => mainWindow,
  (state) => {
    nativePlayerPaused = state.paused;
    sendToWindow(mainWindow, "native-player:state", state);
    sendToWindow(nativeControlsWindow, "native-player:state", state);
    if (state.status === "playing" && chatOverlayWindow) {
      applyChatBounds();
      chatOverlayWindow.moveTop();
    }
    if (state.status === "playing" && nativeControlsWindow) {
      applyNativeControlsBounds();
      if (
        !nativeControlsVisible &&
        !nativePlayerPaused &&
        !nativeControlsExpanded &&
        !nativeEmotePickerOpen &&
        !(nativeControlsContext?.chatVisible &&
          nativeControlsContext.chatPresentation === "overlay")
      ) {
        nativeControlsWindow.hide();
      } else {
        nativeControlsWindow.moveTop();
      }
    }
  },
  () => playbackSessionService.getToken(),
);
const kickService = new KickService();
// Kick chat reuses the same renderer channels as Twitch's, so the panel does
// not care which service a message came from.
const kickChatService = new KickChatService(
  () => kickService,
  (message) => {
    sendToWindow(mainWindow, "chat:message", message);
    sendToWindow(nativeControlsWindow, "chat:message", message);
  },
  (state) => {
    sendToWindow(mainWindow, "chat:state", state);
    sendToWindow(nativeControlsWindow, "chat:state", state);
  },
  (restrictions) => {
    sendToWindow(mainWindow, "chat:restrictions", restrictions);
    sendToWindow(nativeControlsWindow, "chat:restrictions", restrictions);
  },
);
const textureNativePlayer = new TextureNativePlayer(
  () => mainWindow,
  (state) => {
    if (
      state.status === "error" &&
      activePlayerMode === "native" &&
      activeNativeBackend === "texture" &&
      activeChannelName &&
      !textureFallbackInProgress
    ) {
      textureFallbackInProgress = true;
      activeNativeBackend = "window";
      textureNativePlayer.destroy();
      const fallback = nativePlayer.start(activeChannelName, state.quality);
      if (fallback.ok) {
        if (lastPlayerBounds) nativePlayer.setBounds(lastPlayerBounds);
        sendToWindow(mainWindow, "native-player:backend-changed", "window");
        void createNativeControlsWindow();
        textureFallbackInProgress = false;
        return;
      }
      textureFallbackInProgress = false;
      state = {
        ...state,
        error: `${state.error ?? "Embedded Native failed."} Window-hosted Native also failed: ${fallback.reason}`,
      };
    }
    sendToWindow(mainWindow, "native-player:state", state);
    sendToWindow(nativeControlsWindow, "native-player:state", state);
  },
  () => nativePlayer.getAvailability().streamlinkPath,
  () => playbackSessionService.getToken(),
  "main",
  () => preferencesService.get().playerVolume,
  () => kickService.getStreamlinkCookie(),
);
const multiStreamManager = new MultiStreamManager(
  () => mainWindow,
  () => nativePlayer.getAvailability().streamlinkPath,
  () => playbackSessionService.getToken(),
  () => preferencesService.get().playerVolume,
  () => kickService.getStreamlinkCookie(),
  (tile) => sendToWindow(mainWindow, "native-multi:tile-state", tile),
  (id) => sendToWindow(mainWindow, "native-multi:tile-removed", id),
);
const multiChatService = new MultiChatService(
  (channel, message) =>
    sendToWindow(mainWindow, "native-multi:chat-message", { channel, message }),
  (channel, state) => sendToWindow(mainWindow, "native-multi:chat-state", { channel, state }),
);
const twitchService = new TwitchService();
const linkPreviewService = new LinkPreviewService(twitchService);
const preferencesService = new PreferencesService();
function isAllowedTwitchNavigation(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && (url.hostname === "twitch.tv" || url.hostname.endsWith(".twitch.tv"));
  } catch {
    return false;
  }
}

function isAllowedKickNavigation(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && (url.hostname === "kick.com" || url.hostname.endsWith(".kick.com"));
  } catch {
    return false;
  }
}

// The signed-in Kick website session, so its subscribe page acts as the user.
const KICK_WEBSITE_PARTITION = "persist:violetwire-kick";

function applyNativeControlsBounds(): void {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    !nativeControlsWindow ||
    nativeControlsWindow.isDestroyed() ||
    !lastPlayerBounds
  ) return;
  const contentBounds = mainWindow.getContentBounds();
  const nativeChatOverlay =
    nativeControlsContext?.chatVisible && nativeControlsContext.chatPresentation === "overlay";
  const chatBounds = lastChatBounds;
  const detachedPickerOverSideChat =
    Boolean(nativeEmotePickerOpen &&
    nativeControlsContext?.chatVisible &&
    nativeControlsContext.chatPresentation === "side" &&
    chatBounds);
  const left = detachedPickerOverSideChat
    ? Math.min(lastPlayerBounds.x, chatBounds!.x)
    : lastPlayerBounds.x;
  const top = detachedPickerOverSideChat
    ? Math.min(lastPlayerBounds.y, chatBounds!.y)
    : lastPlayerBounds.y;
  const right = detachedPickerOverSideChat
    ? Math.max(
        lastPlayerBounds.x + lastPlayerBounds.width,
        chatBounds!.x + chatBounds!.width,
      )
    : lastPlayerBounds.x + lastPlayerBounds.width;
  const bottom = detachedPickerOverSideChat
    ? Math.max(
        lastPlayerBounds.y + lastPlayerBounds.height,
        chatBounds!.y + chatBounds!.height,
      )
    : lastPlayerBounds.y + lastPlayerBounds.height;
  const height = bottom - top;
  const width = right - left;
  const playerX = lastPlayerBounds.x - left;
  const playerY = lastPlayerBounds.y - top;
  const playerWidth = lastPlayerBounds.width;
  const playerHeight = lastPlayerBounds.height;
  nativeControlsWindow.setBounds({
    x: contentBounds.x + left,
    y: contentBounds.y + top,
    width,
    height,
  });
  const normalControlShape = [
    {
      x: playerX + Math.max(0, playerWidth - 136),
      y: playerY + 8,
      width: Math.min(128, playerWidth),
      height: 34,
    },
    {
      x: playerX,
      y: playerY + Math.max(0, playerHeight - 78),
      width: playerWidth,
      height: Math.min(78, playerHeight),
    },
  ];
  const centerPlaySize = Math.min(104, playerWidth, playerHeight);
  const centerPlayShape = nativePlayerPaused
    ? [
        {
          x: playerX + Math.max(0, Math.round((playerWidth - centerPlaySize) / 2)),
          y: playerY + Math.max(0, Math.round((playerHeight - centerPlaySize) / 2)),
          width: centerPlaySize,
          height: centerPlaySize,
        },
      ]
    : [];
  // Prefer the renderer-measured picker rectangle (plus a small margin for
  // the resize handle) so no invisible interactive band surrounds the picker
  // and swallows clicks meant for the chat behind it. The fixed rectangle is
  // only a fallback for the first frame before a measurement arrives.
  const pickerMargin = 8;
  const measuredPicker = nativeEmotePickerBounds;
  const pickerShape = detachedPickerOverSideChat
    ? [
        measuredPicker
          ? {
              x: Math.max(0, measuredPicker.x - pickerMargin),
              y: Math.max(0, measuredPicker.y - pickerMargin),
              width: Math.min(
                width - Math.max(0, measuredPicker.x - pickerMargin),
                measuredPicker.width + pickerMargin * 2,
              ),
              height: Math.min(
                height - Math.max(0, measuredPicker.y - pickerMargin),
                measuredPicker.height + pickerMargin * 2,
              ),
            }
          : {
              x: Math.max(0, width - Math.min(640, width)),
              y: Math.max(0, height - 790),
              width: Math.min(640, width),
              height: Math.min(720, height),
            },
      ]
    : [];
  nativeControlsWindow.setShape(
    nativeControlsExpanded || nativeChatOverlay
      ? [{ x: 0, y: 0, width, height }]
      : [...normalControlShape, ...centerPlayShape, ...pickerShape],
  );
  if (nativeControlsVisible || nativePlayerPaused) {
    nativeControlsWindow.showInactive();
    nativeControlsWindow.moveTop();
  }
}

async function createNativeControlsWindow(): Promise<void> {
  if (!mainWindow || nativeControlsWindow) return;
  nativeControlsWindow = new BrowserWindow({
    parent: mainWindow,
    icon: applicationIcon,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    show: false,
    focusable: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    thickFrame: false,
    webPreferences: {
      preload: path.join(currentDirectory, "../preload/index.cjs"),
      partition: CONTROLS_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  nativeControlsWindow.setMenu(null);
  lockLocalRendererNavigation(nativeControlsWindow, "controls");
  nativeControlsWindow.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  nativeControlsWindow.webContents.session.on("will-download", (event) =>
    event.preventDefault(),
  );
  nativeControlsWindow.on("closed", () => {
    nativeControlsWindow = null;
  });
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    await nativeControlsWindow.loadURL(new URL("controls.html", rendererUrl).toString());
  } else {
    if (!rendererServer) {
      throw new Error("The local renderer server is unavailable.");
    }
    await nativeControlsWindow.loadURL(`${rendererServer.origin}/controls.html`);
  }
  if (nativeControlsContext) {
    sendToWindow(nativeControlsWindow, "native-controls:context", nativeControlsContext);
  }
  applyNativeControlsBounds();
  nativeControlsWindow.moveTop();
}

function destroyNativeControlsWindow(): void {
  if (nativeControlsWindow && !nativeControlsWindow.isDestroyed()) {
    nativeControlsWindow.destroy();
  }
  nativeControlsWindow = null;
  nativeControlsVisible = true;
  nativeControlsExpanded = false;
  nativePlayerPaused = false;
  nativeEmotePickerOpen = false;
  nativeEmotePickerBounds = null;
  nativeControlsContext = null;
}

let kickWindow: BrowserWindow | null = null;

async function openKickWindow(slug: string, title: string): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (kickWindow && !kickWindow.isDestroyed()) {
    kickWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    parent: mainWindow,
    icon: applicationIcon,
    width: 1120,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    title,
    autoHideMenuBar: true,
    backgroundColor: "#0b0b0e",
    webPreferences: {
      // The signed-in Kick partition, so the page acts as the logged-in user.
      partition: "persist:violetwire-kick",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  kickWindow = window;
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(({ url }) => {
    // Kick opens its clip editor and similar in-page, but keep any external
    // links in the default browser.
    if (url.startsWith("https://kick.com/")) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  window.on("closed", () => {
    kickWindow = null;
  });
  await window.loadURL(`https://kick.com/${slug}`);
}

async function openChannelActionWindow(
  channel: string,
  action: "channel" | "clip",
): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (channelActionWindow && !channelActionWindow.isDestroyed()) {
    channelActionWindow.close();
  }
  const destinations = {
    channel: `https://www.twitch.tv/${channel}`,
    clip: `https://www.twitch.tv/${channel}/clip`,
  } as const;
  const actionWindow = new BrowserWindow({
    parent: mainWindow,
    icon: applicationIcon,
    modal: true,
    frame: true,
    show: true,
    focusable: true,
    resizable: true,
    width: 1040,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    title: action === "channel" ? `Follow ${channel} on Twitch` : `Clip ${channel} on Twitch`,
    autoHideMenuBar: true,
    backgroundColor: "#0e0e10",
    hasShadow: true,
    roundedCorners: true,
    thickFrame: true,
    webPreferences: {
      partition: TWITCH_WEBSITE_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  channelActionWindow = actionWindow;
  if (nativeControlsWindow && !nativeControlsWindow.isDestroyed()) {
    nativeControlsWindow.hide();
  }
  const closed = new Promise<void>((resolve) => actionWindow.once("closed", resolve));
  actionWindow.webContents.setUserAgent(
    actionWindow.webContents.getUserAgent().replace(/\sElectron\/[^\s]+/, ""),
  );
  actionWindow.webContents.setAudioMuted(true);
  actionWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedTwitchNavigation(url)) void actionWindow.loadURL(url);
    return { action: "deny" };
  });
  actionWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedTwitchNavigation(url)) event.preventDefault();
  });
  actionWindow.webContents.on("will-redirect", (event, url) => {
    if (!isAllowedTwitchNavigation(url)) event.preventDefault();
  });
  actionWindow.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  actionWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.key === "Escape" && !actionWindow.isDestroyed()) actionWindow.close();
  });
  actionWindow.on("closed", () => {
    if (channelActionWindow === actionWindow) channelActionWindow = null;
    if (activePlayerMode === "native" && nativeControlsVisible) applyNativeControlsBounds();
  });
  await actionWindow.loadURL(destinations[action]);
  await closed;
}

// A navigation to this URL never happens for real; the modal's header uses it
// as a signal that the close button was pressed, since a sandboxed page cannot
// close its own window.
const SUBSCRIPTION_CLOSE_URL = "https://violetwire.invalid/close";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The modal's own chrome: a titled bar with a close button, above the page. */
function subscriptionShellHtml(title: string, headerHeight: number): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; background: #0e0e10; overflow: hidden; }
    header {
      height: ${headerHeight}px; display: flex; align-items: center; gap: 10px;
      padding: 0 6px 0 14px; background: #17171b;
      border-bottom: 1px solid #2a2a31;
      font: 600 13px/1 "Segoe UI", system-ui, sans-serif; color: #efeff1;
      -webkit-user-select: none; user-select: none;
    }
    header .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    header button {
      appearance: none; border: 0; background: transparent; color: #adadb8;
      width: 32px; height: 32px; border-radius: 6px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
    }
    header button:hover { background: #2a2a31; color: #efeff1; }
  </style></head><body>
    <header>
      <span class="title">${escapeHtml(title)}</span>
      <button id="close" title="Close" aria-label="Close"
        onclick="location.href='${SUBSCRIPTION_CLOSE_URL}'">
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
          <path d="M3 3l9 9M12 3l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
      </button>
    </header>
  </body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * Opens a channel's subscribe page in a modal window. The window's own page is
 * just a titled header with a close button; the subscribe page itself is shown,
 * unmodified, in a WebContentsView below it. Each service loads from its own
 * signed-in session so the page acts as the logged-in user.
 */
async function openSubscriptionModal(
  platform: Platform,
  login: string,
  title: string,
): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (subscriptionWindow && !subscriptionWindow.isDestroyed()) {
    subscriptionWindow.focus();
    return;
  }
  const service =
    platform === "kick"
      ? {
          url: `https://kick.com/${login}/subscribe`,
          partition: KICK_WEBSITE_PARTITION,
          isAllowed: isAllowedKickNavigation,
        }
      : {
          url: `https://www.twitch.tv/subs/${login}`,
          partition: TWITCH_WEBSITE_PARTITION,
          isAllowed: isAllowedTwitchNavigation,
        };
  const headerHeight = 44;
  const win = new BrowserWindow({
    parent: mainWindow,
    icon: applicationIcon,
    modal: true,
    frame: false,
    show: false,
    resizable: true,
    width: 560,
    height: 940,
    minWidth: 420,
    minHeight: 620,
    title,
    autoHideMenuBar: true,
    backgroundColor: "#0e0e10",
    hasShadow: true,
    roundedCorners: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  subscriptionWindow = win;

  const view = new WebContentsView({
    webPreferences: {
      partition: service.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.contentView.addChildView(view);
  const layoutView = () => {
    if (win.isDestroyed()) return;
    const { width, height } = win.getContentBounds();
    view.setBounds({ x: 0, y: headerHeight, width, height: Math.max(0, height - headerHeight) });
  };
  layoutView();
  win.on("resize", layoutView);

  const page = view.webContents;
  page.setUserAgent(page.getUserAgent().replace(/\sElectron\/[^\s]+/, ""));
  page.setAudioMuted(true);
  page.setWindowOpenHandler(({ url }) => {
    if (service.isAllowed(url)) void page.loadURL(url);
    return { action: "deny" };
  });
  const blockNavigation = (event: Electron.Event, url: string) => {
    if (!service.isAllowed(url)) event.preventDefault();
  };
  page.on("will-navigate", blockNavigation);
  page.on("will-redirect", blockNavigation);
  page.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  // The header is the window's own page. Its close button navigates to a
  // sentinel we intercept here, and Escape closes too.
  win.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (url.startsWith(SUBSCRIPTION_CLOSE_URL) && !win.isDestroyed()) win.close();
  });
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.key === "Escape" && !win.isDestroyed()) win.close();
  });
  win.on("closed", () => {
    if (subscriptionWindow === win) subscriptionWindow = null;
    if (activePlayerMode === "native" && nativeControlsVisible) applyNativeControlsBounds();
  });

  if (nativeControlsWindow && !nativeControlsWindow.isDestroyed()) nativeControlsWindow.hide();

  await win.webContents.loadURL(subscriptionShellHtml(title, headerHeight));
  if (win.isDestroyed()) return;
  void page.loadURL(service.url);
  win.show();
  win.focus();
}

function applyChatBounds(): void {
  if (!chatView || !lastChatBounds) return;

  if (chatPresentation === "overlay" && chatOverlayWindow && mainWindow) {
    const contentBounds = mainWindow.getContentBounds();
    chatOverlayWindow.setBounds({
      x: contentBounds.x + lastChatBounds.x,
      y: contentBounds.y + lastChatBounds.y,
      width: lastChatBounds.width,
      height: lastChatBounds.height,
    });
    chatView.setBounds({
      x: 0,
      y: 0,
      width: lastChatBounds.width,
      height: lastChatBounds.height,
    });
    if (chatVisible) {
      chatOverlayWindow.showInactive();
      chatOverlayWindow.moveTop();
    }
    return;
  }

  chatView.setBounds(lastChatBounds);
}

function setChatPresentation(presentation: ChatPresentation): void {
  if (!chatView || !mainWindow || presentation === chatPresentation) return;

  if (presentation === "overlay") {
    mainWindow.contentView.removeChildView(chatView);
    chatOverlayWindow = new BaseWindow({
      parent: mainWindow,
      frame: false,
      show: false,
      focusable: true,
      skipTaskbar: true,
      opacity: 0.92,
      backgroundColor: "#18181b",
      hasShadow: true,
      roundedCorners: true,
      thickFrame: false,
    });
    chatOverlayWindow.contentView.addChildView(chatView);
  } else {
    if (chatOverlayWindow && !chatOverlayWindow.isDestroyed()) {
      chatOverlayWindow.contentView.removeChildView(chatView);
      chatOverlayWindow.destroy();
    }
    chatOverlayWindow = null;
    mainWindow.contentView.addChildView(chatView);
  }

  chatPresentation = presentation;
  applyChatBounds();
  if (!chatVisible) {
    if (chatPresentation === "overlay") chatOverlayWindow?.hide();
    else chatView.setVisible(false);
  }
}

function destroyPlayer(invalidatePendingOpen = true, keepTextureSession = false): void {
  if (invalidatePendingOpen) playerOpenGeneration += 1;
  if (channelActionWindow && !channelActionWindow.isDestroyed()) channelActionWindow.close();
  channelActionWindow = null;
  if (subscriptionWindow && !subscriptionWindow.isDestroyed()) subscriptionWindow.close();
  subscriptionWindow = null;
  nativePlayer.destroy();
  // A native→native channel switch keeps the texture session so mpv can swap
  // streams in place instead of rebuilding the whole graphics pipeline.
  if (!keepTextureSession) textureNativePlayer.destroy();
  twitchChatService.disconnect();
  destroyNativeControlsWindow();
  activePlayerMode = null;
  activeNativeBackend = null;
  activeChannelName = null;
  textureFallbackInProgress = false;
  if (chatView) {
    if (chatOverlayWindow && !chatOverlayWindow.isDestroyed()) {
      chatOverlayWindow.contentView.removeChildView(chatView);
      chatOverlayWindow.destroy();
    } else {
      mainWindow?.contentView.removeChildView(chatView);
    }
    chatView.webContents.close();
    chatView = null;
  }
  chatOverlayWindow = null;
  chatPresentation = "side";
  chatVisible = true;
  lastChatBounds = null;
}

// Matches the renderer's .titlebar strip, which sits above the top bar and
// holds the native caption buttons. Keep the two in step.
const TITLE_BAR_HEIGHT = 30;
// The strip is border-box, so its bottom border is the last pixel of that
// height. The system paints the caption buttons over the full overlay height,
// which would cover the border and leave the divider stopping short of the
// window edge, so the overlay stops one pixel above it.
const TITLE_BAR_BORDER = 1;

function titleBarOverlayOptions(oledMode: boolean): {
  color: string;
  symbolColor: string;
  height: number;
} {
  return {
    // Keep these in step with .titlebar and .oled-mode .titlebar in styles.css.
    color: oledMode ? "#000000" : "#121216",
    symbolColor: "#d4d4d8",
    height: TITLE_BAR_HEIGHT - TITLE_BAR_BORDER,
  };
}

function applyTitleBarTheme(oledMode: boolean): void {
  // setTitleBarOverlay is Windows and Linux only.
  if (process.platform === "darwin") return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setTitleBarOverlay(titleBarOverlayOptions(oledMode));
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#09090b",
    title: "VioletWire",
    icon: applicationIcon,
    autoHideMenuBar: true,
    // Hide the system title bar but keep the real caption buttons, so the top
    // bar doubles as the title bar and the buttons still get Snap Layouts,
    // tooltips, and correct hit-testing. A fully custom frame would lose those.
    titleBarStyle: "hidden",
    // Preferences are initialized before this runs, so OLED mode is applied on
    // the first paint rather than flashing the lighter colour first.
    titleBarOverlay: titleBarOverlayOptions(preferencesService.get().oledMode),
    webPreferences: {
      preload: path.join(currentDirectory, "../preload/index.cjs"),
      partition: APP_UI_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The transparent controls/chat window can fully cover the player in
      // fullscreen. Keep Chromium compositing the imported VideoFrames while
      // that owned window is above the main renderer.
      backgroundThrottling: false,
    },
  });
  const createdWindow = mainWindow;
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  mainWindow.webContents.session.on("will-download", (event) =>
    event.preventDefault(),
  );
  let htmlFullscreen = false;
  mainWindow.webContents.on("enter-html-full-screen", () => {
    htmlFullscreen = true;
    sendToWindow(createdWindow, "window:fullscreen-changed", true);
  });
  mainWindow.webContents.on("leave-html-full-screen", () => {
    htmlFullscreen = false;
    sendToWindow(createdWindow, "window:fullscreen-changed", false);
  });
  mainWindow.on("enter-full-screen", () => {
    sendToWindow(createdWindow, "window:fullscreen-changed", true);
  });
  mainWindow.on("leave-full-screen", () => {
    sendToWindow(createdWindow, "window:fullscreen-changed", false);
  });
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (
      input.type !== "keyDown" ||
      (input.key !== "Escape" && input.key !== "F11") ||
      (!htmlFullscreen && !createdWindow.isFullScreen())
    ) {
      return;
    }
    event.preventDefault();
    htmlFullscreen = false;
    void createdWindow.webContents
      .executeJavaScript(
        "document.fullscreenElement ? document.exitFullscreen() : undefined",
      )
      .catch(() => undefined);
    createdWindow.setFullScreen(false);
    sendToWindow(createdWindow, "window:fullscreen-changed", false);
  });

  mainWindow.on("closed", () => {
    destroyPlayer();
    mainWindow = null;
  });
  mainWindow.on("will-move", suspendDetachedNativeSurfaces);
  mainWindow.on("moved", restoreDetachedNativeSurfaces);
  mainWindow.on("will-resize", suspendDetachedNativeSurfaces);
  mainWindow.on("resized", restoreDetachedNativeSurfaces);

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    trustedRendererOrigin = new URL(rendererUrl).origin;
    lockLocalRendererNavigation(mainWindow, "main");
    await mainWindow.loadURL(rendererUrl);
  } else {
    rendererServer ??= await startRendererServer(
      path.join(currentDirectory, "../../dist/renderer"),
    );
    trustedRendererOrigin = rendererServer.origin;
    lockLocalRendererNavigation(mainWindow, "main");
    await mainWindow.loadURL(`${rendererServer.origin}/index.html`);
  }
}

handleTrusted(
  "player:open",
  async (_event, input: unknown, requestedModeInput: unknown, requestedQualityInput: unknown) => {
  const channel = channelKeySchema.parse(input);
  const requestedMode = playerModeSchema.parse(requestedModeInput);
  const requestedQuality =
    requestedQualityInput === undefined ? "best" : nativeQualitySchema.parse(requestedQualityInput);
  // Opening a single stream leaves multistream mode; free those tiles first.
  if (multiStreamManager.isActive()) multiStreamManager.stop();
  const openGeneration = ++playerOpenGeneration;
  const keepTextureSession =
    requestedMode === "native" &&
    activePlayerMode === "native" &&
    activeNativeBackend === "texture" &&
    preferencesService.get().experimentalTexturePlayer;
  destroyPlayer(false, keepTextureSession);
  activeChannelName = channel;

  let mode = requestedMode;
  let nativeBackend: NativeRenderBackend | undefined;
  let fallbackReason: string | undefined;
  if (requestedMode === "native") {
    const useTextureBackend = preferencesService.get().experimentalTexturePlayer;
    const textureResult = useTextureBackend
      ? await textureNativePlayer.start(channel, requestedQuality, {
          kind: "channel",
          detail: channel,
        })
      : null;
    if (openGeneration !== playerOpenGeneration || activeChannelName !== channel) {
      // A newer player request intentionally cancelled this startup. Its
      // cancellation is not a texture failure and must not trigger fallback.
      return { channel, mode: requestedMode };
    }
    // A failed texture attempt may leave a kept-alive session behind (for
    // example a reused switch whose URL resolution failed); tear it down
    // before handing playback to the window-hosted player.
    if (textureResult && !textureResult.ok) textureNativePlayer.destroy();
    // An offline channel is not a texture failure. Keep the native renderer
    // selected so the app can show its own offline state and retry control;
    // do not silently replace the user's selected playback surface with
    // Twitch's Standard iframe.
    const textureFoundOffline =
      textureResult && !textureResult.ok && isNativeStreamUnavailable(textureResult.reason);
    const result = textureResult?.ok
      ? textureResult
      : textureFoundOffline
        ? { ok: false as const, reason: textureResult.reason }
        : nativePlayer.start(channel, requestedQuality);
    if (!result.ok && !textureFoundOffline) {
      mode = "official";
      fallbackReason = textureResult && !textureResult.ok
        ? `${textureResult.reason} Window-hosted Native also failed: ${result.reason}`
        : result.reason;
    } else if (textureFoundOffline) {
      nativeBackend = "texture";
      activeNativeBackend = nativeBackend;
    } else {
      nativeBackend = textureResult?.ok ? "texture" : "window";
      activeNativeBackend = nativeBackend;
      if (textureResult && !textureResult.ok) {
        fallbackReason = `Embedded Native unavailable: ${textureResult.reason} Using the window-hosted Native player.`;
      }
      // Texture playback is composited inside the main renderer, so its
      // controls render inline over the canvas. The transparent controls
      // BrowserWindow is only needed for the legacy HWND/airspace backend.
      if (nativeBackend === "window") await createNativeControlsWindow();
    }
  }

  activePlayerMode = mode;

  chatPresentation = "side";
  chatVisible = true;
  // Each service has its own chat transport, and only one is ever live.
  const chatTarget = parseChannelKey(channel);
  if (chatTarget.platform === "kick") {
    twitchChatService.disconnect();
    void kickChatService.connect(chatTarget.login);
  } else {
    kickChatService.disconnect();
    twitchChatService.connect(channel);
  }

  return { channel, mode, nativeBackend, fallbackReason };
  },
);

handleTrusted("player:close", () => destroyPlayer());

onTrusted("player:set-bounds", (_event, input: unknown) => {
  const result = playerBoundsSchema.safeParse(input);
  if (!result.success) return;
  lastPlayerBounds = result.data;
  // The optimistic renderer mounts before Streamlink resolves. Retain those
  // initial measurements so the texture addon starts at the real player size.
  textureNativePlayer.setBounds(result.data);
  if (activePlayerMode === "native") {
    if (activeNativeBackend === "window") nativePlayer.setBounds(result.data);
    applyNativeControlsBounds();
  }
});

onTrusted("player:set-chat-bounds", (_event, input: unknown) => {
  const result = playerBoundsSchema.safeParse(input);
  if (!result.success) return;
  lastChatBounds = result.data;
  if (chatView) applyChatBounds();
  if (nativeEmotePickerOpen) applyNativeControlsBounds();
});

onTrusted("player:set-chat-visible", (_event, visible: unknown) => {
  if (!chatView || typeof visible !== "boolean") return;
  chatVisible = visible;
  if (chatPresentation === "overlay") {
    if (visible) {
      applyChatBounds();
      chatOverlayWindow?.showInactive();
      chatOverlayWindow?.moveTop();
    } else {
      chatOverlayWindow?.hide();
    }
  } else {
    chatView.setVisible(visible);
  }
});

onTrusted("player:set-chat-presentation", (_event, input: unknown) => {
  const result = chatPresentationSchema.safeParse(input);
  if (result.success) setChatPresentation(result.data);
});

handleTrusted("native-player:get-availability", () => {
  const availability = nativePlayer.getAvailability();
  const textureAvailability = textureNativePlayer.getAvailability();
  return {
    ...availability,
    textureAvailable: textureAvailability.available,
    textureReason: textureAvailability.reason,
  };
});

handleTrusted("native-player:get-qualities", (_event, input: unknown) => {
  const channel = channelKeySchema.parse(input);
  return nativePlayer.getQualities(channel);
});

handleTrusted(
  "native-player:set-quality",
  async (_event, channelInput: unknown, qualityInput: unknown) => {
    if (activePlayerMode !== "native") return;
    const channel = channelKeySchema.parse(channelInput);
    const quality = nativeQualitySchema.parse(qualityInput);
    const result =
      activeNativeBackend === "texture"
        ? await textureNativePlayer.start(channel, quality, {
            kind: "quality",
            detail: quality,
          })
        : nativePlayer.start(channel, quality);
    if (!result.ok) throw new Error(result.reason);
  },
);

// Persist the single-player volume so a later stream opens at the same level.
// Debounced because the slider fires many set-volume events while dragging.
let volumePersistTimer: NodeJS.Timeout | null = null;
function persistPlayerVolume(volume: number): void {
  if (volumePersistTimer) clearTimeout(volumePersistTimer);
  volumePersistTimer = setTimeout(() => {
    void preferencesService
      .update({ playerVolume: Math.min(100, Math.max(0, Math.round(volume))) })
      .catch(() => undefined);
  }, 400);
}

// Only the texture backend can report these; the window backend drives mpv as
// a separate process with no property channel back to us.
handleTrusted("native-player:stats", () =>
  activePlayerMode === "native" && activeNativeBackend === "texture"
    ? textureNativePlayer.getStats()
    : null,
);

onTrusted("native-player:control", (_event, input: unknown) => {
  const result = nativePlayerCommandSchema.safeParse(input);
  if (!result.success || activePlayerMode !== "native") return;
  if (result.data.command === "set-volume") persistPlayerVolume(result.data.value);
  if (activeNativeBackend === "texture") textureNativePlayer.control(result.data);
  else nativePlayer.control(result.data);
});

function isMultiTileId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < MAX_MULTISTREAM_TILES
  );
}

handleTrusted("native-multi:start", async (_event, input: unknown) => {
  if (!Array.isArray(input)) return [];
  const channels: string[] = [];
  for (const entry of input) {
    const result = channelKeySchema.safeParse(entry);
    if (result.success) channels.push(result.data);
  }
  // Multistream replaces the single full-window player; tear it down so its
  // mpv/GPU resources are free before the tiles start.
  destroyPlayer();
  const tiles = await multiStreamManager.start(channels);
  // Connect every tile's chat up front so switching tabs is instant.
  multiChatService.setChannels(multiStreamManager.getChannels());
  return tiles;
});

handleTrusted("native-multi:add-tile", async (_event, input: unknown) => {
  const result = channelKeySchema.safeParse(input);
  if (!result.success) return null;
  const tile = await multiStreamManager.addTile(result.data);
  multiChatService.setChannels(multiStreamManager.getChannels());
  return tile;
});

onTrusted("native-multi:stop", () => {
  multiStreamManager.stop();
  multiChatService.stop();
});

onTrusted("native-multi:remove-tile", (_event, input: unknown) => {
  if (isMultiTileId(input)) {
    multiStreamManager.removeTile(input);
    multiChatService.setChannels(multiStreamManager.getChannels());
  }
});

onTrusted("native-multi:set-active", (_event, input: unknown) => {
  if (isMultiTileId(input)) multiStreamManager.setActive(input);
});

onTrusted("native-multi:set-bounds", (_event, idInput: unknown, boundsInput: unknown) => {
  if (!isMultiTileId(idInput)) return;
  const result = playerBoundsSchema.safeParse(boundsInput);
  if (result.success) multiStreamManager.setBounds(idInput, result.data);
});

onTrusted("native-multi:control", (_event, idInput: unknown, commandInput: unknown) => {
  if (!isMultiTileId(idInput)) return;
  const result = nativePlayerCommandSchema.safeParse(commandInput);
  if (result.success) multiStreamManager.control(idInput, result.data);
});

handleTrusted("native-multi:set-quality", async (_event, idInput: unknown, qualityInput: unknown) => {
  if (!isMultiTileId(idInput)) return;
  const quality = nativeQualitySchema.parse(qualityInput);
  await multiStreamManager.setQuality(idInput, quality);
});

onTrusted("player:preresolve", (_event, input: unknown) => {
  const result = channelKeySchema.safeParse(input);
  if (!result.success) return;
  // Hovering a channel card speculatively resolves its stream URL so a click
  // skips the Streamlink round trip. Only worthwhile for the texture backend,
  // which starts from a pre-resolved URL.
  const preferences = preferencesService.get();
  if (preferences.preferredPlayerMode !== "native" || !preferences.experimentalTexturePlayer) {
    return;
  }
  textureNativePlayer.preresolve(result.data);
});

onTrusted("native-controls:set-visible", (_event, input: unknown) => {
  if (typeof input !== "boolean") return;
  nativeControlsVisible = input;
  if (!nativeControlsWindow) return;
  sendToWindow(nativeControlsWindow, "native-controls:visibility", input);
  if (input) {
    applyNativeControlsBounds();
    nativeControlsWindow.moveTop();
  } else if (
    !nativeControlsExpanded &&
    !nativePlayerPaused &&
    !nativeEmotePickerOpen &&
    !(nativeControlsContext?.chatVisible && nativeControlsContext.chatPresentation === "overlay")
  ) {
    nativeControlsWindow.hide();
  } else {
    applyNativeControlsBounds();
    nativeControlsWindow.moveTop();
  }
});

onTrusted("native-controls:set-expanded", (_event, input: unknown) => {
  if (typeof input !== "boolean") return;
  nativeControlsExpanded = input;
  if (!nativeControlsWindow) return;
  const nativeChatOverlay =
    nativeControlsContext?.chatVisible && nativeControlsContext.chatPresentation === "overlay";
  if (!input && !nativeEmotePickerOpen && !nativeControlsVisible && !nativeChatOverlay) {
    nativeControlsWindow.hide();
    return;
  }
  applyNativeControlsBounds();
});

onTrusted("native-controls:set-emote-picker", (_event, input: unknown) => {
  if (typeof input !== "boolean" || activePlayerMode !== "native") return;
  nativeEmotePickerOpen = input;
  if (!input) nativeEmotePickerBounds = null;
  sendToWindow(mainWindow, "native-controls:emote-picker", input);
  sendToWindow(nativeControlsWindow, "native-controls:emote-picker", input);
  if (!nativeControlsWindow) return;
  if (input) {
    nativeControlsVisible = true;
    sendToWindow(nativeControlsWindow, "native-controls:visibility", true);
    applyNativeControlsBounds();
    nativeControlsWindow.show();
    nativeControlsWindow.moveTop();
  } else {
    applyNativeControlsBounds();
  }
});
onTrusted("player:set-modal-open", (_event, input: unknown) => {
  if (typeof input !== "boolean" || activePlayerMode !== "native") return;
  if (input) suspendDetachedNativeSurfaces();
  else restoreDetachedNativeSurfaces();
});

onTrusted("native-controls:set-emote-picker-bounds", (_event, input: unknown) => {
  if (input === null) {
    nativeEmotePickerBounds = null;
    return;
  }
  const result = playerBoundsSchema.safeParse(input);
  if (!result.success) return;
  nativeEmotePickerBounds = result.data;
  if (nativeEmotePickerOpen) applyNativeControlsBounds();
});

onTrusted("native-controls:emote-selected", (_event, input: unknown) => {
  const result = outgoingChatMessageSchema.safeParse(input);
  if (!result.success) return;
  nativeEmotePickerOpen = false;
  nativeEmotePickerBounds = null;
  sendToWindow(mainWindow, "native-controls:emote-selected", result.data);
  sendToWindow(mainWindow, "native-controls:emote-picker", false);
  sendToWindow(nativeControlsWindow, "native-controls:emote-picker", false);
  applyNativeControlsBounds();
});

onTrusted("native-controls:ready", (event) => {
  event.sender.send("native-player:state", nativePlayer.getState());
  event.sender.send("native-controls:visibility", nativeControlsVisible);
  const context =
    nativeControlsContext ??
    (activeChannelName
      ? {
          channel: activeChannelName,
          fullscreen: mainWindow?.isFullScreen() ?? false,
          theaterMode: false,
          chatVisible,
          chatPresentation,
        }
      : null);
  if (context) {
    event.sender.send("native-controls:context", context);
  }
});

onTrusted("native-controls:set-context", (_event, input: unknown) => {
  const result = nativeControlsContextSchema.safeParse(input);
  if (!result.success) return;
  nativeControlsContext = result.data;
  sendToWindow(nativeControlsWindow, "native-controls:context", result.data);
  applyNativeControlsBounds();
  if (result.data.chatVisible && result.data.chatPresentation === "overlay") {
    nativeControlsWindow?.showInactive();
    nativeControlsWindow?.moveTop();
  }
});

onTrusted("native-controls:action", (_event, input: unknown) => {
  const result = nativeControlActionSchema.safeParse(input);
  if (!result.success) return;
  sendToWindow(mainWindow, "native-controls:action", result.data);
});

handleTrusted("window:set-fullscreen", (_event, fullscreen: unknown) => {
  if (!mainWindow || typeof fullscreen !== "boolean") return false;
  mainWindow.setFullScreen(fullscreen);
  return mainWindow.isFullScreen();
});

handleTrusted("system:open-external", async (_event, input: unknown) => {
  if (typeof input !== "string" || input.length > 2_048) {
    throw new Error("Invalid external link.");
  }
  const url = new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only web links can be opened.");
  }
  // Opening a browser is a one-way action. Do not keep the renderer's IPC
  // request pending while Windows waits for the default-browser shell command
  // to finish, particularly while texture playback is keeping the main process
  // busy with frame transfers.
  void shell.openExternal(url.toString()).catch((reason: unknown) => {
    console.error(
      "[external-link] Unable to open URL:",
      reason instanceof Error ? reason.message : String(reason),
    );
  });
});

handleTrusted("channel:open-action", async (_event, rawChannel: unknown, rawAction: unknown) => {
  const channel = channelNameSchema.parse(rawChannel);
  const action = channelActionSchema.parse(rawAction);
  await openChannelActionWindow(channel, action);
});

handleTrusted("subscription:open", async (_event, rawChannel: unknown, rawTitle: unknown) => {
  const { platform, login } = parseChannelKey(channelKeySchema.parse(rawChannel));
  const title = z.string().trim().min(1).max(80).parse(rawTitle);
  await openSubscriptionModal(platform, login, title);
});

handleTrusted("twitch:get-auth-state", () => twitchService.getAuthState());
handleTrusted("twitch:begin-sign-in", () => twitchService.beginSignIn());
handleTrusted("twitch:complete-sign-in", () => twitchService.completeSignIn());
handleTrusted("twitch:cancel-sign-in", () => twitchService.cancelSignIn());
handleTrusted("twitch:sign-out", () => twitchService.signOut());
handleTrusted("twitch-playback:get-state", () => playbackSessionService.getState());
handleTrusted("twitch-playback:link", () => playbackSessionService.link());
handleTrusted("twitch-playback:unlink", () => playbackSessionService.unlink());
handleTrusted("twitch:get-followed-channels", () => twitchService.getFollowedChannels());
handleTrusted(
  "twitch:get-browse-categories",
  (_event, rawQuery: unknown, rawAfter: unknown) => {
    const query = typeof rawQuery === "string" ? rawQuery.slice(0, 100) : "";
    const after = typeof rawAfter === "string" ? rawAfter.slice(0, 500) : undefined;
    return twitchService.getBrowseCategories(query, after);
  },
);
handleTrusted(
  "twitch:get-category-streams",
  (_event, rawGameId: unknown, rawAfter: unknown) => {
    if (typeof rawGameId !== "string" || !/^\d+$/.test(rawGameId)) {
      throw new Error("Invalid Twitch category.");
    }
    const after = typeof rawAfter === "string" ? rawAfter.slice(0, 500) : undefined;
    return twitchService.getCategoryStreams(rawGameId, after);
  },
);
handleTrusted("kick:get-user", () => kickService.getUser());
handleTrusted("kick:sign-in", () => kickService.signIn());
handleTrusted("kick:sign-out", () => kickService.signOut());
handleTrusted("kick:get-followed", () => kickService.getFollowedChannels());
handleTrusted("kick:open-window", (_event, rawSlug: unknown) => {
  const slug = typeof rawSlug === "string" ? rawSlug.slice(0, 40).toLowerCase() : "";
  if (!/^[a-z0-9_-]+$/.test(slug)) throw new Error("A channel is required.");
  return openKickWindow(slug, `${slug} on Kick`);
});
handleTrusted("kick:set-following", (_event, rawSlug: unknown, rawFollow: unknown) => {
  const slug = typeof rawSlug === "string" ? rawSlug.slice(0, 40).toLowerCase() : "";
  if (slug.length === 0) throw new Error("A channel is required.");
  return kickService.setFollowing(slug, rawFollow === true);
});

handleTrusted("kick:get-emote-sets", (_event, rawSlug: unknown) => {
  const slug = typeof rawSlug === "string" ? rawSlug.slice(0, 40).toLowerCase() : "";
  return slug.length === 0 ? [] : kickService.getEmoteSets(slug);
});

handleTrusted("kick:get-channel", (_event, rawSlug: unknown) => {
  const slug = typeof rawSlug === "string" ? rawSlug.slice(0, 40).toLowerCase() : "";
  return slug.length === 0 ? null : kickService.getChannel(slug);
});

handleTrusted("kick:search", (_event, rawQuery: unknown) => {
  const query = typeof rawQuery === "string" ? rawQuery.slice(0, 100) : "";
  // Returns an empty list rather than throwing: Kick's API is unofficial, so a
  // failure there must not take the Twitch results down with it.
  return kickService.search(query);
});

handleTrusted("kick:get-categories", (_event, rawQuery: unknown, rawCursor: unknown) => {
  const query = typeof rawQuery === "string" ? rawQuery.slice(0, 100) : "";
  const cursor = typeof rawCursor === "string" ? rawCursor.slice(0, 12) : undefined;
  return kickService.getCategories(query, cursor);
});

handleTrusted("kick:get-category-streams", (_event, rawCategoryId: unknown, rawCursor: unknown) => {
  const categoryId = typeof rawCategoryId === "string" ? rawCategoryId.slice(0, 20) : "";
  const cursor = typeof rawCursor === "string" ? rawCursor.slice(0, 200) : undefined;
  return categoryId.length === 0
    ? { items: [] }
    : kickService.getCategoryStreams(categoryId, cursor);
});

handleTrusted("twitch:search", (_event, rawQuery: unknown) => {
  if (typeof rawQuery !== "string") throw new Error("Search text must be a string.");
  return twitchService.search(rawQuery.slice(0, 100));
});
handleTrusted("twitch:get-stream-metadata", (_event, rawChannel: unknown) =>
  twitchService.getStreamMetadata(channelNameSchema.parse(rawChannel)),
);
handleTrusted(
  "twitch:get-chat-user-profile",
  (_event, rawChannel: unknown, rawLogin: unknown) =>
    twitchService.getChatUserProfile(
      channelNameSchema.parse(rawChannel),
      channelNameSchema.parse(rawLogin),
    ),
);
handleTrusted("twitch:create-clip", (_event, rawChannel: unknown) =>
  twitchService.createClip(channelNameSchema.parse(rawChannel)),
);
handleTrusted("twitch:open-channel", (_event, rawChannel: unknown) =>
  twitchService.openChannel(channelNameSchema.parse(rawChannel)),
);
handleTrusted("emotes:7tv-global", () => sevenTvService.getGlobal());
handleTrusted("emotes:7tv-channel", (_event, broadcasterId: unknown, rawPlatform: unknown) => {
  if (typeof broadcasterId !== "string") throw new Error("Broadcaster ID must be text.");
  // 7TV indexes users per service, so Kick channels resolve under their Kick id.
  const platform = rawPlatform === "kick" ? "kick" : "twitch";
  return sevenTvService.getChannel(broadcasterId, platform);
});
handleTrusted("emotes:ffz-global", () => thirdPartyEmoteService.getFfzGlobal());
handleTrusted("emotes:ffz-channel", (_event, broadcasterId: unknown) => {
  if (typeof broadcasterId !== "string") throw new Error("Broadcaster ID must be text.");
  return thirdPartyEmoteService.getFfzChannel(broadcasterId);
});
handleTrusted("emotes:bttv-global", () => thirdPartyEmoteService.getBttvGlobal());
handleTrusted("emotes:bttv-channel", (_event, broadcasterId: unknown) => {
  if (typeof broadcasterId !== "string") throw new Error("Broadcaster ID must be text.");
  return thirdPartyEmoteService.getBttvChannel(broadcasterId);
});
handleTrusted("emotes:clear-cache", async () => {
  await Promise.all([sevenTvService.clear(), thirdPartyEmoteService.clear()]);
});
handleTrusted("chat:send", (
  _event,
  rawChannel: unknown,
  rawMessage: unknown,
  rawReplyParentMessageId: unknown,
) => {
  const target = channelKeySchema.safeParse(rawChannel);
  if (target.success && parseChannelKey(target.data).platform === "kick") {
    // The room is whatever the live chat connection is subscribed to, so a
    // message cannot be posted to a channel that is not the one on screen.
    const chatroomId = kickChatService.getChatroomId();
    if (chatroomId === null) throw new Error("Kick chat is not connected.");
    return kickService.sendMessage(chatroomId, outgoingChatMessageSchema.parse(rawMessage));
  }
  const channel = channelNameSchema.parse(rawChannel);
  const message = outgoingChatMessageSchema.parse(rawMessage);
  const replyParentMessageId =
    rawReplyParentMessageId === undefined
      ? undefined
      : chatReplyParentIdSchema.parse(rawReplyParentMessageId);
  return twitchService.sendChatMessage(channel, message, replyParentMessageId);
});
handleTrusted("chat:get-assets", (_event, rawChannel: unknown) => {
  // These come from Helix and are keyed by a Twitch login. A channel on another
  // service has none, and parsing it as a Twitch name would throw.
  const channel = channelKeySchema.safeParse(rawChannel);
  if (!channel.success || parseChannelKey(channel.data).platform !== "twitch") {
    const empty: TwitchChatAssets = { broadcasterId: "", badges: [], emotes: [] };
    return empty;
  }
  return twitchService.getChatAssets(channel.data);
});
onTrusted("chat:set-history-limit", (_event, rawLimit: unknown) => {
  const result = chatHistoryLimitSchema.safeParse(rawLimit);
  if (result.success) {
    twitchChatService.setHistoryLimit(result.data);
    kickChatService.setHistoryLimit(result.data);
    multiChatService.setHistoryLimit(result.data);
  }
});
handleTrusted("updates:get-status", () => updateService.getStatus());
handleTrusted("updates:get-release-notes", (_event, forceRefresh: unknown) => {
  if (forceRefresh !== undefined && typeof forceRefresh !== "boolean") {
    throw new Error("Invalid release-notes refresh request.");
  }
  return githubReleaseNotesService.getMarkdown(forceRefresh === true);
});

handleTrusted("system:get-link-preview", (_event, input: unknown) => {
  if (typeof input !== "string" || input.length > 2_048) return null;
  return linkPreviewService.getPreview(input);
});
handleTrusted("updates:check", () => updateService.check());
onTrusted("updates:install", () => updateService.install());
handleTrusted("preferences:get-or-migrate", (_event, legacyPreferences: unknown) =>
  preferencesService.getOrMigrate(legacyPreferences),
);
handleTrusted("preferences:update", async (_event, patch: unknown) => {
  const preferences = await preferencesService.update(patch);
  // The caption buttons are drawn by the system, so OLED mode has to be pushed
  // to them explicitly or the top bar goes black around light grey buttons.
  applyTitleBarTheme(preferences.oledMode);
  sendToWindow(mainWindow, "preferences:changed", preferences);
  sendToWindow(nativeControlsWindow, "preferences:changed", preferences);
  return preferences;
});

app.whenReady().then(async () => {
  app.setAppUserModelId("app.violetwire.viewer");
  // VioletWire provides its own application UI. Removing Electron's default
  // menu also prevents Windows from revealing File/Edit/View when Alt is used
  // for emote-picker shortcuts.
  Menu.setApplicationMenu(null);
  powerMonitor.on("resume", () => {
    textureNativePlayer.recoverGraphics();
    multiStreamManager.recoverGraphics();
  });
  powerMonitor.on("unlock-screen", () => {
    textureNativePlayer.recoverGraphics();
    multiStreamManager.recoverGraphics();
  });
  await preferencesService.initialize();
  await playbackSessionService.initialize();
  await twitchService.initialize();
  await createWindow();
  updateService.initialize();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  if (rendererServer) void rendererServer.close();
  rendererServer = null;
});
