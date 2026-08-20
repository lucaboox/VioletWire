/** How a typed word is matched against emote names when autocompleting. */
export type EmoteMatchMode = "prefix" | "substring";

/** The word being completed: where it sits in the message being written. */
export interface EmoteWordRange {
  start: number;
  end: number;
}

export interface EmoteCompletionStep {
  /** The message with the word replaced by the emote's name. */
  value: string;
  /** Where the caret belongs afterwards: just past the name. */
  caret: number;
  /**
   * Whether the box must be redrawn even though nothing downstream will ask it
   * to. Completing a name that was already typed in full leaves the text exactly
   * as it was, and the box only redraws when its text and the message differ —
   * so without this the word stays as letters and never becomes the emote, while
   * everything else behaves as though it had been completed. Tab then steps to
   * the next match rather than appearing to do anything.
   */
  redraw: boolean;
}

/** Replaces the word being completed with an emote's name. */
export function completeEmoteWord(
  text: string,
  word: EmoteWordRange,
  name: string,
): EmoteCompletionStep {
  const value = `${text.slice(0, word.start)}${name}${text.slice(word.end)}`;
  return {
    value,
    caret: word.start + name.length,
    redraw: value === text,
  };
}

/**
 * Emote names matching a typed word, best first. "prefix" only keeps names
 * starting with the word; "substring" also keeps it appearing anywhere, while
 * still ranking an exact name, then the ones it starts, above the rest — those
 * are nearly always the intended completion.
 */
export function matchEmoteNames(
  names: Iterable<string>,
  query: string,
  mode: EmoteMatchMode,
): string[] {
  const target = query.toLowerCase();
  const rank = (name: string) => (name === target ? 0 : name.startsWith(target) ? 1 : 2);
  return [...names]
    .filter((name) => {
      const lower = name.toLowerCase();
      return mode === "substring" ? lower.includes(target) : lower.startsWith(target);
    })
    .sort((left, right) => {
      const difference = rank(left.toLowerCase()) - rank(right.toLowerCase());
      if (difference !== 0) return difference;
      return left.localeCompare(right, undefined, { sensitivity: "base" });
    });
}
