import {
  Globe2,
  MoveDiagonal2,
  Palette,
  Search,
  Smile,
  Sparkles,
  Star,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { NativeEmoji, SkinTone } from "emoji-picker-element/shared";
import type { TwitchPickerEmote } from "../../shared/chat";
import type {
  EmoteProvider,
  ProviderEmote,
} from "../../shared/emotes";
import {
  defaultAppPreferences,
  type AppPreferences,
  type AppPreferencesPatch,
} from "../../shared/preferences";
import "./emote-picker.css";
import {
  ProviderLogo,
  type ProviderLogoName,
} from "./ProviderLogo";
import { emoteImageUrl } from "./emote-image-url";
import { pickerEmoteVariant } from "./emote-scale";
import { CountryFlagEmoji } from "./CountryFlagEmoji";
import {
  loadedUnicodeEmoji,
  preloadUnicodeEmoji,
  rememberUnicodeSkinTone,
  unicodeEmojiDatabase,
  UNICODE_EMOJI_GROUPS,
} from "./unicode-emoji";

type Provider = "favorites" | "emoji" | "7tv" | "twitch" | "ffz" | "bttv";

// Windows updates its color emoji font independently from Chromium. Probe a
// representative emoji from each Unicode release once, then avoid offering
// newer characters that would otherwise render as empty boxes in the picker.
const EMOJI_SUPPORT_TESTS = [
  { emoji: "🫪", version: 17 },
  { emoji: "🫩", version: 16 },
  { emoji: "🫨", version: 15.1 },
  { emoji: "🫠", version: 14 },
  { emoji: "🥲", version: 13.1 },
  { emoji: "🥻", version: 12.1 },
  { emoji: "🥰", version: 11 },
  { emoji: "🤩", version: 5 },
  { emoji: "👱‍♀️", version: 4 },
  { emoji: "🤣", version: 3 },
  { emoji: "👁️‍🗨️", version: 2 },
  { emoji: "😀", version: 1 },
  { emoji: "😐️", version: 0.7 },
  { emoji: "😃", version: 0.6 },
] as const;

function nativeEmojiSupportVersion(): number {
  try {
    const featureFor = (emoji: string, color: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return "";
      context.textBaseline = "top";
      context.font = '100px "Segoe UI Emoji", "Segoe UI Symbol", sans-serif';
      context.fillStyle = color;
      context.scale(0.01, 0.01);
      context.fillText(emoji, 0, 0);
      return [...context.getImageData(0, 0, 1, 1).data].join(",");
    };
    for (const test of EMOJI_SUPPORT_TESTS) {
      const dark = featureFor(test.emoji, "#000");
      const light = featureFor(test.emoji, "#fff");
      if (dark === light && !dark.startsWith("0,0,0,")) return test.version;
    }
  } catch {
    // Canvas can be unavailable in unusual hardened environments. In that
    // case, showing the full set is more useful than hiding valid emoji.
  }
  return EMOJI_SUPPORT_TESTS[0].version;
}

const zwjSupportCache = new Map<string, boolean>();

function nativeEmojiSequenceSupported(unicode: string): boolean {
  if (!unicode.includes("\u200d")) return true;
  const cached = zwjSupportCache.get(unicode);
  if (cached !== undefined) return cached;
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return true;
    context.font = '100px "Segoe UI Emoji", "Segoe UI Symbol", sans-serif';
    const baselineWidth = context.measureText("😀").width;
    const sequenceWidth = context.measureText(unicode).width;
    // Unsupported Windows ZWJ emoji render as two or more separate glyphs.
    // Supported sequences can be wider than a normal face, hence the same
    // deliberately generous 1.8x threshold used by emoji-picker-element.
    const supported = sequenceWidth / 1.8 < baselineWidth;
    zwjSupportCache.set(unicode, supported);
    return supported;
  } catch {
    return true;
  }
}

