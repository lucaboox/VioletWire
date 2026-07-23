import { useId } from "react";
import type { KickGlyphBadge } from "../../shared/chat";

/**
 * Kick's built-in chat badges are inline SVGs its API never exposes as images,
 * so they are drawn here from Kick's own artwork. To add one: paste its raw
 * `<svg>…</svg>` markup below, keyed by the badge type, and list the type in
 * KICK_GLYPH_BADGE_TYPES (shared/chat) — the map is typed against that list, so
 * the build fails until both sides agree.
 *
 * The source markup keeps whatever gradient/clip ids Kick shipped. Those are
 * reused across many chat messages, and duplicate ids in one document collide —
 * worse, a stable id breaks the moment the message that first defined it scrolls
 * out and unmounts. So every id is rewritten per instance at render time.
 */

// The moderator and vip glyphs stack the same rounded-square container path
// three (mod) or two (vip) times under different gradients, the way Kick does.
const CONTAINER =
  "M30 0C31.1046 0 32 0.895431 32 2V30C32 31.1046 31.1046 32 30 32H2C0.895431 32 0 31.1046 0 30V2C0 0.895431 0.895431 0 2 0H30Z";
const MOD_MARK =
  "M16.2197 2.99316C15.8292 2.60266 15.1962 2.60265 14.8057 2.99316L8.36328 9.43555C7.97294 9.82608 7.97284 10.4591 8.36328 10.8496L10.0918 12.5781C10.4823 12.9686 11.1153 12.9685 11.5059 12.5781L11.585 12.499L13.9414 14.8564L3.57129 25.2275C2.70357 26.0954 2.7035 27.5023 3.57129 28.3701C4.43911 29.2376 5.84612 29.2377 6.71387 28.3701L17.084 17.999L19.4414 20.3564L19.3633 20.4346C18.9728 20.8251 18.9728 21.4581 19.3633 21.8486L21.0918 23.5771C21.4823 23.9676 22.1154 23.9676 22.5059 23.5771L28.9482 17.1348C29.3386 16.7443 29.3386 16.1112 28.9482 15.7207L27.2197 13.9922C26.8293 13.6017 26.1962 13.6018 25.8057 13.9922L25.7266 14.0703L23.3701 11.7139C24.2377 10.8461 24.2376 9.4391 23.3701 8.57129C22.5023 7.7035 21.0954 7.70357 20.2275 8.57129L17.8701 6.21387L17.9482 6.13574C18.3388 5.74522 18.3388 5.11221 17.9482 4.72168L16.2197 2.99316Z";
const MOD_PATH = `${CONTAINER}${MOD_MARK}`;

