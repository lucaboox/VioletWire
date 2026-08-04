import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  screen,
  session,
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
  channelNameSchema,
  nativeControlActionSchema,
  nativeHlsStateReportSchema,
  nativeQualitySchema,
  nativePlayerCommandSchema,
  playerModeSchema,
  MAX_MULTISTREAM_TILES,
  type NativePlayerState,
  type PlayerMode,
} from "../shared/player";
import { z } from "zod";
import { twitchChatColorInputSchema } from "../shared/twitch";
import { channelKeySchema, parseChannelKey, type Platform } from "../shared/platform";
import { HlsNativePlayer } from "./hls-native-player";
import { StreamPlaybackResolver } from "./stream-playback-resolver";
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
import {
  chatHistoryLimitSchema,
  chatReplyParentIdSchema,
  outgoingChatMessageSchema,
  type TwitchChatAssets,
} from "../shared/chat";
import { PreferencesService } from "./preferences-service";
import {
  APP_UI_PARTITION,
  TWITCH_WEBSITE_PARTITION,
} from "./session-partitions";
import { HLS_MEDIA_SCHEME, hlsMediaProtocol } from "./hls-media-protocol";
import { APP_ORIGIN, appProtocolPrivileges, registerAppProtocol } from "./app-protocol";

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
protocol.registerSchemesAsPrivileged([
  appProtocolPrivileges,
  {
    scheme: HLS_MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
const applicationIcon = app.isPackaged
  ? path.join(process.resourcesPath, "icon.png")
  : path.join(currentDirectory, "../../build/icon.png");
let mainWindow: BrowserWindow | null = null;
let channelActionWindow: BrowserWindow | null = null;
let subscriptionWindow: BrowserWindow | null = null;
// Must match CHAT_WINDOW_NAME in the renderer’s use-chat-window module.
const CHAT_WINDOW_NAME = "violetwire-chat";
let chatPopoutWindow: BrowserWindow | null = null;
let activePlayerMode: PlayerMode | null = null;
let activeChannelName: string | null = null;
let playerOpenGeneration = 0;
let appProtocolReady = false;
let trustedRendererOrigin: string | null = null;
let latestNativePlayerState: NativePlayerState | null = null;

type ThumbarGlyph = "play" | "pause" | "speaker" | "speaker-muted";

// Antialiased 32px PNGs rendered from the same simple media glyphs used in the
// React controls. A raw 16px bitmap looked jagged in Windows' thumbnail
// toolbar, especially when its preview crossed monitors with different DPI.
const thumbarGlyphPng: Record<ThumbarGlyph, string> = {
  play:
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAEPSURBVFhH7ZS9DcIwEIUTfiToGICKDRiBDRiAjp4JmAAxAnvABjSUUCJRIlFQI0UJn+EiQDrInx0af9Ip5uy893RGCTweTx6SJAll+R/iOO5Sc4IMpFUvGDcIcKauURTNzG/ZqgcJsOf5gPWWGsm2e/A0AQ5P+xf0VlRfjrkDLzWAgf7F+bUY8W8BUth3dy3oZwZI4Zz9a0E3dwADZ+1eixEqEuCNHTWmmiJVDgTKBjDTWPJoi1Q5ECgcgPNraigS1UCvyJ/wyP1P5FU7oJsZgP0btWDZk9fsgejPAOzZG7cGHmoAevbHrYHXRwDW7satgVGI4UnM3Y5bA98OphtqKq16IUCLqvYx8Xg8KkFwByXmot5AxK36AAAAAElFTkSuQmCC",
  pause:
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAACmSURBVFhH7ZZBCsJAFEMHXXiRrrRe3qtIxVUvUpwx/0+wFIT+78pFHoShmRDSrlqEEBFaawfoyNPFqw3RXAorqbXeoAc0UXdoYMSJ5tKweMa5Ad6VEQdWKJcGHVY89boOnl/QhREHdiiXBj0aoAEaoAEaoAF/MeDZK1fgjYw4sEK5NOiwYvuxMOyNTAv07Qvs5n4CJQM0Whl1hk68/gAvlBNCrJTyBrKL5R7QmxMSAAAAAElFTkSuQmCC",
  speaker:
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAIiSURBVFhH7ZS/axRRFIU3u0YQbERJF9NIDEkaFQI2aVOLEPAf0GhjIQFRZLGxFCs7OxuTQtDGhGChIGglaCSkEG0sRPKjS2R39Tt3DmF3Z3bd2ZAUMh9c3nvnnnvnZudNSgUFBf8FjUbjEnHWx8OFB8//AdbzlrqC7xrxlrhpqX9o8kgPF+zHLXcE2yl8taQias45lQ9qj1P8PGkTjerEhNMBcqVWq82h32J/VBr7Y/V6fT2KgPOzMOeBohHig3sEnLMGuJpkI//QsupvWJb+y3Ia8mWi4lUxQMFF4jv7FtBSA3DWXx6w32E5bf0k+61IsIa5HRJljC+IL8Qq8Zn4ROwmda2gZ/0Cet8/E0d4rjulIVasbVhqhZwG+CpTL+BNDSB4309tkeeJZQ0Ql5e16wCrMvUC3swBuIR3bJHnlWUNcNfawQ6A1nwPXltW/9vWug6wJlMv4O00QPP/ib1Pjv0Da10H0KUTah6hoiycb7+E0SNxhOeeUxpg0Vr2AILkGWKSmCDGHfHu2kFPDcD5stMB5ynpbAfZf7O2GeY8UHSF0He9B+fUAHwB951W/g3LgHT2M4ka+naY80LhNPHDfTIH4DxMrBDvsIxJY9VrWY4iYP8+zP1AsV7RRzcSqUvYDp6heLLhM511qj/ocYKfeknNaD5puSPYjuBfwPubeFmtVstO9Q9NKzR7zHrB0j/BP4p//w9vhoaD3hYUFOSgVPoL9Y71fZLSQlIAAAAASUVORK5CYII=",
  "speaker-muted":
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAJRSURBVFhH7ZY7b9NQGIajVrAzsbGQcullIUvbKCTR8aWXdCAlVan6NxBCDJ26FiYGpo7MbMywIDEgoSJQBbmQuFzUODfXpY398X7OUWmoCUW1I4Y80isfndh+H8fSOY4MGPBfQrnceVNR7tm6/rASj1+S0/2jKsR9WlggymSopaqFcjp9Vf7UHyDwhObnaVcIotlZlij1knBd9xYSnGRdUUaaqlpxZ2Y8CbeHBIrvEsDxhpwKhh1VHd/TtBMS33X9SAKlj7icwXhUTgfHTjJ5QsJMJouNjY0ECp/Kbi53kDF5WbBUYrFrlhCltqbRrqLQXipFzeVlItOU9SEJ4L5DyDCPvwgx0UqlChbKTYjU43GqLy2RUy6HI8DluOEz5B2yhbw62N42WiitTk56Enys5XLkGkZoAp+8xztGO5+nWjbbJWGtrNBBscgCI/Lys4MuFtjq1HbTLhS6JGrT02SvrrqN9fWEvPzsoOePAkyXhKqSnU5TS4h8YCsmOljgfafOn+MSVUj0Wqz+GdyfBd4iDL9fL53qX4QqgcIoMo6MIaMyD2T3ESxRX1ykRiJBVawTgUr4AYk7yL7s9zjM5/fNTMb+gdXyb3tHIEDgJmLIfl4Hmtbm5u361NTH02xggYBSfkVvpANLXPwajV7228BCk0DvBcdxnkuBCZ7z28DClhhG+WMcY3LKVwLfF6VvQlyRpwQPBM7JocfvEjQ3R/jOfElra0PylPBhCUtVDS73BIT4/DoW6xINHUNRrtua9uJQ1z/gH8jK6f7T9ycfcDoikZ9LxubWak28NwAAAABJRU5ErkJggg==",
};

function createThumbarGlyph(kind: ThumbarGlyph) {
  const source = nativeImage.createFromDataURL(
    `data:image/png;base64,${thumbarGlyphPng[kind]}`,
  );
  const icon = source.resize({ width: 16, height: 16, quality: "best" });
  icon.addRepresentation({
    buffer: source.toPNG(),
    width: 32,
    height: 32,
    scaleFactor: 2,
  });
  return icon;
}

const thumbarIcons =
  process.platform === "win32"
    ? {
        play: createThumbarGlyph("play"),
        pause: createThumbarGlyph("pause"),
        speaker: createThumbarGlyph("speaker"),
        speakerMuted: createThumbarGlyph("speaker-muted"),
      }
    : null;

function controlActiveNativePlayer(command: Parameters<HlsNativePlayer["control"]>[0]): void {
  if (activePlayerMode !== "native") return;
  hlsNativePlayer.control(command);
}

function updateThumbnailToolbar(state = latestNativePlayerState): void {
  if (process.platform !== "win32" || !mainWindow || mainWindow.isDestroyed()) return;
  if (
    !thumbarIcons ||
    activePlayerMode !== "native" ||
    !state ||
    state.status !== "playing"
  ) {
    mainWindow.setThumbarButtons([]);
    return;
  }

  mainWindow.setThumbarButtons([
    {
      icon: state.paused ? thumbarIcons.play : thumbarIcons.pause,
      tooltip: state.paused ? "Play and return to live" : "Pause",
      click: () =>
        controlActiveNativePlayer({ command: state.paused ? "go-live" : "toggle-pause" }),
    },
    {
      icon: state.muted ? thumbarIcons.speakerMuted : thumbarIcons.speaker,
      tooltip: state.muted ? "Unmute" : "Mute",
      click: () => controlActiveNativePlayer({ command: "toggle-mute" }),
    },
  ]);
}

function publishNativePlayerState(state: NativePlayerState): void {
  latestNativePlayerState = state;
  sendToWindow(mainWindow, "native-player:state", state);
  updateThumbnailToolbar(state);
}
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


/**
 * Windows that render chat. The main window always does, and the pop-out
 * window joins while it is open. Both have to see the same stream of events,
 * because a message delivered to only one of them is a message the reader
 * never sees.
 */
const chatSurfaces = new Set<BrowserWindow>();

function sendToChatSurfaces(channel: string, ...args: unknown[]): void {
  sendToWindow(mainWindow, channel, ...args);
  for (const surface of chatSurfaces) {
    if (surface === mainWindow) continue;
    sendToWindow(surface, channel, ...args);
  }
}
const updateService = new UpdateService(
  () => mainWindow,
  (status) => sendToWindow(mainWindow, "updates:status", status),
);
const githubReleaseNotesService = new GitHubReleaseNotesService();

function isTrustedRendererUrl(rawUrl: string): boolean {
  if (!trustedRendererOrigin) return false;
  try {
    const url = new URL(rawUrl);
    if (url.origin !== trustedRendererOrigin) return false;
    return url.pathname === "/" || url.pathname === "/index.html";
  } catch {
    return false;
  }
}

function isTrustedIpcSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  if (mainWindow && event.sender === mainWindow.webContents) {
    return isTrustedRendererUrl(frame.url);
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


/**
 * Stands the chat window against the side of a display, filling its working
 * height. This is only a position and a size — the window stays an ordinary
 * one, so nothing is tiled and no other window is resized to make room, and
 * the working area already excludes the taskbar. The side chosen is the one
 * the main window sits furthest from, so chat does not land on top of it.
 */
function standChatWindowAt(
  window: BrowserWindow,
  workArea: Rectangle,
  side: "left" | "right",
): void {
  // Measured from the display being moved to, never from the window. A window
  // reports its size in the units of the display it is currently on, so on a
  // set of screens at different scale factors carrying that number across gives
  // a window of the wrong size.
  const width = Math.max(320, Math.min(560, Math.round(workArea.width / 4)));
  // Windows keeps a band of resize grab area outside the visible frame, on the
  // sides and the bottom but not the top, and a window is positioned by the
  // outside of that. Placed on the work area exactly, the window therefore
  // looks inset on three sides. The band is the distance from the window to
  // the content inside it, so the placement grows by that much to sit flush.
  const frame = window.getBounds();
  const content = window.getContentBounds();
  const edge = Math.max(0, content.x - frame.x);
  const bounds = {
    x: (side === "right" ? workArea.x + workArea.width - width : workArea.x) - edge,
    y: workArea.y,
    width: width + edge * 2,
    height: workArea.height + edge,
  };
  if (window.isMaximized()) window.unmaximize();
  if (window.isMinimized()) window.restore();
  window.setBounds(bounds);
  // Windows rescales a window as it crosses onto a display with a different
  // scale factor, which undoes part of the move that put it there. Asking again
  // once that has happened lands it where it was actually sent.
  setTimeout(() => {
    if (window.isDestroyed()) return;
    window.setBounds(bounds);
  }, 150);
}

function standChatWindowAtDisplayEdge(window: BrowserWindow): void {
  const anchor =
    mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : window.getBounds();
  const workArea = screen.getDisplayMatching(anchor).workArea;
  const anchorCentre = anchor.x + anchor.width / 2;
  const side = anchorCentre <= workArea.x + workArea.width / 2 ? "right" : "left";
  standChatWindowAt(window, workArea, side);
}
function lockLocalRendererNavigation(
  window: BrowserWindow,
): void {
  window.webContents.setWindowOpenHandler(({ frameName, url }) => {
    // Chat renders itself into a window of its own. That window is opened blank
    // and never navigated — the renderer puts the panel's own nodes into it —
    // so anything carrying a destination is still refused.
    if (frameName === CHAT_WINDOW_NAME && (url === "" || url === "about:blank")) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          title: "VioletWire Chat",
          icon: applicationIcon,
          backgroundColor: "#0e0e10",
          minWidth: 300,
          minHeight: 320,
          autoHideMenuBar: true,
        },
      };
    }
    return { action: "deny" };
  });
  window.webContents.on("did-create-window", (created, { frameName }) => {
    if (frameName !== CHAT_WINDOW_NAME) return;
    chatPopoutWindow = created;
    standChatWindowAtDisplayEdge(created);
    created.on("closed", () => {
      if (chatPopoutWindow === created) chatPopoutWindow = null;
    });
  });
  const blockUnexpectedNavigation = (event: Electron.Event, url: string) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  };
  window.webContents.on("will-navigate", blockUnexpectedNavigation);
  window.webContents.on("will-redirect", blockUnexpectedNavigation);
}