interface PickerEmote {
  key: string;
  name: string;
  imageUrl?: string;
  unicode?: string;
  provider: "7TV" | "FrankerFaceZ" | "BetterTTV" | "Twitch" | "Kick" | "Emoji";
  providerId: EmoteProvider | "twitch" | "emoji";
  scope: "channel" | "global";
  subscriptionOnly: boolean;
  modifier: boolean;
  wide: boolean;
  ownerId?: string;
  ownerName?: string;
  ownerImageUrl?: string;
  categoryId?: string;
  categoryName?: string;
}

interface EmotePickerProps {
  channelAvatarUrl?: string;
  channelName: string;
  onClose(): void;
  onSelect(name: string): void;
  providerChannelEmoteNames: Map<EmoteProvider, Set<string>>;
  providerEmotes: Map<EmoteProvider, Map<string, ProviderEmote>>;
  twitchEmotes: TwitchPickerEmote[];
  /**
   * Names the service whose own emotes fill the platform tab. Kick has no
   * FrankerFaceZ or BetterTTV, and its emotes come from its own API, but they
   * sit in exactly the same place as Twitch's.
   */
  platformLabel?: "Twitch" | "Kick";
}

interface Section {
  id: string;
  label: string;
  emotes: PickerEmote[];
  scope?: "channel" | "global" | "effect" | "emoji" | "twitch-set";
  avatarUrl?: string;
  glyph?: string;
}

const FAVORITES_KEY = "violetwire.emotes.favorites";
const SIZE_KEY = "violetwire.emotes.pickerSize";

