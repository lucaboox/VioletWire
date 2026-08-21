/**
 * Chatters the viewer has chosen not to see.
 *
 * This list is VioletWire's own and never leaves the machine: blocking someone
 * here hides them in this app, and does nothing to the account on Twitch or
 * Kick. Neither service offers a way to do more from a client like this one —
 * Twitch keeps a block list, but it hides nothing on its own for a client that
 * reads chat directly, and Kick publishes no block list at all — so the hiding
 * is ours to do either way.
 *
 * Names are held as logins, lowercased, because that is the one form both
 * services agree on and the only one that appears with every message. A display
 * name can be capitalised however its owner likes, and can change.
 */

/** Beyond this the list stops being something a person maintains by hand. */
export const BLOCKED_CHATTER_LIMIT = 2_000;

/** Logins are letters, digits and underscores; a hyphen is allowed for Kick. */
const LOGIN_PATTERN = /^[a-z0-9_-]{1,40}$/;

/** The stored form of a typed name: no leading @, no spaces, no capitals. */
export function normalizeBlockedChatter(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

/** Whether a typed name could be somebody's login at all. */
export function isBlockableChatter(value: string): boolean {
  return LOGIN_PATTERN.test(normalizeBlockedChatter(value));
}

/**
 * The list with a name added, in alphabetical order so the settings list does
 * not reshuffle itself as names come and go. A name already on it, or one that
 * cannot be a login, leaves the list exactly as it was.
 */
export function withBlockedChatter(
  list: readonly string[],
  value: string,
): string[] {
  const login = normalizeBlockedChatter(value);
  if (!isBlockableChatter(login)) return [...list];
  const next = new Set(list.map(normalizeBlockedChatter));
  if (next.has(login) || next.size >= BLOCKED_CHATTER_LIMIT) return [...list];
  next.add(login);
  return [...next].sort();
}

/** The list with a name removed, however it was capitalised or typed. */
export function withoutBlockedChatter(
  list: readonly string[],
  value: string,
): string[] {
  const login = normalizeBlockedChatter(value);
  return list.filter((entry) => normalizeBlockedChatter(entry) !== login);
}
