import {
  Globe2,
  MoveDiagonal2,
  Search,
  Sparkles,
  Star,
  type LucideIcon,
} from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { TwitchPickerEmote } from "../../shared/chat";
import type {
  EmoteProvider,
  ProviderEmote,
} from "../../shared/emotes";
import "./emote-picker.css";
import {
  ProviderLogo,
  type ProviderLogoName,
} from "./ProviderLogo";

type Provider = "favorites" | "7tv" | "twitch" | "ffz" | "bttv";

interface PickerEmote {
  key: string;
  name: string;
  imageUrl: string;
  provider: "7TV" | "FrankerFaceZ" | "BetterTTV" | "Twitch";
  providerId: EmoteProvider | "twitch";
  scope: "channel" | "global";
  subscriptionOnly: boolean;
  modifier: boolean;
  wide: boolean;
  ownerId?: string;
  ownerName?: string;
  ownerImageUrl?: string;
}

interface EmotePickerProps {
  channelAvatarUrl?: string;
  channelName: string;
  onClose(): void;
  onSelect(name: string): void;
  providerChannelEmoteNames: Map<EmoteProvider, Set<string>>;
  providerEmotes: Map<EmoteProvider, Map<string, ProviderEmote>>;
  twitchEmotes: TwitchPickerEmote[];
}

