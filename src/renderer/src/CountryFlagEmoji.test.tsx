import { describe, expect, it } from "vitest";
import {
  countryCodeForFlagEmoji,
  splitCountryFlagText,
} from "./country-flag";

describe("country flag emoji", () => {
  it("decodes regional indicator pairs", () => {
    expect(countryCodeForFlagEmoji("🇪🇺")).toBe("eu");
    expect(countryCodeForFlagEmoji("🇪🇸")).toBe("es");
    expect(countryCodeForFlagEmoji("EU")).toBeNull();
  });

  it("finds flags when they touch surrounding text", () => {
    expect(splitCountryFlagText("hello🇫🇷!🇨🇦")).toEqual([
      { kind: "text", text: "hello" },
      { kind: "flag", text: "🇫🇷", countryCode: "fr" },
      { kind: "text", text: "!" },
      { kind: "flag", text: "🇨🇦", countryCode: "ca" },
    ]);
  });
});
