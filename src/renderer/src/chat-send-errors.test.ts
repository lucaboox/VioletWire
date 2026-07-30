import { describe, expect, it } from "vitest";
import {
  cleanChatSendError,
  isTwitchDuplicateMessageError,
  makeTwitchMessageDistinct,
} from "./chat-send-errors";

describe("chat send errors", () => {
  it("removes Electron's IPC wrapper from chat errors", () => {
    expect(
      cleanChatSendError(
        new Error(
          "Error invoking remote method 'chat:send': Error: Your message was not sent.",
        ),
      ),
    ).toBe("Your message was not sent.");
  });

  it("recognizes Twitch's duplicate-message rejection", () => {
    expect(
      isTwitchDuplicateMessageError(
        "Your message was not sent because it is identical to the previous one you sent, less than 30 seconds ago.",
      ),
    ).toBe(true);
    expect(isTwitchDuplicateMessageError("You are sending messages too quickly.")).toBe(
      false,
    );
  });

  it("adds an invisible differentiator without changing visible text", () => {
    const distinct = makeTwitchMessageDistinct("hello");
    expect(distinct).not.toBe("hello");
    expect(distinct).toBe("hello \u{e0000}");
  });

  it("does not exceed Twitch's message limit", () => {
    expect(makeTwitchMessageDistinct("x".repeat(498))).toBeNull();
  });
});