interface Section {
  id: string;
  label: string;
  emotes: PickerEmote[];
  scope?: "channel" | "global" | "effect";
  avatarUrl?: string;
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

function providerLabel(provider: Provider): string {
  if (provider === "favorites") return "Favorites";
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

export function EmotePicker({
  channelAvatarUrl,
  channelName,
  onClose,
  onSelect,
  providerChannelEmoteNames,
  providerEmotes,
  twitchEmotes,
}: EmotePickerProps) {
  const [provider, setProvider] = useState<Provider>("7tv");
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState(readFavorites);
  const [size, setSize] = useState(() => clampSize(readSize()));
  const scrollHost = useRef<HTMLDivElement>(null);
  const sectionHosts = useRef(new Map<string, HTMLElement>());

  const allEmotes = useMemo(() => {
    const twitch: PickerEmote[] = twitchEmotes.map((emote) => ({
      key: `twitch:${emote.id}`,
      name: emote.name,
      imageUrl: emote.imageUrl,
      provider: "Twitch",
      providerId: "twitch",
      scope: emote.scope,
      subscriptionOnly: emote.subscriptionOnly,
      modifier: false,
      wide: false,
      ownerId: emote.ownerId,
      ownerName: emote.ownerName,
      ownerImageUrl: emote.ownerImageUrl,
    }));
    const thirdParty: PickerEmote[] = (["7tv", "ffz", "bttv"] as const).map((providerId) => {
      const channelNames = providerChannelEmoteNames.get(providerId) ?? new Set<string>();
      return [...(providerEmotes.get(providerId)?.values() ?? [])].map((emote) => {
        const imageUrl =
          emote.variants.find((variant) => variant.scale === 2)?.url ??
          emote.variants.at(-1)?.url ??
          "";
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
      combined: [...thirdParty, ...twitch],
    };
  }, [providerChannelEmoteNames, providerEmotes, twitchEmotes]);

  const sections = useMemo<Section[]>(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery) {
      return [{
        id: "search-results",
        label: "Search results",
        emotes: allEmotes.combined.filter((emote) =>
          emote.name.toLowerCase().includes(normalizedQuery),
        ),
      }];
    }
    if (provider === "favorites") {
      return [{
        id: "favorites",
        label: "Favorites",
        emotes: allEmotes.combined.filter((emote) => favorites.has(emote.key)),
      }];
    }
    const source = provider === "7tv" || provider === "ffz" || provider === "bttv"
      ? allEmotes.thirdParty.filter((emote) => emote.providerId === provider)
      : provider === "twitch"
        ? allEmotes.twitch
        : [];
    if (provider === "twitch") {
      const grouped = new Map<string, Section>();
      for (const emote of source) {
        const groupId = emote.scope === "global"
          ? "global"
          : emote.ownerId ?? "channel";
        const existing = grouped.get(groupId);
        if (existing) {
          existing.emotes.push(emote);
          continue;
        }
        grouped.set(groupId, {
          id: `twitch-${groupId}`,
          label: emote.scope === "global"
            ? "Global emotes"
            : emote.ownerName ?? (groupId === "channel" ? channelName : "Twitch emotes"),
          scope: emote.scope,
          avatarUrl: emote.ownerImageUrl,
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
  }, [allEmotes, channelName, favorites, provider, query]);

  function toggleFavorite(emote: PickerEmote) {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(emote.key)) next.delete(emote.key);
      else next.add(emote.key);
      window.localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  function handleEmoteClick(event: React.MouseEvent, emote: PickerEmote) {
    if (event.altKey) {
      toggleFavorite(emote);
      return;
    }
    onSelect(emote.name);
    if (!emote.modifier) onClose();
  }

  function beginResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = size;
    const maximumWidth = Math.max(330, Math.min(600, window.innerWidth - 20));
    const maximumHeight = Math.max(360, Math.min(700, window.innerHeight - 90));
    event.currentTarget.setPointerCapture(event.pointerId);
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
      setSize(next);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      setSize((current) => {
        window.localStorage.setItem(SIZE_KEY, JSON.stringify(current));
        return current;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  function jumpTo(sectionId: string) {
    sectionHosts.current.get(sectionId)?.scrollIntoView({ block: "start", behavior: "smooth" });
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
    { id: "ffz", logo: "ffz", mark: "FFZ" },
    { id: "bttv", logo: "bttv", mark: "BTTV" },
    { id: "twitch", logo: "twitch", mark: "Twitch" },
  ];

  return (
    <div
      className="vw-emote-picker"
      style={{ width: size.width, height: size.height }}
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
          {sections.map((section) => (
              <section
                className="vw-emote-section"
                key={section.id}
                ref={(node) => {
                  if (node) sectionHosts.current.set(section.id, node);
                  else sectionHosts.current.delete(section.id);
                }}
              >
                <header>
                  <strong>{section.label}</strong>
                  <span>{section.emotes.length}</span>
                </header>
                <div className="vw-emote-grid">
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
                          : `${emote.name} · ${emote.provider} · Alt-click to ${favorites.has(emote.key) ? "unfavorite" : "favorite"}`
                      }
                      type="button"
                    >
                      {emote.modifier ? (
                        <span className="effect-mark">
                          <Sparkles size={14} />
                          <small>{emote.name}</small>
                        </span>
                      ) : (
                        <img
                          alt=""
                          decoding="async"
                          fetchPriority={index < 24 ? "high" : "auto"}
                          loading="eager"
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
                </div>
              </section>
            ))}
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
                {section.scope === "channel" && (section.avatarUrl || channelAvatarUrl) ? (
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

      <nav aria-label="Emote providers" className="vw-emote-providers">
        {providers.map((item) => (
          <button
            aria-label={`${providerLabel(item.id)}${item.disabled ? " (coming soon)" : ""}`}
            aria-pressed={provider === item.id}
            className={provider === item.id ? "active" : ""}
            disabled={item.disabled}
            key={item.id}
            onClick={() => {
              setProvider(item.id);
              setQuery("");
              scrollHost.current?.scrollTo({ top: 0 });
            }}
            title={`${providerLabel(item.id)}${item.disabled ? " · Coming soon" : ""}`}
            type="button"
          >
            <ProviderMark icon={item.icon} label={item.mark} logo={item.logo} />
          </button>
        ))}
      </nav>

      <label className="vw-emote-search">
        <Search size={17} />
        <input
          aria-label="Search all available emotes"
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search emotes…"
          value={query}
        />
      </label>
    </div>
  );
}
