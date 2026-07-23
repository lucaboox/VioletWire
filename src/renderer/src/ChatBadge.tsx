import { useMemo, useState } from "react";
import type { ChatBadgeAsset } from "../../shared/chat";
import { KickBadgeGlyph } from "./KickBadgeGlyph";

interface ChatBadgeProps {
  badge: ChatBadgeAsset;
  loading?: "eager" | "lazy";
}

export function ChatBadge({ badge, loading = "lazy" }: ChatBadgeProps) {
  const urls = useMemo(
    () => [...new Set([...(badge.imageUrls ?? []), badge.imageUrl].filter(Boolean))],
    [badge.imageUrl, badge.imageUrls],
  );
  const [urlIndex, setUrlIndex] = useState(0);

  const source = urls[urlIndex];
  if (!source) {
    // Kick's built-in badges are drawn from their own artwork.
    if (badge.glyph) {
      return <KickBadgeGlyph glyph={badge.glyph} title={badge.title} />;
    }
    // A text-only badge with no glyph renders as a small coloured chip.
    if (badge.label) {
      return (
        <span
          className="chat-text-badge"
          style={{ backgroundColor: badge.color ?? "#7a7a85" }}
          title={badge.title}
        >
          {badge.label}
        </span>
      );
    }
    return null;
  }

  return (
    <img
      alt={badge.title}
      // Hovering shows the badge enlarged to ~2.2x its 18px rendered size so
      // small badges are recognizable.
      data-violetwire-tooltip-image={source}
      data-violetwire-tooltip-image-height={40}
      loading={loading}
      onError={() => setUrlIndex((current) => current + 1)}
      src={source}
      title={badge.title}
    />
  );
}