const twitchChatService = new TwitchChatService(
  (message) => {
    sendToChatSurfaces("chat:message", message);
  },
  (state) => {
    sendToChatSurfaces("chat:state", state);
  },
  (restrictions) => {
    sendToChatSurfaces("chat:restrictions", restrictions);
  },
);
const kickService = new KickService();
// Kick chat reuses the same renderer channels as Twitch's, so the panel does
// not care which service a message came from.
const kickChatService = new KickChatService(
  () => kickService,
  (message) => {
    sendToChatSurfaces("chat:message", message);
  },
  (state) => {
    sendToChatSurfaces("chat:state", state);
  },
  (restrictions) => {
    sendToChatSurfaces("chat:restrictions", restrictions);
  },
);
const streamPlaybackResolver = new StreamPlaybackResolver(
  () => playbackSessionService.getToken(),
  () => kickService.getStreamlinkCookie(),
);
const multiStreamManager = new MultiStreamManager(
  () => mainWindow,
  () => playbackSessionService.getToken(),
  () => preferencesService.get().playerVolume,
  () => preferencesService.get().playbackLatencyMode,
  () => kickService.getStreamlinkCookie(),
  () => trustedRendererOrigin,
  (tile) => sendToWindow(mainWindow, "native-multi:tile-state", tile),
  (id) => sendToWindow(mainWindow, "native-multi:tile-removed", id),
  hlsMediaProtocol,
);
const multiChatService = new MultiChatService(
  (channel, message) =>
    sendToChatSurfaces("native-multi:chat-message", { channel, message }),
  (channel, state) => sendToChatSurfaces("native-multi:chat-state", { channel, state }),
  () => kickService,
);
const twitchService = new TwitchService();
const linkPreviewService = new LinkPreviewService(twitchService, kickService);
const preferencesService = new PreferencesService();
const hlsNativePlayer = new HlsNativePlayer(
  () => mainWindow,
  () => trustedRendererOrigin,
  (channel, quality) => streamPlaybackResolver.resolve(channel, quality),
  () => preferencesService.get().playerVolume,
  () => preferencesService.get().playbackLatencyMode,
  publishNativePlayerState,
  () => streamPlaybackResolver.cancelActiveResolution(),
  "main",
  hlsMediaProtocol,
);
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
  // Center over the app's current window rather than letting Windows drop the
  // modal on the primary monitor. Clamp to the work area of the display the app
  // is on so a tall modal is not pushed off-screen.
  const parentBounds = mainWindow.getBounds();
  const workArea = screen.getDisplayMatching(parentBounds).workArea;
  const width = 560;
  const height = Math.min(940, workArea.height - 40);
  const x = Math.round(
    Math.max(workArea.x, Math.min(
      parentBounds.x + (parentBounds.width - width) / 2,
      workArea.x + workArea.width - width,
    )),
  );
  const y = Math.round(
    Math.max(workArea.y, Math.min(
      parentBounds.y + (parentBounds.height - height) / 2,
      workArea.y + workArea.height - height,
    )),
  );
  const win = new BrowserWindow({
    parent: mainWindow,
    icon: applicationIcon,
    modal: true,
    frame: false,
    show: false,
    resizable: true,
    x,
    y,
    width,
    height,
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
  });

  await win.webContents.loadURL(subscriptionShellHtml(title, headerHeight));
  if (win.isDestroyed()) return;
  void page.loadURL(service.url);
  win.show();
  win.focus();
}