const KICK_BADGE_SVG: Record<KickGlyphBadge, string> = {
  verified: `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#c)"><path d="M30.8598 19.2368C30.1977 18.2069 29.5356 17.2138 28.8736 16.1839C28.7264 15.9632 28.7264 15.8161 28.8736 15.5954C29.5356 14.6023 30.1609 13.6092 30.823 12.6161C31.5954 11.4391 31.1908 10.2989 29.8667 9.82069C28.7632 9.41609 27.6598 8.97471 26.5563 8.57012C26.3356 8.49656 26.2253 8.34943 26.2253 8.09196C26.1885 6.87816 26.1149 5.66437 26.0414 4.48736C25.9678 3.2 24.9747 2.46437 23.7241 2.7954C22.5471 3.08966 21.3701 3.42069 20.2299 3.75173C19.9724 3.82529 19.8253 3.75173 19.6414 3.56782C18.9057 2.61149 18.1333 1.69195 17.3977 0.772414C16.5885 -0.257472 15.3379 -0.257472 14.492 0.772414C13.7563 1.69195 12.9839 2.61149 12.2851 3.53103C12.1012 3.7885 11.9172 3.82529 11.623 3.75173C10.4828 3.42069 9.34253 3.12644 8.53334 2.90575C6.95173 2.53793 5.99541 3.16322 5.92184 4.48736C5.84828 5.70115 5.77472 6.91495 5.73794 8.16552C5.73794 8.42299 5.62759 8.53333 5.4069 8.64368C4.26667 9.08506 3.12644 9.52644 1.98621 9.96782C0.809203 10.446 0.441387 11.5862 1.14023 12.6529C1.8023 13.6828 2.46437 14.6759 3.12644 15.7057C3.27356 15.9264 3.27356 16.0736 3.12644 16.331C2.42759 17.3609 1.76552 18.3908 1.10345 19.4575C0.478165 20.4506 0.882759 21.6276 1.98621 22.069C3.12644 22.5104 4.30345 22.9517 5.44368 23.3931C5.70115 23.4667 5.77471 23.6138 5.77471 23.8713C5.81149 25.0483 5.95862 26.1885 5.95862 27.3655C5.95862 28.5425 6.9885 29.6092 8.42298 29.1678C9.56321 28.8 10.7034 28.5425 11.8437 28.2115C12.0644 28.1379 12.2115 28.1747 12.3586 28.3954C13.131 29.3517 13.8667 30.2713 14.6391 31.2276C15.485 32.2575 16.6988 32.2575 17.508 31.2276C18.2805 30.2713 19.0161 29.3517 19.7885 28.3954C19.9356 28.2115 20.046 28.1379 20.3034 28.2115C21.4804 28.5425 22.6575 28.8368 23.8345 29.1678C25.0483 29.4988 26.0781 28.7632 26.1149 27.5126C26.1885 26.2989 26.2621 25.0851 26.2988 23.8345C26.2988 23.5402 26.446 23.4299 26.6667 23.3563C27.7701 22.9517 28.9103 22.5104 30.0138 22.069C31.1908 21.4805 31.5586 20.3034 30.8598 19.2368ZM22.069 13.2046L14.7127 20.5609C14.5287 20.7448 14.2713 20.892 14.0138 20.9287C13.9402 20.9287 13.8299 20.9655 13.7563 20.9655C13.4253 20.9655 13.0575 20.8184 12.8 20.5609L9.78392 17.5448C9.26898 17.0299 9.26898 16.1839 9.78392 15.669C10.2989 15.154 11.1448 15.154 11.6598 15.669L13.7196 17.7287L20.1196 11.3287C20.6345 10.8138 21.4805 10.8138 21.9954 11.3287C22.5839 11.8437 22.5839 12.6897 22.069 13.2046Z" fill="url(#g)"/></g><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="8.14138" x2="24.4968" y1="32.3591" y2="0.904884"><stop stop-color="#1EFF00"/><stop offset="0.99" stop-color="#00FF8C"/></linearGradient><clipPath id="c"><rect width="32" height="32" fill="#fff"/></clipPath></defs></svg>`,

  sub_gifter: `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#c)"><path d="M22.34 9.5L26 4H18L16 7L14 4H6L9.66 9.5H4V15.1H28V9.5H22.34Z" fill="#2EFAD1"/><path d="M26.08 19.1001H5.90002V28.5001H26.08V19.1001Z" fill="#2EFAD1"/><path d="M26.08 15.1001H5.90002V19.1001H26.08V15.1001Z" fill="#00A18D"/></g><defs><clipPath id="c"><rect width="24" height="24.5" fill="#fff" transform="translate(4 4)"/></clipPath></defs></svg>`,

  moderator: `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#c)"><path d="${MOD_PATH}" fill="url(#a)"/><path d="${MOD_PATH}" fill="url(#b)"/><path d="${MOD_PATH}" fill="url(#d)"/></g><defs><linearGradient id="a" gradientUnits="userSpaceOnUse" x1="18.8102" x2="2.88536" y1="-12.7222" y2="39.1063"><stop stop-color="#FF6A4A"/><stop offset="1" stop-color="#C70C00"/></linearGradient><linearGradient id="b" gradientUnits="userSpaceOnUse" x1="15.7467" x2="16.321" y1="-4.75575" y2="39.0672"><stop stop-color="#FFC900"/><stop offset="0.99" stop-color="#FF9500"/></linearGradient><linearGradient id="d" gradientUnits="userSpaceOnUse" x1="-14.9543" x2="32.0001" y1="46.9544" y2="-0.000509222"><stop stop-color="#0095FF"/><stop offset="0.99" stop-color="#00C7FF"/></linearGradient><clipPath id="c"><rect width="32" height="32" fill="#fff"/></clipPath></defs></svg>`,

  vip: `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_746_28171)"><path d="M30 0C31.1046 0 32 0.895431 32 2V30C32 31.1046 31.1046 32 30 32H2C0.895431 32 0 31.1046 0 30V2C0 0.895431 0.895431 4.10637e-08 2 0H30ZM15.9648 5C15.7748 5.00005 15.588 5.05204 15.4238 5.15039C15.2596 5.24878 15.124 5.39057 15.0303 5.56055L9.82812 15.0176L3.55078 11.8906C3.36913 11.7985 3.16534 11.7607 2.96387 11.7822C2.76241 11.8038 2.57048 11.8842 2.41113 12.0127C2.25235 12.1408 2.13185 12.3126 2.06348 12.5078C1.99511 12.7031 1.98143 12.9144 2.02441 13.1172L4.58301 25.127C4.63544 25.3782 4.77165 25.6034 4.96777 25.7627C5.16376 25.9217 5.40762 26.0056 5.65723 26H26.251C26.5009 26.0057 26.7453 25.9219 26.9414 25.7627C27.1376 25.6034 27.2737 25.3782 27.3262 25.127L29.9697 13.1172C30.0187 12.9103 30.0086 12.6932 29.9404 12.4922C29.8722 12.2912 29.7485 12.1151 29.585 11.9844C29.4215 11.8537 29.2249 11.7743 29.0186 11.7559C28.8122 11.7374 28.6049 11.7802 28.4219 11.8799L22.1025 15.0283L16.9004 5.56055C16.8066 5.39054 16.6701 5.24878 16.5059 5.15039C16.3416 5.05207 16.1549 5 15.9648 5Z" fill="url(#paint0_linear_746_28171)"></path><path d="M30 0C31.1046 0 32 0.895431 32 2V30C32 31.1046 31.1046 32 30 32H2C0.895431 32 0 31.1046 0 30V2C0 0.895431 0.895431 4.10637e-08 2 0H30ZM15.9648 5C15.7748 5.00005 15.588 5.05204 15.4238 5.15039C15.2596 5.24878 15.124 5.39057 15.0303 5.56055L9.82812 15.0176L3.55078 11.8906C3.36913 11.7985 3.16534 11.7607 2.96387 11.7822C2.76241 11.8038 2.57048 11.8842 2.41113 12.0127C2.25235 12.1408 2.13185 12.3126 2.06348 12.5078C1.99511 12.7031 1.98143 12.9144 2.02441 13.1172L4.58301 25.127C4.63544 25.3782 4.77165 25.6034 4.96777 25.7627C5.16376 25.9217 5.40762 26.0056 5.65723 26H26.251C26.5009 26.0057 26.7453 25.9219 26.9414 25.7627C27.1376 25.6034 27.2737 25.3782 27.3262 25.127L29.9697 13.1172C30.0187 12.9103 30.0086 12.6932 29.9404 12.4922C29.8722 12.2912 29.7485 12.1151 29.585 11.9844C29.4215 11.8537 29.2249 11.7743 29.0186 11.7559C28.8122 11.7374 28.6049 11.7802 28.4219 11.8799L22.1025 15.0283L16.9004 5.56055C16.8066 5.39054 16.6701 5.24878 16.5059 5.15039C16.3416 5.05207 16.1549 5 15.9648 5Z" fill="url(#paint1_linear_746_28171)"></path></g><defs><linearGradient id="paint0_linear_746_28171" x1="18.8102" y1="-12.7222" x2="2.88536" y2="39.1063" gradientUnits="userSpaceOnUse"><stop stop-color="#FF6A4A"></stop><stop offset="1" stop-color="#C70C00"></stop></linearGradient><linearGradient id="paint1_linear_746_28171" x1="15.7467" y1="-4.75575" x2="16.321" y2="39.0672" gradientUnits="userSpaceOnUse"><stop stop-color="#FFC900"></stop><stop offset="0.99" stop-color="#FF9500"></stop></linearGradient><clipPath id="clip0_746_28171"><rect width="32" height="32" fill="white"></rect></clipPath></defs></svg>`,
};

/** Suffix every id (and its `url(#id)` / `href="#id"` references) so the same
 *  badge on many messages never shares ids across the document. */
function withUniqueIds(svg: string, uid: string): string {
  const ids = new Set<string>();
  for (const match of svg.matchAll(/\bid="([^"]+)"/g)) ids.add(match[1]);
  let out = svg;
  for (const id of ids) {
    const next = `${id}_${uid}`;
    out = out
      .split(`id="${id}"`)
      .join(`id="${next}"`)
      .split(`url(#${id})`)
      .join(`url(#${next})`)
      .split(`href="#${id}"`)
      .join(`href="#${next}"`);
  }
  return out;
}

interface KickBadgeGlyphProps {
  glyph: string;
  title: string;
}

export function KickBadgeGlyph({ glyph, title }: KickBadgeGlyphProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const markup = KICK_BADGE_SVG[glyph as KickGlyphBadge];
  if (!markup) return null;

  return (
    <span
      aria-label={title}
      className="kick-badge-glyph"
      dangerouslySetInnerHTML={{ __html: withUniqueIds(markup, uid) }}
      role="img"
    />
  );
}
