import { z } from "zod";
import type { EmoteApi } from "./emotes";
import type { ChatApi, ChatConnectionState, ChatMessage } from "./chat";
import type { TwitchApi } from "./twitch";
import type { UpdateApi } from "./updates";
import type { PreferencesApi } from "./preferences";
import type { PlaybackLatencyMode } from "./preferences";
import type { LinkPreview } from "./link-preview";
import type { KickApi } from "./platform";

function normalizeChannelInput(input: string): string {
  const value = input.trim().toLowerCase();
  if (!value.includes("/") && !value.includes(".")) return value;

  const candidate = value.startsWith("http://") || value.startsWith("https://") ? value : "https://" + value;
  const url = new URL(candidate);
  if (url.protocol !== "https:" || !["twitch.tv", "www.twitch.tv", "m.twitch.tv"].includes(url.hostname)) {
    throw new Error("Only Twitch channel URLs are supported.");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) throw new Error("Enter a Twitch channel URL.");
  return segments[0];
}

export const channelNameSchema = z
  .string()
  .transform((input, context) => {
    try {
      return normalizeChannelInput(input);
    } catch {
      context.addIssue({ code: "custom", message: "Enter a valid Twitch channel name or URL." });
      return z.NEVER;
    }
  })
  .pipe(z.string().min(1).max(25).regex(/^[a-z0-9_]+$/, "Enter a valid Twitch channel name or URL."));

// Subscribing has its own window (a modal showing Twitch's subscribe page), so
// it is no longer one of these isolated-window actions.
export const channelActionSchema = z.enum(["channel", "clip"]);
export const playerModeSchema = z.enum(["official", "native"]);
export const chatPresentationSchema = z.enum(["side", "overlay"]);
export const nativeControlActionSchema = z.enum([
  "activity",
  "toggle-theater",
  "toggle-fullscreen",
  "hide-chat",
  "side-chat",
  "overlay-chat",
]);
export const nativeControlsContextSchema = z.object({
  // A channel key, not a Twitch login: this context carries whichever service
  // is playing, and the Twitch pattern rejected every Kick channel, so the
  // controls never learned which channel they were showing.
  channel: z.string().min(1).max(40).regex(/^(?:[a-z0-9_-]+:)?[a-z0-9_-]+$/),
  fullscreen: z.boolean(),
  theaterMode: z.boolean(),
  chatVisible: z.boolean(),
  chatPresentation: chatPresentationSchema,
  channelDisplayName: z.string().min(1).max(50).optional(),
  viewerLogin: z.string().max(25).regex(/^[a-z0-9_]*$/).optional(),
  // Whether the viewer follows the channel, so the overlay composer can block a
  // followers-only chat it is certain the viewer cannot post to.
  isFollowed: z.boolean().optional(),
});
export const nativeQualitySchema = z
  .string()
  .regex(/^(?:best|worst|source|audio_only|\d{2,4}p(?:\d{2,3})?)$/);
export const nativePlayerCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("toggle-pause") }),
  z.object({ command: z.literal("toggle-mute") }),
  z.object({ command: z.literal("set-muted"), muted: z.boolean() }),
  z.object({ command: z.literal("go-live") }),
  z.object({
    command: z.literal("set-volume"),
    value: z.number().min(0).max(100),
  }),
  z.object({
    command: z.literal("set-compressor"),
    enabled: z.boolean(),
  }),
]);

export type ChannelAction = z.infer<typeof channelActionSchema>;
export type PlayerMode = z.infer<typeof playerModeSchema>;
export type ChatPresentation = z.infer<typeof chatPresentationSchema>;
export type NativeControlAction = z.infer<typeof nativeControlActionSchema>;
export type NativeQualityValue = z.infer<typeof nativeQualitySchema>;
export type NativePlayerCommand = z.infer<typeof nativePlayerCommandSchema>;

export interface NativeQuality {
  value: NativeQualityValue;
  label: string;
}