function destroyPlayer(invalidatePendingOpen = true): void {
  if (invalidatePendingOpen) playerOpenGeneration += 1;
  if (channelActionWindow && !channelActionWindow.isDestroyed()) channelActionWindow.close();
  channelActionWindow = null;
  if (subscriptionWindow && !subscriptionWindow.isDestroyed()) subscriptionWindow.close();
  subscriptionWindow = null;
  hlsNativePlayer.destroy();
  twitchChatService.disconnect();
  activePlayerMode = null;
  activeChannelName = null;
  latestNativePlayerState = null;
  updateThumbnailToolbar();
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

function restoredMainWindowBounds(): Rectangle | null {
  const preferences = preferencesService.get();
  if (preferences.windowX === null || preferences.windowY === null) return null;

  const saved = {
    x: preferences.windowX,
    y: preferences.windowY,
    width: preferences.windowWidth,
    height: preferences.windowHeight,
  };
  const displays = screen.getAllDisplays();
  const matchingDisplay = displays
    .map((display) => {
      const workArea = display.workArea;
      const overlapWidth = Math.max(
        0,
        Math.min(saved.x + saved.width, workArea.x + workArea.width) -
          Math.max(saved.x, workArea.x),
      );
      const overlapHeight = Math.max(
        0,
        Math.min(saved.y + saved.height, workArea.y + workArea.height) -
          Math.max(saved.y, workArea.y),
      );
      return { display, overlap: overlapWidth * overlapHeight };
    })
    .sort((left, right) => right.overlap - left.overlap)[0];

  // Do not resurrect a window on a monitor that was disconnected. Let Windows
  // choose a visible location instead.
  if (!matchingDisplay || matchingDisplay.overlap === 0) return null;
  const workArea = matchingDisplay.display.workArea;
  const width = Math.min(saved.width, workArea.width);
  const height = Math.min(saved.height, workArea.height);
  return {
    x: Math.min(Math.max(saved.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(saved.y, workArea.y), workArea.y + workArea.height - height),
    width,
    height,
  };
}


/** The URL the trusted renderer is served from, with an optional view. */
async function loadRendererView(window: BrowserWindow, view?: string): Promise<void> {
  const query = view ? `?view=${encodeURIComponent(view)}` : "";
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    trustedRendererOrigin = new URL(rendererUrl).origin;
    lockLocalRendererNavigation(window);
    await window.loadURL(`${rendererUrl}${query}`);
    return;
  }
  if (!appProtocolReady) {
    registerAppProtocol(path.join(currentDirectory, "../../dist/renderer"));
    appProtocolReady = true;
  }
  trustedRendererOrigin = APP_ORIGIN;
  lockLocalRendererNavigation(window);
  await window.loadURL(`${APP_ORIGIN}/index.html${query}`);
}

async function createWindow(): Promise<void> {
  const savedBounds = restoredMainWindowBounds();
  const preferences = preferencesService.get();
  mainWindow = new BrowserWindow({
    width: savedBounds?.width ?? preferences.windowWidth,
    height: savedBounds?.height ?? preferences.windowHeight,
    ...(savedBounds ? { x: savedBounds.x, y: savedBounds.y } : {}),
    // This is measured in device-independent pixels, so the usable minimum
    // remains visually consistent across Windows display scaling levels.
    minWidth: 1180,
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
  let windowStateTimer: NodeJS.Timeout | null = null;
  const persistWindowState = (immediate = false) => {
    if (windowStateTimer) clearTimeout(windowStateTimer);
    const save = () => {
      if (createdWindow.isDestroyed()) return;
      const bounds = createdWindow.getNormalBounds();
      void preferencesService
        .update({
          windowX: bounds.x,
          windowY: bounds.y,
          windowWidth: bounds.width,
          windowHeight: bounds.height,
          windowMaximized: createdWindow.isMaximized(),
        })
        .catch(() => undefined);
    };
    if (immediate) save();
    else windowStateTimer = setTimeout(save, 300);
  };
  if (preferences.windowMaximized) createdWindow.maximize();
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

  mainWindow.on("close", () => persistWindowState(true));
  mainWindow.on("closed", () => {
    if (windowStateTimer) clearTimeout(windowStateTimer);
    destroyPlayer();
    mainWindow = null;
  });
  mainWindow.on("moved", () => {
    persistWindowState();
    updateThumbnailToolbar();
  });
  mainWindow.on("resized", () => {
    persistWindowState();
  });
  mainWindow.on("maximize", () => persistWindowState(true));
  mainWindow.on("unmaximize", () => persistWindowState(true));
  mainWindow.on("focus", () => updateThumbnailToolbar());

  await loadRendererView(mainWindow);
}







const chatWindowPlacementSchema = z.object({
  displayId: z.number(),
  side: z.enum(["left", "right"]),
});

handleTrusted("chat-window:get-displays", () => {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display) => ({
    id: display.id,
    primary: display.id === primaryId,
    bounds: display.bounds,
    workArea: display.workArea,
  }));
});

handleTrusted("chat-window:place", (_event, input: unknown) => {
  const { displayId, side } = chatWindowPlacementSchema.parse(input);
  const window = chatPopoutWindow;
  if (!window || window.isDestroyed()) return;
  const display = screen.getAllDisplays().find((candidate) => candidate.id === displayId);
  if (!display) return;
  standChatWindowAt(window, display.workArea, side);
});

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
  destroyPlayer(false);
  activeChannelName = channel;

  let fallbackReason: string | undefined;
  if (requestedMode === "native") {
    const nativeResult = await hlsNativePlayer.start(channel, requestedQuality, {
      kind: "channel",
      detail: channel,
    });
    if (openGeneration !== playerOpenGeneration || activeChannelName !== channel) {
      // A newer request intentionally cancelled this startup.
      return { channel, mode: requestedMode };
    }
    if (!nativeResult.ok) fallbackReason = nativeResult.reason;
  }

  activePlayerMode = requestedMode;
  latestNativePlayerState =
    requestedMode === "native" ? hlsNativePlayer.getState() : null;
  updateThumbnailToolbar();

  // Each service has its own chat transport, and only one is ever live.
  const chatTarget = parseChannelKey(channel);
  if (chatTarget.platform === "kick") {
    twitchChatService.disconnect();
    void kickChatService.connect(chatTarget.login);
  } else {
    kickChatService.disconnect();
    twitchChatService.connect(channel);
  }

  return { channel, mode: requestedMode, fallbackReason };
  },
);

