import type { AppPreferences, AppPreferencesPatch } from "../../shared/preferences";

type SaveFailureListener = (patch: AppPreferencesPatch) => void;

const saveFailureListeners = new Set<SaveFailureListener>();

/** Hears about every setting that could not be written, wherever it was changed. */
export function onPreferenceSaveFailed(listener: SaveFailureListener): () => void {
  saveFailureListeners.add(listener);
  return () => saveFailureListeners.delete(listener);
}

/**
 * Writes settings, and reports a write that fails instead of dropping it. Each
 * caller used to discard the error, so a setting could look changed for the
 * rest of the run — the screen already shows the new value — and be back to
 * the old one the next time VioletWire started, with nothing to say why.
 * Resolves to the saved preferences, or null when the write failed.
 */
export function savePreferences(patch: AppPreferencesPatch): Promise<AppPreferences | null> {
  return window.desktop.preferences.update(patch).catch(() => {
    for (const listener of saveFailureListeners) listener(patch);
    return null;
  });
}
