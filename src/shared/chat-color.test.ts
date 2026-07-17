import { describe, expect, it } from "vitest";
import { readableUsernameColor } from "./chat-color";

describe("readableUsernameColor", () => {
  it("lifts black usernames on an OLED background", () => {
    expect(readableUsernameColor("#000000", "#000000")).not.toBe("#000000");
  });

  it("preserves colors that already have sufficient contrast", () => {
    expect(readableUsernameColor("#ff0000", "#000000")).toBe("#ff0000");
  });

  it("uses a safe fallback for malformed Twitch colors", () => {
    expect(readableUsernameColor("", "#000000")).toBe("#a78bfa");
  });
});
