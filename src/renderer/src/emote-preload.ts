import type { TwitchPickerEmote } from "../../shared/chat";
import type {
  EmoteImageVariant,
  EmoteProvider,
  ProviderEmote,
} from "../../shared/emotes";
import { chatEmoteVariant, pickerEmoteVariant } from "./emote-scale";

/**
 * Warms emote images into Chromium's cache as soon as a channel's emote lists
 * arrive, rather than when the picker first opens.
 *
 * Nothing about opening the picker is slow in itself — the lists are already in
 * memory. What is slow is the few hundred image requests the grid fires the
 * moment it mounts, on a cold cache: the tiles come in raggedly for a second or
 * two. Fetching them quietly in the background beforehand means the grid (and
 * the autocomplete popup, and chat itself, which use the same URLs) paints from
 * cache instead.
 *
 * The whole point is to stay out of the way, so what gets warmed is chosen by
 * weight rather than by count. A still emote is a few kilobytes; an animated
 * one averages 150 KB and the showy wide ones pass a megabyte. One large
 * channel's set is over a hundred megabytes at the size chat uses — far too
 * much to pull on the chance somebody opens the picker, and enough to push
 * everything else out of the cache on the way in. So the cheap majority is
 * fetched up front and the heavy few are left to load when they are actually
 * shown, which for most of them is never.
 */

/**
 * One at a time. Measured on a large channel: warming two at a time still put
 * eight hundred requests on the same connection the video and the chat images
 * are using, and chat's own emotes — the ones a viewer is waiting to read —
 * went from arriving in 200 ms to taking twenty seconds and more.
 */
const MAX_CONCURRENT_WARMS = 1;
/**
 * Skipped rather than warmed. At the size chat draws, a still emote is about
 * 2 KB and an animated one 66 KB, so this keeps the stills and the lightest
 * animations. Everything heavier loads when it is actually shown.
 */
const HEAVY_EMOTE_BYTES = 16 * 1024;
/** What one channel may pull in the background, all providers together. */
const WARM_BUDGET_BYTES = 3 * 1024 * 1024;
/** A ceiling on requests as well, for a set of unusually tiny emotes. */
const MAX_WARM_REQUESTS = 400;
// Only 7TV reports sizes. For the rest, judge by whether it moves: FrankerFaceZ
// and Twitch stills are a few kilobytes, and an animation is worth assuming
// heavy, since assuming wrongly is what filled the cache in the first place.
const ASSUMED_STILL_BYTES = 8 * 1024;
const ASSUMED_ANIMATED_BYTES = 150 * 1024;

export interface EmoteWarmSource {
  providerEmotes: Map<EmoteProvider, Map<string, ProviderEmote>>;
  providerChannelNames: Map<EmoteProvider, Set<string>>;
  platformEmotes: TwitchPickerEmote[];
}

interface WarmCandidate {
  url: string;
  bytes: number;
}

/**
 * The image URLs worth warming, channel emotes first, stopping at the budget.
 * Exported for its own sake so the choice can be tested without a network.
 */
export function planEmoteWarmUrls({
  providerEmotes,
  providerChannelNames,
  platformEmotes,
}: EmoteWarmSource): string[] {
  const channel: WarmCandidate[] = [];
  const global: WarmCandidate[] = [];
  const add = (
    into: WarmCandidate[],
    variant: EmoteImageVariant | undefined,
    animated: boolean,
  ) => {
    if (!variant?.url) return;
    const bytes =
      variant.bytes ?? (animated ? ASSUMED_ANIMATED_BYTES : ASSUMED_STILL_BYTES);
    if (bytes > HEAVY_EMOTE_BYTES) return;
    into.push({ url: variant.url, bytes });
  };
  for (const [provider, emotes] of providerEmotes) {
    const channelNames = providerChannelNames.get(provider) ?? new Set<string>();
    for (const emote of emotes.values()) {
      const into = channelNames.has(emote.name) ? channel : global;
      // What chat will ask for, which is the whole point of warming.
      const forChat = chatEmoteVariant(emote.variants);
      add(into, forChat, emote.animated);
      // The picker draws larger. Its image is worth having ready too when it
      // is a still one, which costs a couple of kilobytes; the animated ones
      // at that size are what made this expensive, and they load on opening.
      const forPicker = pickerEmoteVariant(emote.variants);
      if (!emote.animated && forPicker?.url !== forChat?.url) {
        add(into, forPicker, false);
      }
    }
  }
  for (const emote of platformEmotes) {
    if (!emote.imageUrl) continue;
    // Twitch and Kick publish no sizes and no animated flag; their emotes are
    // small enough that treating them as stills holds.
    (emote.scope === "channel" ? channel : global).push({
      url: emote.imageUrl,
      bytes: ASSUMED_STILL_BYTES,
    });
  }

  const ordered: string[] = [];
  const seen = new Set<string>();
  let spent = 0;
  for (const candidate of [...channel, ...global]) {
    if (seen.has(candidate.url)) continue;
    if (spent + candidate.bytes > WARM_BUDGET_BYTES) continue;
    seen.add(candidate.url);
    spent += candidate.bytes;
    ordered.push(candidate.url);
    if (ordered.length >= MAX_WARM_REQUESTS) break;
  }
  return ordered;
}

