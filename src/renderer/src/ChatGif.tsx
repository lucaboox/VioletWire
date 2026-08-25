import { useState } from "react";

import { usePreference } from "./use-preference";
import "./chat-gif.css";

interface ChatGifProps {
  /**
   * What the message says in the GIF's place — "[Happy Lets Go GIF by NHL]" —
   * which is what Twitch sends for anything that cannot draw the picture. It
   * stands in while the image loads and remains if it never does.
   */
  description: string;
  imageUrl: string;
}

/** The description without the brackets Twitch wraps it in. */
function readableDescription(description: string): string {
  return description.replace(/^\[/, "").replace(/\]$/, "").trim();
}

/**
 * A GIF sent by a higher-tier subscriber.
 *
 * Drawn far larger than an emote, since it is the message rather than
 * punctuation within one, and bounded so one cannot take over the panel. The
 * address is used exactly as Twitch sends it: they ask that it not be modified,
 * so it is not resized, proxied, or kept in the emote store — these are watched
 * once and are many times the size of any emote.
 */
export function ChatGif({ description, imageUrl }: ChatGifProps) {
  const [failed, setFailed] = useState(false);
  const showGifs = usePreference((preferences) => preferences.chatShowGifs);
  const label = readableDescription(description);

  if (!showGifs || failed) {
    return <span className="chat-gif-fallback">{description}</span>;
  }

  return (
    <span className="chat-gif" title={label}>
      <img
        alt={label}
        decoding="async"
        loading="lazy"
        onError={() => setFailed(true)}
        onLoad={(event) => event.currentTarget.parentElement?.classList.add("loaded")}
        src={imageUrl}
      />
    </span>
  );
}
