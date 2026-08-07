import type { EmoteProvider } from "../../shared/emotes";
import { holdEmoteWarming } from "./emote-preload";
import { ProviderLogo, type ProviderLogoName } from "./ProviderLogo";

type ChatEmoteProvider = EmoteProvider | "twitch" | "kick";

interface ChatEmoteProps {
  className: string;
  imageUrl: string;
  logicalHeight?: number;
  name: string;
  provider: ChatEmoteProvider;
  /**
   * Width over height, so the space the emote will occupy can be held open
   * while its image is on the way. Without it the image has no width until it
   * arrives, and a message of nothing but emotes shows as an empty line.
   */
  aspectRatio?: number;
}

const providerLabels: Record<ChatEmoteProvider, string> = {
  "7tv": "7TV",
  ffz: "FrankerFaceZ",
  bttv: "BetterTTV",
  twitch: "Twitch",
  kick: "Kick",
};

export function ChatEmote({
  className,
  imageUrl,
  logicalHeight,
  name,
  provider,
  aspectRatio,
}: ChatEmoteProps) {
  const host = useRef<HTMLSpanElement>(null);
  const retries = useRef(0);
  const [tooltip, setTooltip] = useState<{
    above: boolean;
    left: number;
    top: number;
    imageHeight: number;
    /** The document to draw in, noted when the preview is raised. */
    root: Document;
  } | null>(null);

  function showTooltip() {
    const bounds = host.current?.getBoundingClientRect();
    if (!bounds) return;
    // Measured against the window the emote is in. Chat can be rendered into a
    // window of its own, and clamping to this window's width would place the
    // preview outside a narrower one.
    const view = host.current?.ownerDocument.defaultView ?? window;
    const above = bounds.top >= 155;
    // Preview the emote at ~2.2x its rendered size so details are readable;
    // measured live because the chat emote size is user-configurable.
    const renderedHeight =
      host.current?.querySelector("img")?.getBoundingClientRect().height ?? 27;
    setTooltip({
      above,
      left: Math.min(Math.max(bounds.left + bounds.width / 2, 82), view.innerWidth - 82),
      top: above ? bounds.top - 8 : bounds.bottom + 8,
      imageHeight: Math.min(150, Math.round(renderedHeight * 2.2)),
      root: host.current?.ownerDocument ?? document,
    });
  }

  // A request that fails leaves a hole in the message for as long as it is on
  // screen, because nothing ever asks again. Two quiet retries cover the
  // stumbles — a connection dropped mid-fetch, a moment of the host refusing —
  // after which the emote's name is shown instead of nothing at all.
  function retryImage(event: SyntheticEvent<HTMLImageElement>) {
    const image = event.currentTarget;
    if (retries.current >= 2) {
      image.classList.add("failed");
      return;
    }
    const delay = 500 * 2 ** retries.current;
    retries.current += 1;
    const view = image.ownerDocument.defaultView ?? window;
    view.setTimeout(() => {
      if (!image.isConnected) return;
      image.removeAttribute("src");
      image.src = imageUrl;
    }, delay);
  }

  return (
    <span
      className="chat-emote-hover"
      onBlur={() => setTooltip(null)}
      onFocus={showTooltip}
      onMouseEnter={showTooltip}
      onMouseLeave={() => setTooltip(null)}
      ref={host}
      tabIndex={0}
    >
      <img
        alt={name}
        className={className}
        decoding="async"
        // An emote is only ever rendered into a message that is on screen or
        // about to be, and a missing one leaves a hole in the sentence. Lazy
        // loading held these back until the row had all but arrived, so
        // messages landed with gaps in them; they are fetched at once instead,
        // ahead of everything else the app is pulling in the background.
        fetchPriority="high"
        loading="eager"
        onError={retryImage}
        onLoad={(event) => {
          event.currentTarget.classList.add("loaded");
          holdEmoteWarming();
        }}
        ref={(node) => {
          if (!node) return;
          // Nothing to wait for once it is cached — mark it settled straight
          // away so it never flashes a placeholder. When there is something to
          // wait for, background warming stands aside until it has landed.
          if (node.complete && node.naturalWidth > 0) node.classList.add("loaded");
          else holdEmoteWarming();
        }}
        src={imageUrl}
        style={{
          ...(logicalHeight
            ? {
                height: `calc(var(--chat-emote-size, 27px) * ${Math.min(
                  1,
                  logicalHeight / (provider === "bttv" ? 28 : 32),
                )})`,
              }
            : {}),
          // Applies only until the image lands, after which the emote's own
          // proportions take over — so a guessed ratio can never squash one.
          "--emote-ratio": aspectRatio && aspectRatio > 0 ? aspectRatio : 1,
        } as CSSProperties}
      />
      {tooltip &&
        createPortal(
          <span
            className={`chat-emote-tooltip ${tooltip.above ? "above" : "below"}`}
            role="tooltip"
            style={{ left: tooltip.left, top: tooltip.top }}
          >
            <img
              alt=""
              decoding="async"
              src={imageUrl}
              style={{ height: tooltip.imageHeight }}
            />
            <strong>{name}</strong>
            <span>
              <ProviderLogo name={provider as ProviderLogoName} />
              {providerLabels[provider]}
            </span>
          </span>,
          tooltip.root.body,
        )}
    </span>
  );
}
import {
  useRef,
  useState,
  type CSSProperties,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
