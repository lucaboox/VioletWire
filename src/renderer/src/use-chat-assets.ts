import { useEffect, useState } from "react";
import type { ChatBadgeAsset } from "../../shared/chat";
import type { EmoteSetResult, ProviderEmote } from "../../shared/emotes";
import { parseChannelKey } from "../../shared/platform";

export interface ChatAssets {
  badges: Map<string, ChatBadgeAsset>;
  providerEmotes: Map<string, ProviderEmote>;
}

const EMPTY: ChatAssets = { badges: new Map(), providerEmotes: new Map() };

function collect(
  results: PromiseSettledResult<EmoteSetResult>[],
): Map<string, ProviderEmote> {
  const combined = new Map<string, ProviderEmote>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const emote of result.value.emotes) {
      // A channel set is requested after the global one, and the first name
      // wins, so a channel emote does not lose to a global of the same name.
      if (!combined.has(emote.name)) combined.set(emote.name, emote);
    }
  }
  return combined;
}

/**
 * The badges and third-party emotes a channel's chat needs to render. The main
 * window loads these alongside everything else it knows about a stream; a
 * surface that only shows chat has to ask for them itself.
 */
export function useChatAssets(channel: string | null): ChatAssets {
  const [assets, setAssets] = useState<ChatAssets>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    if (!channel) {
      queueMicrotask(() => {
        if (!cancelled) setAssets(EMPTY);
      });
      return () => {
        cancelled = true;
      };
    }
    const platform = parseChannelKey(channel).platform;

    void (async () => {
      const metadata = await window.desktop.twitch
        .getStreamMetadata(channel)
        .catch(() => null);
      if (cancelled) return;
      const broadcasterId = metadata?.broadcasterId ?? null;

      const badgePromise = window.desktop.chat
        .getAssets(channel)
        .then((loaded) => new Map(loaded.badges.map((badge) => [badge.key, badge] as const)))
        .catch(() => new Map<string, ChatBadgeAsset>());

      // Only 7TV serves Kick; the other two are Twitch-only, so asking them
      // about a Kick channel would just fail.
      const emoteRequests: Promise<EmoteSetResult>[] = [
        window.desktop.emotes.getSevenTvGlobal(),
      ];
      if (platform === "twitch") {
        emoteRequests.push(
          window.desktop.emotes.getFfzGlobal(),
          window.desktop.emotes.getBttvGlobal(),
        );
      }
      if (broadcasterId) {
        emoteRequests.push(
          window.desktop.emotes.getSevenTvChannel(broadcasterId, platform),
        );
        if (platform === "twitch") {
          emoteRequests.push(
            window.desktop.emotes.getFfzChannel(broadcasterId),
            window.desktop.emotes.getBttvChannel(broadcasterId),
          );
        }
      }

      const [badges, emoteResults] = await Promise.all([
        badgePromise,
        Promise.allSettled(emoteRequests),
      ]);
      if (cancelled) return;
      setAssets({ badges, providerEmotes: collect(emoteResults) });
    })();

    return () => {
      cancelled = true;
    };
  }, [channel]);

  return assets;
}
