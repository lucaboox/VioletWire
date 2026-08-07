import type EmojiDatabase from "emoji-picker-element/database";
import type { NativeEmoji, SkinTone } from "emoji-picker-element/shared";

/**
 * The native emoji tab's data: a dynamic import of emoji-picker-element and an
 * IndexedDB read, together slow enough to show a loading line the first time
 * the tab is opened. It lives outside the picker component so a channel load
 * can get it out of the way in the background, and so the picker keeps what it
 * loaded across opens.
 */

export const UNICODE_EMOJI_GROUPS = [
  { id: 0, label: "Smileys & emotion", icon: "😀" },
  { id: 1, label: "People & body", icon: "👋" },
  { id: 3, label: "Animals & nature", icon: "🐱" },
  { id: 4, label: "Food & drink", icon: "🍎" },
  { id: 5, label: "Travel & places", icon: "🏠" },
  { id: 6, label: "Activities", icon: "⚽" },
  { id: 7, label: "Objects", icon: "📝" },
  { id: 8, label: "Symbols", icon: "⛔" },
  { id: 9, label: "Flags", icon: "🏁" },
] as const;

export interface UnicodeEmojiData {
  groups: Map<number, NativeEmoji[]>;
  skinTone: SkinTone;
}

let cachedGroups = new Map<number, NativeEmoji[]>();
let cachedSkinTone: SkinTone = 0;
let cachedDatabase: EmojiDatabase | null = null;
let load: Promise<UnicodeEmojiData> | null = null;

/** What has been loaded so far, so a picker can open filled in. */
export function loadedUnicodeEmoji(): UnicodeEmojiData {
  return { groups: cachedGroups, skinTone: cachedSkinTone };
}

/** The live database, for recording picks and the preferred skin tone. */
export function unicodeEmojiDatabase(): EmojiDatabase | null {
  return cachedDatabase;
}

export function rememberUnicodeSkinTone(skinTone: SkinTone) {
  cachedSkinTone = skinTone;
}

/** Loads the emoji database once; every later caller gets the same work. */
export function preloadUnicodeEmoji(): Promise<UnicodeEmojiData> {
  if (load) return load;
  load = import("emoji-picker-element/database")
    .then(async ({ default: Database }) => {
      const database = new Database();
      cachedDatabase = database;
      await database.ready();
      const [storedSkinTone, groups] = await Promise.all([
        database.getPreferredSkinTone(),
        Promise.all(
          UNICODE_EMOJI_GROUPS.map(async ({ id }) => [
            id,
            await database.getEmojiByGroup(id),
          ] as const),
        ),
      ]);
      cachedSkinTone = storedSkinTone;
      cachedGroups = new Map(groups);
      return { groups: cachedGroups, skinTone: storedSkinTone };
    })
    .catch((error: unknown) => {
      // A failed load must not be remembered, or the Emoji tab could never
      // recover from a moment without a connection.
      load = null;
      throw error;
    });
  return load;
}
