import { useMemo, useState } from "react";
import type { ChatBadgeAsset } from "../../shared/chat";

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
  if (!source) return null;

  return (
    <img
      alt={badge.title}
      loading={loading}
      onError={() => setUrlIndex((current) => current + 1)}
      src={source}
      title={badge.title}
    />
  );
}
