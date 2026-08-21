import { useSyncExternalStore } from "react";

import {
  normalizeBlockedChatter,
  withBlockedChatter,
  withoutBlockedChatter,
} from "../../shared/blocked-chatters";

/**
 * The blocked list, as the interface sees it.
 *
 * It is held here rather than passed down because chat is drawn in several
 * places at once — the side panel, the overlay over the player, chat in a
 * window of its own, and every multistream tab — and all of them must hide the
 * same people the moment one of them is told to. The list lives in the
 * preferences file, so this follows whatever is written there, in every window.
 */

let blocked: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function publish(logins: readonly string[]): void {
  const next = new Set(logins.map(normalizeBlockedChatter));
  const unchanged =
    next.size === blocked.size && [...next].every((login) => blocked.has(login));
  if (unchanged) return;
  blocked = next;
  for (const listener of listeners) listener();
}

void window.desktop.preferences
  .getOrMigrate()
  .then((preferences) => publish(preferences.blockedChatUsers))
  .catch(() => undefined);
window.desktop.preferences.onChanged((preferences) =>
  publish(preferences.blockedChatUsers),
);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Whether a message should be shown. Read outside React as well, to drop a
 * blocked chatter's messages before they take up room in the chat buffer.
 */
export function isChatterBlocked(login: string | null | undefined): boolean {
  if (!login) return false;
  return blocked.has(normalizeBlockedChatter(login));
}

/** The blocked list for rendering, which re-renders when it changes. */
export function useBlockedChatters(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => blocked,
    () => blocked,
  );
}

function save(logins: string[]): Promise<void> {
  return window.desktop.preferences
    .update({ blockedChatUsers: logins })
    .then(() => undefined)
    .catch(() => undefined);
}

export function blockChatter(login: string): Promise<void> {
  return save(withBlockedChatter([...blocked], login));
}

export function unblockChatter(login: string): Promise<void> {
  return save(withoutBlockedChatter([...blocked], login));
}