export function isHighResolutionQuality(
  quality: NativeQualityValue,
  availableQualities: NativeQuality[],
): boolean {
  const heightFrom = (value: NativeQualityValue): number | null => {
    const match = /^(\d{2,4})p/.exec(value);
    return match ? Number.parseInt(match[1], 10) : null;
  };
  const explicitHeight = heightFrom(quality);
  if (explicitHeight !== null) return explicitHeight > 1_080;
  // Source can be above 1080p without advertising a numeric selector. Prefer
  // the completed-fragment path for an explicit Source selection.
  if (quality === "source") return true;
  if (quality !== "best" && quality !== "source") return false;
  return availableQualities.some((candidate) => {
    const height =
      heightFrom(candidate.value) ??
      (() => {
        const labelMatch = /(\d{3,4})p/i.exec(candidate.label);
        return labelMatch ? Number.parseInt(labelMatch[1], 10) : null;
      })();
    return height !== null && height > 1_080;
  });
}

export interface NativeControlsContext {
  channel: string;
  fullscreen: boolean;
  theaterMode: boolean;
  chatVisible: boolean;
  chatPresentation: ChatPresentation;
  channelDisplayName?: string;
  viewerLogin?: string;
  isFollowed?: boolean;
}

export function formatQualityLabel(quality: NativeQualityValue): string {
  if (quality === "best") return "Auto";
  if (quality === "worst") return "Lowest";
  if (quality === "source") return "Source";
  if (quality === "audio_only") return "Audio only";

  const match = /^(\d{2,4})p(\d{2,3})?$/.exec(quality);
  if (!match) return quality;
  return match[2] ? `${match[1]}p · ${match[2]} FPS` : `${match[1]}p`;
}

export function parseStreamlinkQualityOutput(output: string): NativeQuality[] {
  const availableLine = output
    .split(/\r?\n/)
    .find((line) => line.trim().toLowerCase().startsWith("available streams:"));
  if (!availableLine) return [{ value: "best", label: "Auto" }];

  const qualities = availableLine
    .slice(availableLine.indexOf(":") + 1)
    .split(",")
    .map((entry) => entry.trim().replace(/\s+\([^)]*\)\s*$/, ""))
    .filter((entry): entry is NativeQualityValue => nativeQualitySchema.safeParse(entry).success)
    .filter((entry) => entry !== "best" && entry !== "worst");

  const uniqueQualities = [...new Set(qualities)].sort((left, right) => {
    if (left === "source") return -1;
    if (right === "source") return 1;
    if (left === "audio_only") return 1;
    if (right === "audio_only") return -1;
    const leftPixels = Number.parseInt(left, 10);
    const rightPixels = Number.parseInt(right, 10);
    if (leftPixels !== rightPixels) return rightPixels - leftPixels;
    return right.localeCompare(left);
  });
  const automaticQuality = uniqueQualities.find((value) => value !== "audio_only");
  const automaticLabel =
    automaticQuality === "source"
      ? "Auto (Source)"
      : automaticQuality
        ? `Auto (${Number.parseInt(automaticQuality, 10)}p)`
        : "Auto";

  return [
    { value: "best", label: automaticLabel },
    ...uniqueQualities.map((value) => ({ value, label: formatQualityLabel(value) })),
  ];
}

export function presentNativePlaybackError(message: string): string {
  if (isNativeStreamUnavailable(message)) return "Stream is offline.";
  return message;
}

/** A normal channel state, not a failure of Native playback. */
export function isNativeStreamUnavailable(message: string): boolean {
  return /no playable streams|stream is offline|channel is offline/i.test(message);
}

export interface NativePlayerAvailability {
  available: boolean;
  streamlinkPath?: string;
  reason?: string;
}

// Why the player is currently in "starting": lets the loading surface say
// "Loading <channel>" or "Switching to 1080p" instead of a generic label.
export interface NativePlayerTransition {
  kind: "channel" | "quality";
  detail: string;
}

