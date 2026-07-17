function parseHexColor(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
  const linear = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(left: [number, number, number], right: [number, number, number]): number {
  const bright = Math.max(relativeLuminance(left), relativeLuminance(right));
  const dark = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (bright + 0.05) / (dark + 0.05);
}

export function readableUsernameColor(color: string, background: string): string {
  const foreground = parseHexColor(color);
  const backdrop = parseHexColor(background);
  if (!foreground || !backdrop) return "#a78bfa";
  if (contrastRatio(foreground, backdrop) >= 4.5) return color;

  for (let amount = 0.1; amount <= 1; amount += 0.1) {
    const lifted = foreground.map((channel) =>
      Math.round(channel + (255 - channel) * amount),
    ) as [number, number, number];
    if (contrastRatio(lifted, backdrop) >= 4.5) {
      return `#${lifted.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
    }
  }
  return "#ffffff";
}
