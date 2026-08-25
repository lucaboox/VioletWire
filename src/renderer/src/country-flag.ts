const REGIONAL_INDICATOR_A = 0x1f1e6;
const REGIONAL_INDICATOR_Z = 0x1f1ff;

export interface CountryFlagTextPart {
  kind: "flag" | "text";
  text: string;
  countryCode?: string;
}

/** Returns the ISO-style code encoded by a two-regional-indicator flag. */
export function countryCodeForFlagEmoji(unicode: string): string | null {
  const points = [...unicode];
  if (points.length !== 2) return null;
  const values = points.map((point) => point.codePointAt(0) ?? 0);
  if (
    values.some(
      (value) => value < REGIONAL_INDICATOR_A || value > REGIONAL_INDICATOR_Z,
    )
  ) {
    return null;
  }
  return values
    .map((value) => String.fromCharCode(97 + value - REGIONAL_INDICATOR_A))
    .join("");
}

/** Splits flags out even when they touch ordinary text or punctuation. */
export function splitCountryFlagText(text: string): CountryFlagTextPart[] {
  const points = [...text];
  const parts: CountryFlagTextPart[] = [];
  let pendingText = "";
  const flushText = () => {
    if (!pendingText) return;
    parts.push({ kind: "text", text: pendingText });
    pendingText = "";
  };

  for (let index = 0; index < points.length; index += 1) {
    const candidate = `${points[index]}${points[index + 1] ?? ""}`;
    const countryCode = countryCodeForFlagEmoji(candidate);
    if (!countryCode) {
      pendingText += points[index];
      continue;
    }
    flushText();
    parts.push({ kind: "flag", text: candidate, countryCode });
    index += 1;
  }
  flushText();
  return parts;
}
