import { z } from "zod";

/**
 * VioletWire watches more than one service. Twitch remains the default so
 * every stored preference, favourite, and multistream tile written before Kick
 * existed keeps working without a migration.
 */
export const platformSchema = z.enum(["twitch", "kick"]);
export type Platform = z.infer<typeof platformSchema>;

export const DEFAULT_PLATFORM: Platform = "twitch";

export const PLATFORM_LABELS: Record<Platform, string> = {
  twitch: "Twitch",
  kick: "Kick",
};

/**
 * Twitch logins are `[a-z0-9_]`, but Kick slugs also allow hyphens and are
 * longer, so each service validates against its own rule rather than a single
 * permissive one that would let bad Twitch names through.
 */
const TWITCH_LOGIN = /^[a-z0-9_]{1,25}$/;
const KICK_SLUG = /^[a-z0-9_-]{1,32}$/;

export function isValidChannelName(platform: Platform, login: string): boolean {
  return platform === "kick" ? KICK_SLUG.test(login) : TWITCH_LOGIN.test(login);
}

/** A channel is only identified by its name together with the service it is on. */
export interface PlatformChannel {
  platform: Platform;
  login: string;
}

export const platformChannelSchema = z
  .object({
    platform: platformSchema,
    login: z.string().min(1).max(32).toLowerCase(),
  })
  .refine((value) => isValidChannelName(value.platform, value.login), {
    message: "Enter a valid channel name for the selected service.",
  });

/**
 * Single-string form for the places that key by channel: multistream tile
 * targets, chat buffers, emote caches. Twitch keeps its bare login so existing
 * stored values keep resolving.
 */
export function channelKey(platform: Platform, login: string): string {
  return platform === DEFAULT_PLATFORM ? login : `${platform}:${login}`;
}

export function parseChannelKey(key: string): PlatformChannel {
  const separator = key.indexOf(":");
  if (separator === -1) return { platform: DEFAULT_PLATFORM, login: key };

  const platform = platformSchema.safeParse(key.slice(0, separator));
  if (!platform.success) return { platform: DEFAULT_PLATFORM, login: key };
  return { platform: platform.data, login: key.slice(separator + 1) };
}

/**
 * Validates the single-string channel form crossing IPC. Twitch's own schema
 * stays in place for calls that reach Helix, which needs a bare login and
 * accepts channel URLs; this one only has to recognise what the players and
 * chat key themselves by.
 */
export const channelKeySchema = z
  .string()
  .max(40)
  .transform((value) => value.trim().toLowerCase())
  .superRefine((value, context) => {
    const { platform, login } = parseChannelKey(value);
    if (!isValidChannelName(platform, login)) {
      context.addIssue({ code: "custom", message: "Enter a valid channel name." });
    }
  });

/** The channel's page on its own service, used for Streamlink and browser links. */
export function channelUrl(platform: Platform, login: string): string {
  return platform === "kick"
    ? `https://kick.com/${login}`
    : `https://www.twitch.tv/${login}`;
}

/**
 * Streamlink's per-plugin options. Twitch takes a codec list because its
 * transcodes vary; Kick is Amazon IVS and only exposes the low-latency switch.
 */
export function streamlinkPlatformArguments(platform: Platform): string[] {
  return platform === "kick"
    ? [
        "--kick-low-latency",
        // The Kick plugin otherwise launches a headless Chromium to solve a JS
        // challenge. Supplying a session cookie makes that unnecessary, and
        // disabling it turns a missing browser into a clear failure rather than
        // a stall.
        "--webbrowser=no",
      ]
    : ["--twitch-low-latency", "--twitch-supported-codecs", "h264,h265,av1"];
}

/**
 * A Kick channel as the renderer sees it. Search results carry less than the
 * channel endpoint does: Kick returns no viewer count or stream title there.
 */
export interface KickChannelResult {
  id: string;
  slug: string;
  displayName: string;
  profileImageUrl: string;
  isLive: boolean;
  category?: string;
  viewerCount: number;
}

export interface KickApi {
  search(query: string): Promise<KickChannelResult[]>;
}
