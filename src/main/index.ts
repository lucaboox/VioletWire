import {
  app,
  BaseWindow,
  BrowserWindow,
  ipcMain,
  powerMonitor,
  shell,
  WebContentsView,
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
  type ChatPresentation,
  type ChannelAction,
  type ChannelActionWindowState,
  type NativeControlsContext,
  type NativeRenderBackend,
  type PlayerMode,
} from "../shared/player";
import { NativePlayer } from "./native-player";
import { TextureNativePlayer } from "./texture-native-player";
import { TwitchService } from "./twitch-service";
import { PlaybackSessionService } from "./playback-session";
import { SevenTvService } from "./seven-tv-service";
import { ThirdPartyEmoteService } from "./third-party-emote-service";
import { TwitchChatService } from "./twitch-chat-service";
import { UpdateService } from "./update-service";
import { startRendererServer, type RendererServer } from "./renderer-server";
import {
  chatHistoryLimitSchema,
  chatReplyParentIdSchema,
  outgoingChatMessageSchema,
} from "../shared/chat";
import { PreferencesService } from "./preferences-service";

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
let channelActionKind: ChannelAction | null = null;
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

function sendChannelActionState(
  action: ChannelAction,
  state: ChannelActionWindowState,
): void {
  sendToWindow(mainWindow, "channel-action:state", action, state);
}
const updateService = new UpdateService(
  () => mainWindow,
  (status) => sendToWindow(mainWindow, "updates:status", status),
);