function readFavorites(): Set<string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(FAVORITES_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function readSize(): { width: number; height: number } {
  try {
    const value = JSON.parse(window.localStorage.getItem(SIZE_KEY) ?? "{}") as {
      width?: unknown;
      height?: unknown;
    };
    return {
      width: typeof value.width === "number" ? value.width : 390,
      height: typeof value.height === "number" ? value.height : 500,
    };
  } catch {
    return { width: 390, height: 500 };
  }
}

function clampSize(size: { width: number; height: number }) {
  const maximumWidth = Math.max(330, Math.min(600, window.innerWidth - 20));
  const maximumHeight = Math.max(360, Math.min(700, window.innerHeight - 90));
  return {
    width: Math.min(Math.max(size.width, 330), maximumWidth),
    height: Math.min(Math.max(size.height, 360), maximumHeight),
  };
}

// The saved picker size lives in the main-process preferences file, so it can
// only be read asynchronously — but the picker mounts synchronously the moment
// it opens. Without a warm value it would open at the default and then resize,
// a visible flash. Warm this module-level cache once at startup (long before
// the user first opens the picker) and keep it current on every change, so each
// open starts at the right size.
let cachedPickerSize = {
  width: defaultAppPreferences.emotePickerWidth,
  height: defaultAppPreferences.emotePickerHeight,
};
void window.desktop.preferences
  .getOrMigrate()
  .then((preferences) => {
    cachedPickerSize = {
      width: preferences.emotePickerWidth,
      height: preferences.emotePickerHeight,
    };
  })
  .catch(() => undefined);

function providerLabel(provider: Provider): string {
  if (provider === "favorites") return "Favorites";
  if (provider === "emoji") return "Emoji";
  if (provider === "twitch") return "Twitch";
  if (provider === "7tv") return "7TV";
  return provider.toUpperCase();
}

function ProviderMark({
  icon: Icon,
  label,
  logo,
}: {
  icon?: LucideIcon;
  label: string;
  logo?: ProviderLogoName;
}) {
  if (Icon) return <Icon size={17} />;
  if (logo) return <ProviderLogo name={logo} />;
  return <span>{label}</span>;
}

function searchSectionFor(emote: PickerEmote): { id: string; label: string } {
  if (emote.provider === "Emoji") {
    const group = UNICODE_EMOJI_GROUPS.find(({ id }) => String(id) === emote.ownerId);
    return {
      id: `emoji-${emote.ownerId ?? "all"}`,
      label: `Emoji · ${group?.label ?? "Emoji"}`,
    };
  }
  if (emote.provider === "Twitch") {
    const label = emote.categoryName ?? (emote.scope === "global"
      ? "Global emotes"
      : emote.ownerName ?? "Channel emotes");
    const categoryId = emote.categoryId ?? emote.ownerId ?? "global";
    return { id: `twitch-${emote.scope}-${categoryId}`, label: `Twitch · ${label}` };
  }
  const label = emote.modifier
    ? "Effects"
    : emote.scope === "channel"
      ? "Channel emotes"
      : "Global emotes";
  return {
    id: `${emote.providerId}-${label.toLowerCase().replaceAll(" ", "-")}`,
    label: `${emote.provider} · ${label}`,
  };
}

export function EmotePicker({
  channelAvatarUrl,
  channelName,
  onClose,
  onSelect,
  providerChannelEmoteNames,
  providerEmotes,
  twitchEmotes,
  platformLabel = "Twitch",
}: EmotePickerProps) {
  const platformProviders = platformLabel === "Kick";
  const [selectedProvider, setProvider] = useState<Provider>("7tv");
  // FFZ and BTTV do not exist on Kick, so a lingering selection of one falls
  // back to 7TV without a round trip through state.
  const provider =
    platformProviders && (selectedProvider === "ffz" || selectedProvider === "bttv")
      ? "7tv"
      : selectedProvider;
  const [query, setQuery] = useState("");
  const [searchAllProviders, setSearchAllProviders] = useState(false);
  const [favorites, setFavorites] = useState(readFavorites);
  const [size, setSize] = useState(() => clampSize(cachedPickerSize));
  const [unicodeEmoji, setUnicodeEmoji] = useState<Map<number, NativeEmoji[]>>(
    () => new Map(loadedUnicodeEmoji().groups),
  );
  const [unicodeLoading, setUnicodeLoading] = useState(false);
  const [unicodeLoadFailed, setUnicodeLoadFailed] = useState(false);
  const [skinTone, setSkinTone] = useState<SkinTone>(loadedUnicodeEmoji().skinTone);
  const [skinTonePickerOpen, setSkinTonePickerOpen] = useState(false);
  const [visibleEmojiSections, setVisibleEmojiSections] = useState<Set<string>>(new Set());
  const [emojiSectionHeights, setEmojiSectionHeights] = useState<Map<string, number>>(new Map());
  const [emojiSupportVersion] = useState(nativeEmojiSupportVersion);
  const scrollHost = useRef<HTMLDivElement>(null);
  const sectionHosts = useRef(new Map<string, HTMLElement>());
  const resizing = useRef(false);
  const unicodeLoadStarted = useRef(false);
  const pickerMounted = useRef(true);

  // Favorites and size persist in the main-process preferences file: the
  // packaged renderer sits on a random-port origin, so its localStorage is
  // wiped every launch. localStorage survives below only as a one-time
  // migration source from older builds, and onChanged keeps the pickers in
  // the main and native-controls windows in sync.
  useEffect(() => {
    let disposed = false;
    const apply = (preferences: AppPreferences) => {
      if (disposed) return;
      setFavorites(new Set(preferences.emoteFavorites));
      setSearchAllProviders(preferences.emoteSearchAllProviders);
      if (!resizing.current) {
        cachedPickerSize = {
          width: preferences.emotePickerWidth,
          height: preferences.emotePickerHeight,
        };
        setSize(clampSize(cachedPickerSize));
      }
    };
    const removeListener = window.desktop.preferences.onChanged(apply);
    void window.desktop.preferences
      .getOrMigrate()
      .then((preferences) => {
        apply(preferences);
        const patch: AppPreferencesPatch = {};
        const legacyFavorites = readFavorites();
        if (preferences.emoteFavorites.length === 0 && legacyFavorites.size > 0) {
          patch.emoteFavorites = [...legacyFavorites];
        }
        const legacySize = readSize();
        if (
          preferences.emotePickerWidth === defaultAppPreferences.emotePickerWidth &&
          preferences.emotePickerHeight === defaultAppPreferences.emotePickerHeight &&
          (legacySize.width !== defaultAppPreferences.emotePickerWidth ||
            legacySize.height !== defaultAppPreferences.emotePickerHeight)
        ) {
          patch.emotePickerWidth = Math.min(600, Math.max(330, Math.round(legacySize.width)));
          patch.emotePickerHeight = Math.min(700, Math.max(360, Math.round(legacySize.height)));
        }
        if (Object.keys(patch).length > 0) {
          window.localStorage.removeItem(FAVORITES_KEY);
          window.localStorage.removeItem(SIZE_KEY);
          void window.desktop.preferences.update(patch).catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      removeListener();
    };
  }, []);

  useEffect(() => {
    pickerMounted.current = true;
    return () => {
      pickerMounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (unicodeEmoji.size > 0 || unicodeLoadFailed || unicodeLoadStarted.current) return;
    unicodeLoadStarted.current = true;

    void Promise.resolve()
      .then(() => {
        if (!pickerMounted.current) return null;
        setUnicodeLoading(true);
        return preloadUnicodeEmoji();
      })
      .then((loaded) => {
        if (!loaded || !pickerMounted.current) return;
        setSkinTone(loaded.skinTone);
        setUnicodeEmoji(new Map(loaded.groups));
      })
      .catch(() => {
        unicodeLoadStarted.current = false;
        if (pickerMounted.current) setUnicodeLoadFailed(true);
      })
      .finally(() => {
        if (pickerMounted.current) setUnicodeLoading(false);
      });
  }, [unicodeEmoji.size, unicodeLoadFailed]);

  const unicodePickerEmotes = useMemo(() => {
    const preferredUnicode = (emoji: NativeEmoji) =>
      skinTone === 0
        ? emoji.unicode
        : emoji.skins?.find((skin) => skin.tone === skinTone)?.unicode ?? emoji.unicode;
    return UNICODE_EMOJI_GROUPS.flatMap(({ id }) =>
      (unicodeEmoji.get(id) ?? [])
        .filter((emoji) => emoji.version <= emojiSupportVersion)
        .filter((emoji) => nativeEmojiSequenceSupported(preferredUnicode(emoji)))
        .map((emoji) => ({
        key: `emoji:${emoji.unicode}`,
        name: emoji.annotation ?? emoji.name,
        unicode: preferredUnicode(emoji),
        provider: "Emoji" as const,
        providerId: "emoji" as const,
        scope: "global" as const,
        subscriptionOnly: false,
        modifier: false,
        wide: false,
        ownerId: String(id),
      })),
    );
  }, [emojiSupportVersion, skinTone, unicodeEmoji]);

  const allEmotes = useMemo(() => {
    const twitch: PickerEmote[] = twitchEmotes.map((emote) => ({
      key: `twitch:${emote.id}`,
      name: emote.name,
      imageUrl: emoteImageUrl(emote.imageUrl),
      provider: platformLabel,
      providerId: "twitch",
      scope: emote.scope,
      subscriptionOnly: emote.subscriptionOnly,
      modifier: false,
      wide: false,
      ownerId: emote.ownerId,
      ownerName: emote.ownerName,
      ownerImageUrl: emote.ownerImageUrl,
      categoryId: emote.categoryId,
      categoryName: emote.categoryName,
    }));
    const thirdParty: PickerEmote[] = (["7tv", "ffz", "bttv"] as const).map((providerId) => {
      const channelNames = providerChannelEmoteNames.get(providerId) ?? new Set<string>();
      return [...(providerEmotes.get(providerId)?.values() ?? [])].map((emote) => {
        const source = pickerEmoteVariant(emote.variants)?.url ?? "";
        const imageUrl = source ? emoteImageUrl(source) : "";
        const largest = emote.variants.at(-1);
        return {
          key: `${providerId}:${emote.id}`,
          name: emote.name,
          imageUrl,
          provider:
            providerId === "7tv"
              ? "7TV" as const
              : providerId === "ffz"
                ? "FrankerFaceZ" as const
                : "BetterTTV" as const,
          providerId,
          scope: channelNames.has(emote.name)
            ? "channel" as const
            : "global" as const,
          subscriptionOnly: false,
          modifier: Boolean(emote.modifier),
          wide: (largest?.width ?? 0) >= (largest?.height ?? 1) * 1.8,
        };
      });
    }).flat().filter((emote) => emote.imageUrl);
    return {
      twitch,
      thirdParty,
      unicode: unicodePickerEmotes,
      combined: [...thirdParty, ...twitch, ...unicodePickerEmotes],
    };
  }, [platformLabel, providerChannelEmoteNames, providerEmotes, twitchEmotes, unicodePickerEmotes]);

  const sections = useMemo<Section[]>(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery) {
      const selectedEmotes = provider === "favorites"
        ? allEmotes.combined.filter((emote) => favorites.has(emote.key))
        : provider === "emoji"
          ? allEmotes.unicode
          : provider === "twitch"
            ? allEmotes.twitch
            : allEmotes.thirdParty.filter((emote) => emote.providerId === provider);
      const matches = (searchAllProviders ? allEmotes.combined : selectedEmotes).filter((emote) =>
        emote.name.toLowerCase().includes(normalizedQuery),
      );
      const grouped = new Map<string, { label: string; emotes: PickerEmote[] }>();
      for (const emote of matches) {
        const group = searchSectionFor(emote);
        const existing = grouped.get(group.id);
        if (existing) existing.emotes.push(emote);
        else grouped.set(group.id, { label: group.label, emotes: [emote] });
      }
      return [...grouped.entries()].map(([id, group]) => ({
        id: `search-${id}`,
        label: group.label,
        emotes: group.emotes,
      }));
    }
    if (provider === "favorites") {
      return [{
        id: "favorites",
        label: "Favorites",
        emotes: allEmotes.combined.filter((emote) => favorites.has(emote.key)),
      }];
    }
    if (provider === "emoji") {
      return UNICODE_EMOJI_GROUPS.map(({ id, label, icon }) => ({
        id: `emoji-${id}`,
        label,
        glyph: icon,
        scope: "emoji" as const,
        emotes: allEmotes.unicode.filter((emote) => emote.ownerId === String(id)),
      })).filter((section) => section.emotes.length > 0);
    }
    const source = provider === "7tv" || provider === "ffz" || provider === "bttv"
      ? allEmotes.thirdParty.filter((emote) => emote.providerId === provider)
      : provider === "twitch"
        ? allEmotes.twitch
        : [];
    if (provider === "twitch") {
      const grouped = new Map<string, Section>();
      for (const emote of source) {
        const groupId = emote.categoryId
          ? `set-${emote.categoryId}`
          : emote.ownerId
            ? `owner-${emote.ownerId}`
            : emote.scope === "global"
              ? "global"
              : "channel";
        const existing = grouped.get(groupId);
        if (existing) {
          existing.emotes.push(emote);
          continue;
        }
        grouped.set(groupId, {
          id: `twitch-${groupId}`,
          label:
            emote.categoryName ??
            emote.ownerName ??
            (emote.scope === "global"
              ? "Global emotes"
              : groupId === "channel"
                ? channelName
                : "Twitch emotes"),
          scope: emote.categoryId ? "twitch-set" : emote.scope,
          avatarUrl: emote.categoryId ? emote.imageUrl : emote.ownerImageUrl,
          emotes: [emote],
        });
      }
      return [...grouped.values()];
    }
    const providerSections: Section[] = [
      {
        id: `${provider}-channel`,
        label: channelName || "Channel emotes",
        scope: "channel",
        emotes: source.filter((emote) => !emote.modifier && emote.scope === "channel"),
      },
      {
        id: `${provider}-global`,
        label: "Global emotes",
        scope: "global",
        emotes: source.filter((emote) => !emote.modifier && emote.scope === "global"),
      },
      {
        id: `${provider}-effects`,
        label: "Effects",
        scope: "effect",
        emotes: source.filter((emote) => emote.modifier),
      },
    ];
    return providerSections.filter(
      (section) => section.scope !== "effect" || section.emotes.length > 0,
    );
  }, [allEmotes, channelName, favorites, provider, query, searchAllProviders]);

  useEffect(() => {
    if (provider !== "emoji" || query.trim()) return;
    const root = scrollHost.current;
    const emojiSections = sections.filter((section) => section.scope === "emoji");
    if (!root || typeof IntersectionObserver !== "function") {
      void Promise.resolve().then(() => {
        setVisibleEmojiSections(new Set(emojiSections.map((section) => section.id)));
      });
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      setVisibleEmojiSections((current) => {
        const next = new Set(current);
        let changed = false;
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.sectionId;
          if (!id) continue;
          if (!entry.isIntersecting && entry.boundingClientRect.height > 0) {
            const measuredHeight = entry.boundingClientRect.height;
            setEmojiSectionHeights((current) => {
              if (Math.abs((current.get(id) ?? 0) - measuredHeight) < 1) return current;
              const next = new Map(current);
              next.set(id, measuredHeight);
              return next;
            });
          }
          if (entry.isIntersecting && !next.has(id)) {
            next.add(id);
            changed = true;
          } else if (!entry.isIntersecting && next.delete(id)) {
            changed = true;
          }
        }
        return changed ? next : current;
      });
    }, {
      root,
      // Mount the next category before it scrolls into view, but keep distant
      // grids out of React's DOM and layout work.
      rootMargin: "320px 0px",
    });
    for (const section of emojiSections) {
      const node = sectionHosts.current.get(section.id);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [provider, query, sections]);

  function estimatedEmojiSectionHeight(emoteCount: number): number {
    const availableWidth = Math.max(43, size.width - 86);
    const columns = Math.max(1, Math.floor((availableWidth + 4) / 47));
    const rows = Math.max(1, Math.ceil(emoteCount / columns));
    return 52 + rows * 47;
  }

  function toggleFavorite(emote: PickerEmote) {
    const next = new Set(favorites);
    if (next.has(emote.key)) next.delete(emote.key);
    else next.add(emote.key);
    setFavorites(next);
    void window.desktop.preferences
      .update({ emoteFavorites: [...next] })
      .catch(() => undefined);
  }

  function handleEmoteClick(event: React.MouseEvent, emote: PickerEmote) {
    if (event.altKey) {
      toggleFavorite(emote);
      return;
    }
    if (emote.unicode) {
      void unicodeEmojiDatabase()?.incrementFavoriteEmojiCount(emote.unicode).catch(() => undefined);
    }
    onSelect(emote.unicode ?? emote.name);
    if (!emote.modifier && !event.ctrlKey) onClose();
  }

  function beginResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = size;
    const maximumWidth = Math.max(330, Math.min(600, window.innerWidth - 20));
    const maximumHeight = Math.max(360, Math.min(700, window.innerHeight - 90));
    event.currentTarget.setPointerCapture(event.pointerId);
    resizing.current = true;
    const move = (moveEvent: PointerEvent) => {
      const next = {
        width: Math.min(
          Math.max(startSize.width + startX - moveEvent.clientX, 330),
          maximumWidth,
        ),
        height: Math.min(
          Math.max(startSize.height + startY - moveEvent.clientY, 360),
          maximumHeight,
        ),
      };
      setEmojiSectionHeights((current) => current.size > 0 ? new Map() : current);
      setSize(next);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      resizing.current = false;
      setSize((current) => {
        cachedPickerSize = { width: current.width, height: current.height };
        void window.desktop.preferences
          .update({
            emotePickerWidth: Math.round(current.width),
            emotePickerHeight: Math.round(current.height),
          })
          .catch(() => undefined);
        return current;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  function jumpTo(sectionId: string) {
    sectionHosts.current.get(sectionId)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  function setPreferredSkinTone(nextSkinTone: SkinTone) {
    rememberUnicodeSkinTone(nextSkinTone);
    setSkinTone(nextSkinTone);
    setSkinTonePickerOpen(false);
    void unicodeEmojiDatabase()?.setPreferredSkinTone(nextSkinTone).catch(() => undefined);
  }

  const providers: Array<{
    id: Provider;
    icon?: LucideIcon;
    logo?: ProviderLogoName;
    mark: string;
    disabled?: boolean;
  }> = [
    { id: "favorites", icon: Star, mark: "" },
    { id: "7tv", logo: "7tv", mark: "7TV" },
    ...(platformLabel === "Kick"
      ? []
      : ([
          { id: "ffz", logo: "ffz", mark: "FFZ" },
          { id: "bttv", logo: "bttv", mark: "BTTV" },
        ] as const)),
    {
      id: "twitch",
      logo: platformLabel === "Kick" ? ("kick" as const) : ("twitch" as const),
      mark: platformLabel,
    },
    { id: "emoji", icon: Smile, mark: "" },
  ];

  return (
    <div
      className="vw-emote-picker"
      style={{
        width: size.width,
        height: size.height,
      }}
    >
      <button
        aria-label="Resize emote picker"
        className="vw-emote-resize"
        onPointerDown={beginResize}
        title="Drag to resize"
        type="button"
      >
        <MoveDiagonal2 size={13} />
      </button>

      <div className="vw-emote-body">
        <div className="vw-emote-scroll" ref={scrollHost}>
            {sections.map((section, sectionIndex) => {
              const virtualized = provider === "emoji" && !query.trim() && section.scope === "emoji";
              const renderGrid = !virtualized || visibleEmojiSections.has(section.id);
              return (
              <section
                className={`vw-emote-section${virtualized ? " virtualized" : ""}`}
                data-section-id={section.id}
                key={section.id}
                style={virtualized && !renderGrid
                  ? {
                      minHeight: emojiSectionHeights.get(section.id) ??
                        estimatedEmojiSectionHeight(section.emotes.length),
                    }
                  : undefined}
                ref={(node) => {
                  if (node) sectionHosts.current.set(section.id, node);
                  else sectionHosts.current.delete(section.id);
                }}
              >
                <header>
                  <strong>{section.label}</strong>
                  <span>{section.emotes.length}</span>
                </header>
                {renderGrid && <div className="vw-emote-grid">
                  {section.emotes.map((emote, index) => (
                    <button
                      aria-label={`${emote.name}, ${emote.provider}${favorites.has(emote.key) ? ", favorited" : ""}`}
                      className={[
                        emote.wide ? "wide" : "",
                        emote.modifier ? "effect" : "",
                        emote.subscriptionOnly ? "subscription-only" : "",
                        favorites.has(emote.key) ? "favorite" : "",
                      ].filter(Boolean).join(" ")}
                      key={emote.key}
                      onClick={(event) => handleEmoteClick(event, emote)}
                      title={
                        emote.modifier
                          ? `${emote.name} · ${emote.provider} effect · Applies to an adjacent emote`
                          : `${emote.name}  ·  ${emote.provider}\nCtrl-Click  ·  Keep open\nAlt-Click  ·  ${favorites.has(emote.key) ? "Unfavorite" : "Favorite"}`
                      }
                      type="button"
                    >
                      {emote.modifier ? (
                        <span className="effect-mark">
                          <Sparkles size={14} />
                          <small>{emote.name}</small>
                        </span>
                      ) : emote.unicode ? (
                        <CountryFlagEmoji className="native-emoji" unicode={emote.unicode} />
                      ) : (
                        <img
                          alt=""
                          decoding="async"
                          fetchPriority={sectionIndex === 0 && index < 24 ? "high" : "auto"}
                          loading={sectionIndex === 0 && index < 24 ? "eager" : "lazy"}
                          src={emote.imageUrl}
                        />
                      )}
                      {favorites.has(emote.key) && <Star className="favorite-mark" size={10} />}
                    </button>
                  ))}
                  {section.emotes.length === 0 && (
                    <span className="vw-emote-empty">
                      {section.id === "favorites"
                        ? "Alt-click an emote to add it here."
                        : "No emotes in this section."}
                    </span>
                  )}
                </div>}
              </section>
              );
            })}
        </div>

        {!query.trim() && sections.some((section) => section.scope) && (
          <nav aria-label="Emote sections" className="vw-emote-rail">
            {sections.filter((section) => section.scope).map((section) => (
              <button
                aria-label={`Go to ${section.label}`}
                key={section.id}
                onClick={() => jumpTo(section.id)}
                title={section.label}
                type="button"
              >
                {section.scope === "emoji" ? (
                  <span className="vw-emote-emoji-rail-mark">{section.glyph}</span>
                ) : section.scope === "twitch-set" && section.avatarUrl ? (
                  <img alt="" src={section.avatarUrl} />
                ) : section.scope === "channel" && (section.avatarUrl || channelAvatarUrl) ? (
                  <img alt="" src={section.avatarUrl ?? channelAvatarUrl} />
                ) : section.scope === "channel" ? (
                  <span>{section.label.slice(0, 1).toUpperCase()}</span>
                ) : section.scope === "effect" ? (
                  <Sparkles size={18} />
                ) : (
                  <Globe2 size={18} />
                )}
              </button>
            ))}
          </nav>
        )}
      </div>

        {provider === "emoji" && unicodeLoading && (
          <div className="vw-emote-loading">Loading native emoji…</div>
        )}
        {provider === "emoji" && unicodeLoadFailed && (
          <div className="vw-emote-loading">Native emoji could not load. Check your connection and try again.</div>
        )}

      <nav aria-label="Emote providers" className="vw-emote-providers">
        {providers.map((item) => {
          const tabName = item.id === "twitch" ? platformLabel : providerLabel(item.id);
          return (
          <button
            aria-label={`${tabName}${item.disabled ? " (coming soon)" : ""}`}
            aria-pressed={provider === item.id}
            className={provider === item.id ? "active" : ""}
            disabled={item.disabled}
            key={item.id}
            onClick={() => {
              setProvider(item.id);
              if (item.id === "emoji") setUnicodeLoadFailed(false);
              setQuery("");
              scrollHost.current?.scrollTo({ top: 0 });
            }}
            title={`${tabName}${item.disabled ? " · Coming soon" : ""}`}
            type="button"
          >
            <ProviderMark icon={item.icon} label={item.mark} logo={item.logo} />
          </button>
          );
        })}
      </nav>

      <div className="vw-emote-search">
        <Search size={17} />
        <input
          aria-label={searchAllProviders ? "Search all available emotes" : `Search ${provider === "twitch" ? platformLabel : providerLabel(provider)} emotes`}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search emotes…"
          value={query}
        />
        <button
          aria-label={searchAllProviders ? "Search selected provider only" : "Search all emote providers"}
          aria-pressed={searchAllProviders}
          className={searchAllProviders ? "active" : ""}
          onClick={() => {
            const next = !searchAllProviders;
            setSearchAllProviders(next);
            void window.desktop.preferences
              .update({ emoteSearchAllProviders: next })
              .catch(() => undefined);
          }}
          title={searchAllProviders ? "Searching all providers" : "Search all providers"}
          type="button"
        >
          <Globe2 size={16} />
        </button>
      </div>

      {provider === "emoji" && (
        <>
          <button
            aria-expanded={skinTonePickerOpen}
            aria-label="Choose emoji skin tone"
            className="vw-emoji-tone-trigger"
            onClick={() => setSkinTonePickerOpen((open) => !open)}
            title="Choose emoji skin tone"
            type="button"
          >
            {skinTone === 0 ? <Palette size={15} /> : ["🏻", "🏼", "🏽", "🏾", "🏿"][skinTone - 1]}
          </button>
          {skinTonePickerOpen && (
            <div className="vw-emoji-tone-popover" aria-label="Preferred skin tone">
              {([0, 1, 2, 3, 4, 5] as SkinTone[]).map((tone) => (
                <button
                  aria-label={tone === 0 ? "Default skin tone" : `Skin tone ${tone}`}
                  aria-pressed={skinTone === tone}
                  className={skinTone === tone ? "active" : ""}
                  key={tone}
                  onClick={() => setPreferredSkinTone(tone)}
                  type="button"
                >
                  {tone === 0 ? "👋" : ["🏻", "🏼", "🏽", "🏾", "🏿"][tone - 1]}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