/**
 * How long warming waits after chat has had to fetch an emote of its own. Long
 * enough for a burst of new messages to finish, short enough that warming still
 * makes progress in the gaps between them.
 */
const WARM_QUIET_MS = 2500;
/** How long a newly opened channel is left alone before warming begins. */
const WARM_START_DELAY_MS = 30_000;

const warmedUrls = new Set<string>();
let pending: string[] = [];
let inFlight = 0;
let quietUntil = 0;
let resumeTimer: number | null = null;
let startTimer: number | null = null;

/**
 * Holds warming back because a message on screen is waiting on an emote image.
 * A blank in a message someone just sent matters more than an emote nobody has
 * opened the picker to see. Called both when chat starts fetching one and when
 * it finishes, so a steady stream of messages keeps warming out of the way for
 * as long as it lasts — and, being a deadline rather than a count, it can never
 * be left paused by an image that neither loads nor fails.
 */
export function holdEmoteWarming(): void {
  quietUntil = Date.now() + WARM_QUIET_MS;
}

function pump() {
  const quietFor = quietUntil - Date.now();
  if (quietFor > 0 && pending.length > 0) {
    if (resumeTimer === null) {
      resumeTimer = window.setTimeout(() => {
        resumeTimer = null;
        pump();
      }, quietFor);
    }
    return;
  }
  while (inFlight < MAX_CONCURRENT_WARMS) {
    const url = pending.shift();
    if (!url) return;
    if (warmedUrls.has(url)) continue;
    warmedUrls.add(url);
    inFlight += 1;
    const image = new Image();
    // Low priority keeps these behind the video segments and the images chat is
    // actually showing right now.
    image.fetchPriority = "low";
    image.decoding = "async";
    const done = () => {
      inFlight -= 1;
      pump();
    };
    image.addEventListener("load", done, { once: true });
    image.addEventListener("error", done, { once: true });
    image.src = url;
  }
}

/**
 * Queues a channel's emote images for background fetching. Anything still
 * queued from a previous channel is dropped — the emotes on screen now matter
 * more than the ones from a channel that was left.
 */
export function warmEmoteImages(source: EmoteWarmSource): void {
  const urls = planEmoteWarmUrls(source).filter((url) => !warmedUrls.has(url));
  if (urls.length === 0) return;
  pending = urls;
  if (startTimer !== null) window.clearTimeout(startTimer);
  // The seconds right after a channel opens are the worst possible time for
  // this: the player is filling its buffer and chat is drawing its first
  // screenful, both on the same connection. Warming waits until that has
  // passed, and then only runs in the quiet between messages.
  startTimer = window.setTimeout(() => {
    startTimer = null;
    pump();
  }, WARM_START_DELAY_MS);
}

/** Emote images were just dropped from the cache, so let them be fetched again. */
export function forgetWarmedEmoteImages(): void {
  pending = [];
  warmedUrls.clear();
  for (const timer of [resumeTimer, startTimer]) {
    if (timer !== null) window.clearTimeout(timer);
  }
  resumeTimer = null;
  startTimer = null;
}