function suspendDetachedNativeSurfaces(): void {
  if (activePlayerMode !== "native") return;
  if (activeNativeBackend === "window") nativePlayer.suspendSurface();
  if (nativeControlsWindow && !nativeControlsWindow.isDestroyed()) nativeControlsWindow.hide();
  if (chatOverlayWindow && !chatOverlayWindow.isDestroyed()) chatOverlayWindow.hide();
  if (
    channelActionKind === "subscribe" &&
    channelActionWindow &&
    !channelActionWindow.isDestroyed()
  ) {
    channelActionWindow.hide();
  }
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
  if (
    channelActionKind === "subscribe" &&
    channelActionWindow &&
    !channelActionWindow.isDestroyed()
  ) {
    applySubscriptionDrawerBounds();
    channelActionWindow.show();
    channelActionWindow.moveTop();
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
);
const twitchService = new TwitchService();
const preferencesService = new PreferencesService();
function isAllowedTwitchNavigation(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && (url.hostname === "twitch.tv" || url.hostname.endsWith(".twitch.tv"));
  } catch {
    return false;
  }
}

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
      partition: "persist:glint-twitch-playback",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  nativeControlsWindow.setMenu(null);
  nativeControlsWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  nativeControlsWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  nativeControlsWindow.on("closed", () => {
    nativeControlsWindow = null;
  });
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    await nativeControlsWindow.loadURL(new URL("controls.html", rendererUrl).toString());
  } else {
    await nativeControlsWindow.loadFile(
      path.join(currentDirectory, "../../dist/renderer/controls.html"),
    );
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

async function openChannelActionWindow(
  channel: string,
  action: "channel" | "subscribe" | "clip",
): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (channelActionWindow && !channelActionWindow.isDestroyed()) {
    channelActionWindow.close();
    if (action === "subscribe") return;
  }
  const destinations = {
    channel: `https://www.twitch.tv/${channel}`,
    subscribe: `https://www.twitch.tv/subs/${channel}`,
    clip: `https://www.twitch.tv/${channel}/clip`,
  } as const;
  const subscriptionDrawer = action === "subscribe";
  const actionWindow = new BrowserWindow({
    parent: mainWindow,
    icon: applicationIcon,
    modal: !subscriptionDrawer,
    frame: !subscriptionDrawer,
    show: !subscriptionDrawer,
    focusable: true,
    skipTaskbar: subscriptionDrawer,
    resizable: !subscriptionDrawer,
    width: subscriptionDrawer ? 430 : 1040,
    height: subscriptionDrawer ? 700 : 760,
    minWidth: subscriptionDrawer ? undefined : 720,
    minHeight: subscriptionDrawer ? undefined : 560,
    title: action === "channel" ? `Follow ${channel} on Twitch` : `${action} ${channel} on Twitch`,
    autoHideMenuBar: true,
    backgroundColor: "#0e0e10",
    hasShadow: true,
    roundedCorners: true,
    thickFrame: !subscriptionDrawer,
    webPreferences: {
      partition: "persist:glint-twitch-playback",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  channelActionWindow = actionWindow;
  channelActionKind = action;
  if (subscriptionDrawer) sendChannelActionState(action, "loading");
  if (!subscriptionDrawer && nativeControlsWindow && !nativeControlsWindow.isDestroyed()) {
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
  actionWindow.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  actionWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.key === "Escape" && !actionWindow.isDestroyed()) actionWindow.close();
  });
  actionWindow.on("closed", () => {
    if (channelActionWindow === actionWindow) channelActionWindow = null;
    if (channelActionKind === action) channelActionKind = null;
    if (subscriptionDrawer) sendChannelActionState(action, "closed");
    if (activePlayerMode === "native" && nativeControlsVisible) applyNativeControlsBounds();
  });
  await actionWindow.loadURL(destinations[action]);
  if (subscriptionDrawer && !actionWindow.isDestroyed()) {
    await actionWindow.webContents.insertCSS(`
      html, body {
        overflow: hidden !important;
        background: #0e0e10 !important;
      }
      [data-a-target="top-nav-container"],
      nav[aria-label="Primary Navigation"] {
        display: none !important;
      }
      [data-a-target="sub-modal"] {
        position: fixed !important;
        z-index: 2147483647 !important;
        inset: 0 !important;
        width: 100% !important;
        min-width: 0 !important;
        max-width: none !important;
        height: 100% !important;
        max-height: none !important;
        margin: 0 !important;
        box-sizing: border-box !important;
        overflow: hidden !important;
        border: 1px solid #303038 !important;
        border-radius: 10px !important;
        background: #0e0e10 !important;
        box-shadow: 0 18px 55px #000b !important;
        transform: none !important;
      }
      [data-a-target="sub-modal"] .sub-modal__support-panel {
        height: 100% !important;
        min-height: 0 !important;
        overflow: hidden !important;
      }
    `);
    applySubscriptionDrawerBounds();
    const modalFound = await actionWindow.webContents
      .executeJavaScript(`
        new Promise((resolve) => {
          const find = () => document.querySelector('[data-a-target="sub-modal"]');
          if (find()) return resolve(true);
          const observer = new MutationObserver(() => {
            if (!find()) return;
            observer.disconnect();
            resolve(true);
          });
          observer.observe(document.documentElement, { childList: true, subtree: true });
          setTimeout(() => {
            observer.disconnect();
            resolve(Boolean(find()));
          }, 8000);
        })
      `)
      .catch(() => false);
    if (!actionWindow.isDestroyed()) {
      // Keep the frameless drawer hidden until Twitch's actual subscription
      // surface exists. This avoids flashing the underlying /subs page and its
      // navigation while React finishes rendering the modal.
      actionWindow.show();
      actionWindow.focus();
      actionWindow.moveTop();
      sendChannelActionState(action, "open");
      if (modalFound) {
        void actionWindow.webContents
          .executeJavaScript(`
            new Promise((resolve) => {
              const observer = new MutationObserver(() => {
                if (document.querySelector('[data-a-target="sub-modal"]')) return;
                observer.disconnect();
                resolve(true);
              });
              observer.observe(document.documentElement, { childList: true, subtree: true });
            })
          `)
          .then(() => {
            if (!actionWindow.isDestroyed()) actionWindow.close();
          })
          .catch(() => undefined);
      }
    }
  }
  await closed;
}

function applySubscriptionDrawerBounds(): void {
  if (
    channelActionKind !== "subscribe" ||
    !channelActionWindow ||
    channelActionWindow.isDestroyed() ||
    !mainWindow ||
    mainWindow.isDestroyed()
  ) {
    return;
  }
  const contentBounds = mainWindow.getContentBounds();
  const playerBounds = lastPlayerBounds;
  const availableWidth = playerBounds?.width ?? contentBounds.width;
  const width = Math.max(340, Math.min(440, Math.round(availableWidth * 0.42)));
  const availableHeight = playerBounds?.height ?? contentBounds.height - 122;
  // Twitch's subscription panel is designed as a compact, internally
  // scrollable drawer. Matching the entire player height leaves a large empty
  // region below channels with shorter benefit lists.
  const height = Math.max(480, Math.min(820, availableHeight));
  const right = playerBounds
    ? contentBounds.x + playerBounds.x + playerBounds.width
    : contentBounds.x + contentBounds.width;
  const y = playerBounds ? contentBounds.y + playerBounds.y : contentBounds.y + 122;
  channelActionWindow.setBounds({ x: right - width, y, width, height });
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

function destroyPlayer(invalidatePendingOpen = true): void {
  if (invalidatePendingOpen) playerOpenGeneration += 1;
  if (channelActionWindow && !channelActionWindow.isDestroyed()) channelActionWindow.close();
  channelActionWindow = null;
  channelActionKind = null;
  nativePlayer.destroy();
  textureNativePlayer.destroy();
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
    webPreferences: {
      preload: path.join(currentDirectory, "../preload/index.cjs"),
      partition: "persist:glint-twitch-playback",
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
  mainWindow.on("moved", () => {
    restoreDetachedNativeSurfaces();
    applySubscriptionDrawerBounds();
  });
  mainWindow.on("will-resize", suspendDetachedNativeSurfaces);
  mainWindow.on("resized", () => {
    restoreDetachedNativeSurfaces();
    applySubscriptionDrawerBounds();
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) await mainWindow.loadURL(rendererUrl);
  else {
    rendererServer ??= await startRendererServer(
      path.join(currentDirectory, "../../dist/renderer"),
    );
    await mainWindow.loadURL(`${rendererServer.origin}/index.html`);
  }
}

ipcMain.handle(
  "player:open",
  async (_event, input: unknown, requestedModeInput: unknown, requestedQualityInput: unknown) => {
  const channel = channelNameSchema.parse(input);
  const requestedMode = playerModeSchema.parse(requestedModeInput);
  const requestedQuality =
    requestedQualityInput === undefined ? "best" : nativeQualitySchema.parse(requestedQualityInput);
  const openGeneration = ++playerOpenGeneration;
  destroyPlayer(false);
  activeChannelName = channel;

  let mode = requestedMode;
  let nativeBackend: NativeRenderBackend | undefined;
  let fallbackReason: string | undefined;
  if (requestedMode === "native") {
    const useTextureBackend = preferencesService.get().experimentalTexturePlayer;
    const textureResult = useTextureBackend
      ? await textureNativePlayer.start(channel, requestedQuality)
      : null;
    if (openGeneration !== playerOpenGeneration || activeChannelName !== channel) {
      // A newer player request intentionally cancelled this startup. Its
      // cancellation is not a texture failure and must not trigger fallback.
      return { channel, mode: requestedMode };
    }
    const result =
      textureResult?.ok
        ? textureResult
        : nativePlayer.start(channel, requestedQuality);
    if (!result.ok) {
      mode = "official";
      fallbackReason =
        textureResult && !textureResult.ok
          ? `${textureResult.reason} Window-hosted Native also failed: ${result.reason}`
          : result.reason;
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
  twitchChatService.connect(channel);

  return { channel, mode, nativeBackend, fallbackReason };
  },
);

ipcMain.handle("player:close", () => destroyPlayer());

ipcMain.on("player:set-bounds", (_event, input: unknown) => {
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
  applySubscriptionDrawerBounds();
});

ipcMain.on("player:set-chat-bounds", (_event, input: unknown) => {
  const result = playerBoundsSchema.safeParse(input);
  if (!result.success) return;
  lastChatBounds = result.data;
  if (chatView) applyChatBounds();
  if (nativeEmotePickerOpen) applyNativeControlsBounds();
});

ipcMain.on("player:set-chat-visible", (_event, visible: unknown) => {
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

ipcMain.on("player:set-chat-presentation", (_event, input: unknown) => {
  const result = chatPresentationSchema.safeParse(input);
  if (result.success) setChatPresentation(result.data);
});

ipcMain.handle("native-player:get-availability", () => {
  const availability = nativePlayer.getAvailability();
  const textureAvailability = textureNativePlayer.getAvailability();
  return {
    ...availability,
    textureAvailable: textureAvailability.available,
    textureReason: textureAvailability.reason,
  };
});

ipcMain.handle("native-player:get-qualities", (_event, input: unknown) => {
  const channel = channelNameSchema.parse(input);
  return nativePlayer.getQualities(channel);
});

ipcMain.handle(
  "native-player:set-quality",
  async (_event, channelInput: unknown, qualityInput: unknown) => {
    if (activePlayerMode !== "native") return;
    const channel = channelNameSchema.parse(channelInput);
    const quality = nativeQualitySchema.parse(qualityInput);
    const result =
      activeNativeBackend === "texture"
        ? await textureNativePlayer.start(channel, quality)
        : nativePlayer.start(channel, quality);
    if (!result.ok) throw new Error(result.reason);
  },
);

ipcMain.on("native-player:control", (_event, input: unknown) => {
  const result = nativePlayerCommandSchema.safeParse(input);
  if (!result.success || activePlayerMode !== "native") return;
  if (activeNativeBackend === "texture") textureNativePlayer.control(result.data);
  else nativePlayer.control(result.data);
});

ipcMain.on("native-controls:set-visible", (_event, input: unknown) => {
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

ipcMain.on("native-controls:set-expanded", (_event, input: unknown) => {
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

ipcMain.on("native-controls:set-emote-picker", (_event, input: unknown) => {
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
ipcMain.on("player:set-modal-open", (_event, input: unknown) => {
  if (typeof input !== "boolean" || activePlayerMode !== "native") return;
  if (input) suspendDetachedNativeSurfaces();
  else restoreDetachedNativeSurfaces();
});

ipcMain.on("native-controls:set-emote-picker-bounds", (_event, input: unknown) => {
  if (input === null) {
    nativeEmotePickerBounds = null;
    return;
  }
  const result = playerBoundsSchema.safeParse(input);
  if (!result.success) return;
  nativeEmotePickerBounds = result.data;
  if (nativeEmotePickerOpen) applyNativeControlsBounds();
});

ipcMain.on("native-controls:emote-selected", (_event, input: unknown) => {
  const result = outgoingChatMessageSchema.safeParse(input);
  if (!result.success) return;
  nativeEmotePickerOpen = false;
  nativeEmotePickerBounds = null;
  sendToWindow(mainWindow, "native-controls:emote-selected", result.data);
  sendToWindow(mainWindow, "native-controls:emote-picker", false);
  sendToWindow(nativeControlsWindow, "native-controls:emote-picker", false);
  applyNativeControlsBounds();
});

ipcMain.on("native-controls:ready", (event) => {
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

ipcMain.on("native-controls:set-context", (_event, input: unknown) => {
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

ipcMain.on("native-controls:action", (_event, input: unknown) => {
  const result = nativeControlActionSchema.safeParse(input);
  if (!result.success) return;
  sendToWindow(mainWindow, "native-controls:action", result.data);
});

ipcMain.handle("window:set-fullscreen", (_event, fullscreen: unknown) => {
  if (!mainWindow || typeof fullscreen !== "boolean") return false;
  mainWindow.setFullScreen(fullscreen);
  return mainWindow.isFullScreen();
});

ipcMain.handle("system:open-external", async (_event, input: unknown) => {
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

ipcMain.handle("channel:open-action", async (_event, rawChannel: unknown, rawAction: unknown) => {
  const channel = channelNameSchema.parse(rawChannel);
  const action = channelActionSchema.parse(rawAction);
  await openChannelActionWindow(channel, action);
});

ipcMain.handle("twitch:get-auth-state", () => twitchService.getAuthState());
ipcMain.handle("twitch:begin-sign-in", () => twitchService.beginSignIn());
ipcMain.handle("twitch:complete-sign-in", () => twitchService.completeSignIn());
ipcMain.handle("twitch:cancel-sign-in", () => twitchService.cancelSignIn());
ipcMain.handle("twitch:sign-out", () => twitchService.signOut());
ipcMain.handle("twitch-playback:get-state", () => playbackSessionService.getState());
ipcMain.handle("twitch-playback:link", () => playbackSessionService.link());
ipcMain.handle("twitch-playback:unlink", () => playbackSessionService.unlink());
ipcMain.handle("twitch:get-followed-channels", () => twitchService.getFollowedChannels());
ipcMain.handle(
  "twitch:get-browse-categories",
  (_event, rawQuery: unknown, rawAfter: unknown) => {
    const query = typeof rawQuery === "string" ? rawQuery.slice(0, 100) : "";
    const after = typeof rawAfter === "string" ? rawAfter.slice(0, 500) : undefined;
    return twitchService.getBrowseCategories(query, after);
  },
);
ipcMain.handle(
  "twitch:get-category-streams",
  (_event, rawGameId: unknown, rawAfter: unknown) => {
    if (typeof rawGameId !== "string" || !/^\d+$/.test(rawGameId)) {
      throw new Error("Invalid Twitch category.");
    }
    const after = typeof rawAfter === "string" ? rawAfter.slice(0, 500) : undefined;
    return twitchService.getCategoryStreams(rawGameId, after);
  },
);
ipcMain.handle("twitch:search", (_event, rawQuery: unknown) => {
  if (typeof rawQuery !== "string") throw new Error("Search text must be a string.");
  return twitchService.search(rawQuery.slice(0, 100));
});
ipcMain.handle("twitch:get-stream-metadata", (_event, rawChannel: unknown) =>
  twitchService.getStreamMetadata(channelNameSchema.parse(rawChannel)),
);
ipcMain.handle(
  "twitch:get-chat-user-profile",
  (_event, rawChannel: unknown, rawLogin: unknown) =>
    twitchService.getChatUserProfile(
      channelNameSchema.parse(rawChannel),
      channelNameSchema.parse(rawLogin),
    ),
);
ipcMain.handle("twitch:create-clip", (_event, rawChannel: unknown) =>
  twitchService.createClip(channelNameSchema.parse(rawChannel)),
);
ipcMain.handle("twitch:open-subscription", (_event, rawChannel: unknown) =>
  twitchService.openSubscription(channelNameSchema.parse(rawChannel)),
);
ipcMain.handle("twitch:open-channel", (_event, rawChannel: unknown) =>
  twitchService.openChannel(channelNameSchema.parse(rawChannel)),
);
ipcMain.handle("emotes:7tv-global", () => sevenTvService.getGlobal());
ipcMain.handle("emotes:7tv-channel", (_event, broadcasterId: unknown) => {
  if (typeof broadcasterId !== "string") throw new Error("Broadcaster ID must be text.");
  return sevenTvService.getChannel(broadcasterId);
});
ipcMain.handle("emotes:ffz-global", () => thirdPartyEmoteService.getFfzGlobal());
ipcMain.handle("emotes:ffz-channel", (_event, broadcasterId: unknown) => {
  if (typeof broadcasterId !== "string") throw new Error("Broadcaster ID must be text.");
  return thirdPartyEmoteService.getFfzChannel(broadcasterId);
});
ipcMain.handle("emotes:bttv-global", () => thirdPartyEmoteService.getBttvGlobal());
ipcMain.handle("emotes:bttv-channel", (_event, broadcasterId: unknown) => {
  if (typeof broadcasterId !== "string") throw new Error("Broadcaster ID must be text.");
  return thirdPartyEmoteService.getBttvChannel(broadcasterId);
});
ipcMain.handle("emotes:clear-cache", async () => {
  await Promise.all([sevenTvService.clear(), thirdPartyEmoteService.clear()]);
});
ipcMain.handle("chat:send", (
  _event,
  rawChannel: unknown,
  rawMessage: unknown,
  rawReplyParentMessageId: unknown,
) => {
  const channel = channelNameSchema.parse(rawChannel);
  const message = outgoingChatMessageSchema.parse(rawMessage);
  const replyParentMessageId =
    rawReplyParentMessageId === undefined
      ? undefined
      : chatReplyParentIdSchema.parse(rawReplyParentMessageId);
  return twitchService.sendChatMessage(channel, message, replyParentMessageId);
});
ipcMain.handle("chat:get-assets", (_event, rawChannel: unknown) =>
  twitchService.getChatAssets(channelNameSchema.parse(rawChannel)),
);
ipcMain.on("chat:set-history-limit", (_event, rawLimit: unknown) => {
  const result = chatHistoryLimitSchema.safeParse(rawLimit);
  if (result.success) twitchChatService.setHistoryLimit(result.data);
});
ipcMain.handle("updates:get-status", () => updateService.getStatus());
ipcMain.handle("updates:check", () => updateService.check());
ipcMain.on("updates:install", () => updateService.install());
ipcMain.handle("preferences:get-or-migrate", (_event, legacyPreferences: unknown) =>
  preferencesService.getOrMigrate(legacyPreferences),
);
ipcMain.handle("preferences:update", async (_event, patch: unknown) => {
  const preferences = await preferencesService.update(patch);
  sendToWindow(mainWindow, "preferences:changed", preferences);
  sendToWindow(nativeControlsWindow, "preferences:changed", preferences);
  return preferences;
});

app.whenReady().then(async () => {
  app.setAppUserModelId("app.violetwire.viewer");
  powerMonitor.on("resume", () => textureNativePlayer.recoverGraphics());
  powerMonitor.on("unlock-screen", () => textureNativePlayer.recoverGraphics());
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
