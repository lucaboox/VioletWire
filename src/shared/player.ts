import { z } from "zod";
import type { EmoteApi } from "./emotes";
import type { ChatApi } from "./chat";
import type { TwitchApi } from "./twitch";
import type { UpdateApi } from "./updates";

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

export const playerBoundsSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const channelActionSchema = z.enum(["channel", "subscribe", "clip"]);
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
  channel: z.string().min(1).max(25).regex(/^[a-z0-9_]+$/),
  fullscreen: z.boolean(),
  theaterMode: z.boolean(),
  chatVisible: z.boolean(),
  chatPresentation: chatPresentationSchema,
});
export const nativeQualitySchema = z
  .string()
  .regex(/^(?:best|worst|source|audio_only|\d{2,4}p(?:\d{2,3})?)$/);
export const nativePlayerCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("toggle-pause") }),
  z.object({ command: z.literal("toggle-mute") }),
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

export type PlayerBounds = z.infer<typeof playerBoundsSchema>;
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

export interface NativeControlsContext {
  channel: string;
  fullscreen: boolean;
  theaterMode: boolean;
  chatVisible: boolean;
  chatPresentation: ChatPresentation;
}

function formatQualityLabel(quality: NativeQualityValue): string {
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
  if (/no playable streams found/i.test(message)) return "Stream is offline.";
  return message;
}

export interface NativePlayerAvailability {
  available: boolean;
  streamlinkPath?: string;
  mpvPath?: string;
  reason?: string;
}

export interface NativePlayerState {
  status: "idle" | "starting" | "playing" | "stopped" | "error";
  paused: boolean;
  muted: boolean;
  volume: number;
  compressorEnabled: boolean;
  behindLive: boolean;
  quality: NativeQualityValue;
  error?: string;
}

export interface DesktopApi {
  twitch: TwitchApi;
  emotes: EmoteApi;
  chat: ChatApi;
  updates: UpdateApi;
  player: {
    open(channel: string, mode: PlayerMode, quality?: NativeQualityValue): Promise<{
      channel: string;
      mode: PlayerMode;
      fallbackReason?: string;
    }>;
    close(): Promise<void>;
    setBounds(bounds: PlayerBounds): void;
    setChatBounds(bounds: PlayerBounds): void;
    setChatVisible(visible: boolean): void;
    setChatPresentation(presentation: ChatPresentation): void;
    setFullscreen(fullscreen: boolean): Promise<boolean>;
    openChannelAction(channel: string, action: ChannelAction): Promise<void>;
    getNativeAvailability(): Promise<NativePlayerAvailability>;
    getNativeQualities(channel: string): Promise<NativeQuality[]>;
    setNativeQuality(channel: string, quality: NativeQualityValue): Promise<void>;
    controlNative(command: NativePlayerCommand): void;
    onNativeState(listener: (state: NativePlayerState) => void): () => void;
    readyNativeControls(): void;
    setNativeControlsVisible(visible: boolean): void;
    setNativeControlsExpanded(expanded: boolean): void;
    setNativeControlsContext(context: NativeControlsContext): void;
    onNativeControlsVisibility(listener: (visible: boolean) => void): () => void;
    sendNativeControlAction(action: NativeControlAction): void;
    onNativeControlsContext(listener: (context: NativeControlsContext) => void): () => void;
    onNativeControlAction(listener: (action: NativeControlAction) => void): () => void;
  };
}
