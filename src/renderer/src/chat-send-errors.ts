const TWITCH_DUPLICATE_MESSAGE_PATTERN =
  /message was not sent because it is identical to the previous one.+less than 30 seconds ago/i;

// Twitch clients commonly pair a regular space with the reserved, invisible
// Unicode tag character so the server sees a distinct message while chat does
// not gain visible noise.
const DUPLICATE_MESSAGE_SUFFIX = " \u{e0000}";
const TWITCH_MESSAGE_LIMIT = 500;

export function cleanChatSendError(reason: unknown): string {
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : "The chat message could not be sent.";

  return message
    .replace(
      /^Error invoking remote method ['"]chat:send['"]:\s*(?:Error:\s*)?/i,
      "",
    )
    .trim();
}

export function isTwitchDuplicateMessageError(message: string): boolean {
  return TWITCH_DUPLICATE_MESSAGE_PATTERN.test(message);
}

export function makeTwitchMessageDistinct(message: string): string | null {
  if (message.length + DUPLICATE_MESSAGE_SUFFIX.length > TWITCH_MESSAGE_LIMIT) {
    return null;
  }
  return `${message}${DUPLICATE_MESSAGE_SUFFIX}`;
}
