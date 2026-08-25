import "flag-icons/css/flag-icons.min.css";
import {
  countryCodeForFlagEmoji,
  splitCountryFlagText,
} from "./country-flag";

function flagLabel(countryCode: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(
      countryCode.toUpperCase(),
    ) ?? `${countryCode.toUpperCase()} flag`;
  } catch {
    return `${countryCode.toUpperCase()} flag`;
  }
}

export function CountryFlagEmoji({
  className,
  unicode,
}: {
  className?: string;
  unicode: string;
}) {
  const countryCode = countryCodeForFlagEmoji(unicode);
  if (!countryCode) return <span className={className}>{unicode}</span>;
  return (
    <span
      aria-label={flagLabel(countryCode)}
      className={`fi fi-${countryCode} unicode-country-flag${className ? ` ${className}` : ""}`}
      data-emoji-unicode={unicode}
      role="img"
    />
  );
}

export function CountryFlagText({
  className = "chat-country-flag",
  text,
}: {
  className?: string;
  text: string;
}) {
  return splitCountryFlagText(text).map((part, index) =>
    part.kind === "flag"
      ? <CountryFlagEmoji className={className} key={`flag-${index}`} unicode={part.text} />
      : part.text,
  );
}
