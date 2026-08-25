import { useSyncExternalStore } from "react";

import {
  defaultAppPreferences,
  type AppPreferences,
} from "../../shared/preferences";

/**
 * Reads a single setting, in whatever window is asking, and re-renders when it
 * changes. For the settings that chat consults while drawing a message, where
 * there is no component above to pass them down from.
 *
 * Read a plain value — a boolean, a number, a string. Anything built fresh on
 * each read, such as an array or an object, would look like a new value every
 * time and never settle.
 */

let preferences: AppPreferences = defaultAppPreferences;
const listeners = new Set<() => void>();

function publish(next: AppPreferences): void {
  preferences = next;
  for (const listener of listeners) listener();
}

void window.desktop.preferences
  .getOrMigrate()
  .then(publish)
  .catch(() => undefined);
window.desktop.preferences.onChanged(publish);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePreference<T extends boolean | number | string>(
  read: (preferences: AppPreferences) => T,
): T {
  return useSyncExternalStore(
    subscribe,
    () => read(preferences),
    () => read(preferences),
  );
}