handleTrusted("player:close", () => destroyPlayer());

handleTrusted("native-player:get-availability", () => streamPlaybackResolver.getAvailability());

handleTrusted("native-player:get-qualities", (_event, input: unknown) => {
  const channel = channelKeySchema.parse(input);
  return streamPlaybackResolver.getQualities(channel);
});

handleTrusted(
  "native-player:set-quality",
  async (_event, channelInput: unknown, qualityInput: unknown) => {
    if (activePlayerMode !== "native") return;
    const channel = channelKeySchema.parse(channelInput);
    const quality = nativeQualitySchema.parse(qualityInput);
    const result = await hlsNativePlayer.start(channel, quality, {
      kind: "quality",
      detail: quality,
    });
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

handleTrusted("native-player:stats", () =>
  activePlayerMode === "native" ? hlsNativePlayer.getStats() : null,
);
onTrusted("native-player:control", (_event, input: unknown) => {
  const result = nativePlayerCommandSchema.safeParse(input);
  if (!result.success || activePlayerMode !== "native") return;
  if (result.data.command === "set-volume") persistPlayerVolume(result.data.value);
  hlsNativePlayer.control(result.data);
});
onTrusted("native-hls:state", (_event, input: unknown) => {
  const result = nativeHlsStateReportSchema.safeParse(input);
  if (!result.success) return;
  if (
    result.data.target === "main" &&
    activePlayerMode === "native"
  ) {
    hlsNativePlayer.report(result.data);
  } else if (result.data.target.startsWith("multi-") && multiStreamManager.isActive()) {
    multiStreamManager.reportHlsState(result.data);
  }
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
  // Multistream replaces the single full-window player; tear it down before
  // the tile sessions start.
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
  // skips the Streamlink round trip.
  const preferences = preferencesService.get();
  if (preferences.preferredPlayerMode !== "native") return;
  streamPlaybackResolver.preresolve(result.data);
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
  // to finish.
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
handleTrusted("twitch:get-chat-color", () => twitchService.getChatColor());
handleTrusted("twitch:update-chat-color", (_event, rawColor: unknown) =>
  twitchService.updateChatColor(twitchChatColorInputSchema.parse(rawColor)),
);
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
handleTrusted("twitch:get-stream-metadata", (_event, rawChannel: unknown) => {
  // A non-Twitch channel (e.g. a Kick multistream tile) has no Helix metadata;
  // answer null rather than throwing a ZodError up through the handler.
  const parsed = channelNameSchema.safeParse(rawChannel);
  return parsed.success ? twitchService.getStreamMetadata(parsed.data) : null;
});
handleTrusted(
  "twitch:get-chat-user-profile",
  (_event, rawChannel: unknown, rawLogin: unknown) =>
    twitchService.getChatUserProfile(
      channelNameSchema.parse(rawChannel),
      channelNameSchema.parse(rawLogin),
    ),
);
handleTrusted("twitch:get-pinned-chat-message", (_event, rawBroadcasterId: unknown) => {
  const broadcasterId = z
    .string()
    .regex(/^\d+$/)
    .max(32)
    .parse(rawBroadcasterId);
  return twitchService.getPinnedChatMessage(broadcasterId);
});
handleTrusted("kick:get-pinned-chat-message", (_event, rawChannelId: unknown) => {
  const channelId = z
    .string()
    .regex(/^\d+$/)
    .max(32)
    .parse(rawChannelId);
  return kickService.getPinnedChatMessage(channelId);
});

handleTrusted(
  "kick:get-chat-user-profile",
  (_event, rawChannel: unknown, rawLogin: unknown) => {
    const channel = z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_-]{1,32}$/)
      .parse(rawChannel);
    const login = z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_-]{1,32}$/)
      .parse(rawLogin);
    return kickService.getChatUserProfile(channel, login);
  },
);
handleTrusted("kick:get-chat-color", () => kickService.getChatColor());
handleTrusted("kick:update-chat-color", (_event, rawColor: unknown) => {
  const color = z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^#[0-9A-F]{6}$/)
    .parse(rawColor);
  return kickService.updateChatColor(color);
});
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
handleTrusted("chat:send", async (
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
    const replyParentMessageId =
      rawReplyParentMessageId === undefined
        ? undefined
        : chatReplyParentIdSchema.parse(rawReplyParentMessageId);
    const replyTarget =
      replyParentMessageId === undefined
        ? undefined
        : kickChatService.getReplyTarget(replyParentMessageId);
    if (replyParentMessageId !== undefined && replyTarget === undefined) {
      throw new Error("The Kick message being replied to is no longer available.");
    }
    return kickService.sendMessage(
      chatroomId,
      outgoingChatMessageSchema.parse(rawMessage),
      replyTarget,
    );
  }
  const channel = channelNameSchema.parse(rawChannel);
  const message = outgoingChatMessageSchema.parse(rawMessage);
  const replyParentMessageId =
    rawReplyParentMessageId === undefined
      ? undefined
      : chatReplyParentIdSchema.parse(rawReplyParentMessageId);
  const sentMessage = await twitchService.sendChatMessage(
    channel,
    message,
    replyParentMessageId,
  );
  if (!sentMessage) return;
  sendToChatSurfaces("chat:message", sentMessage);
  multiChatService.publishSentMessage(channel, sentMessage);
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
  const result = z
    .object({
      url: z.string().max(2_048),
      allowGeneric: z.boolean(),
    })
    .strict()
    .safeParse(input);
  if (!result.success) return null;
  const allowGeneric =
    result.data.allowGeneric &&
    preferencesService.get().genericLinkPreviewsEnabled;
  return linkPreviewService.getPreview(result.data.url, allowGeneric);
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
  sendToChatSurfaces("preferences:changed", preferences);
  return preferences;
});

app.whenReady().then(async () => {
  app.setAppUserModelId("app.violetwire.viewer");
  // VioletWire provides its own application UI. Removing Electron's default
  // menu also prevents Windows from revealing File/Edit/View when Alt is used
  // for emote-picker shortcuts.
  Menu.setApplicationMenu(null);
  await preferencesService.initialize();
  try {
    await hlsMediaProtocol.initialize(session.fromPartition(APP_UI_PARTITION));
  } catch {
    // Playback remains functional through FilteredHlsRelay's localhost media
    // endpoint if a platform-specific Electron build cannot host the scheme.
  }
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
  void hlsMediaProtocol.close();
});