export interface NativePlayerState {
  status: "idle" | "starting" | "playing" | "stopped" | "error";
  paused: boolean;
  muted: boolean;
  volume: number;
  compressorEnabled: boolean;
  behindLive: boolean;
  quality: NativeQualityValue;
  hlsSource?: {
    sessionId: string;
    playlistUrl: string;
    latencyMode: PlaybackLatencyMode;
    requestedLatencyMode: PlaybackLatencyMode;
    mediaTransport: "chromium-protocol" | "localhost-relay";
  };
  error?: string;
  transition?: NativePlayerTransition;
}

export const nativeHlsStateReportSchema = z.object({
  target: z.union([
    z.literal("main"),
    z.string().regex(/^multi-[0-3]$/),
  ]),
  sessionId: z.string().uuid(),
  status: z.enum(["playing", "stopped", "error"]),
  paused: z.boolean(),
  muted: z.boolean(),
  volume: z.number().min(0).max(100),
  behindLive: z.boolean(),
  error: z.string().max(500).optional(),
  stats: z.record(z.string(), z.string()).optional(),
});

export type NativeHlsStateReport = z.infer<typeof nativeHlsStateReportSchema>;

// Multistream shows up to this many native players in a grid at once. Only the
// active tile plays audio.
export const MAX_MULTISTREAM_TILES = 4;

export interface MultiStreamTile {
  id: number;
  channel: string;
}

export interface MultiStreamTileState extends MultiStreamTile {
  state: NativePlayerState;
  active: boolean;
}

export interface DesktopApi {
  system: {
    openExternal(url: string): Promise<void>;
    getLinkPreview(url: string, allowGeneric?: boolean): Promise<LinkPreview | null>;
  };
  twitch: TwitchApi;
  kick: KickApi;
  emotes: EmoteApi;
  chat: ChatApi;
  updates: UpdateApi;
  preferences: PreferencesApi;
  player: {
    open(channel: string, mode: PlayerMode, quality?: NativeQualityValue): Promise<{
      channel: string;
      mode: PlayerMode;
      fallbackReason?: string;
    }>;
    close(): Promise<void>;
    preresolveStream(channel: string): void;
    setFullscreen(fullscreen: boolean): Promise<boolean>;
    onFullscreenChanged(listener: (fullscreen: boolean) => void): () => void;
    openChannelAction(channel: string, action: ChannelAction): Promise<void>;
    // Opens Twitch's subscribe page for the channel in a titled modal window.
    openSubscription(channel: string, title: string): Promise<void>;
    getNativeAvailability(): Promise<NativePlayerAvailability>;
    getNativeQualities(channel: string): Promise<NativeQuality[]>;
    setNativeQuality(channel: string, quality: NativeQualityValue): Promise<void>;
    controlNative(command: NativePlayerCommand): void;
    reportNativeHlsState(report: NativeHlsStateReport): void;
    onNativeHlsCommand(
      listener: (target: string, command: NativePlayerCommand) => void,
    ): () => void;
    // Player diagnostics reported by Chromium/hls.js, or null when Native is
    // not currently playing.
    getNativeStats(): Promise<Record<string, string> | null>;
    onNativeState(listener: (state: NativePlayerState) => void): () => void;
    sendNativeControlAction(action: NativeControlAction): void;
    onNativeControlAction(listener: (action: NativeControlAction) => void): () => void;
    // Multistream: up to MAX_MULTISTREAM_TILES native players in a grid.
    multiStart(channels: string[]): Promise<MultiStreamTileState[]>;
    multiStop(): void;
    onMultiChatMessage(listener: (channel: string, message: ChatMessage) => void): () => void;
    onMultiChatState(
      listener: (channel: string, state: ChatConnectionState) => void,
    ): () => void;
    multiAddTile(channel: string): Promise<MultiStreamTileState | null>;
    multiRemoveTile(id: number): void;
    multiSetActive(id: number): void;
    multiControl(id: number, command: NativePlayerCommand): void;
    multiSetQuality(id: number, quality: NativeQualityValue): Promise<void>;
    onMultiTileState(listener: (tile: MultiStreamTileState) => void): () => void;
    onMultiTileRemoved(listener: (id: number) => void): () => void;
  };
}
