import type { EmoteProvider } from "../../shared/emotes";
import { ProviderLogo, type ProviderLogoName } from "./ProviderLogo";

type ChatEmoteProvider = EmoteProvider | "twitch";

interface ChatEmoteProps {
  className: string;
  imageUrl: string;
  name: string;
  provider: ChatEmoteProvider;
}

const providerLabels: Record<ChatEmoteProvider, string> = {
  "7tv": "7TV",
  ffz: "FrankerFaceZ",
  bttv: "BetterTTV",
  twitch: "Twitch",
};

export function ChatEmote({
  className,
  imageUrl,
  name,
  provider,
}: ChatEmoteProps) {
  const host = useRef<HTMLSpanElement>(null);
  const [tooltip, setTooltip] = useState<{
    above: boolean;
    left: number;
    top: number;
  } | null>(null);

  function showTooltip() {
    const bounds = host.current?.getBoundingClientRect();
    if (!bounds) return;
    const above = bounds.top >= 155;
    setTooltip({
      above,
      left: Math.min(Math.max(bounds.left + bounds.width / 2, 82), window.innerWidth - 82),
      top: above ? bounds.top - 8 : bounds.bottom + 8,
    });
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
        loading="lazy"
        src={imageUrl}
      />
      {tooltip &&
        createPortal(
          <span
            className={`chat-emote-tooltip ${tooltip.above ? "above" : "below"}`}
            role="tooltip"
            style={{ left: tooltip.left, top: tooltip.top }}
          >
            <img alt="" decoding="async" src={imageUrl} />
            <strong>{name}</strong>
            <span>
              <ProviderLogo name={provider as ProviderLogoName} />
              {providerLabels[provider]}
            </span>
          </span>,
          document.body,
        )}
    </span>
  );
}
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
