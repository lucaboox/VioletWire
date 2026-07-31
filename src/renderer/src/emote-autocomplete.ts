/** How a typed word is matched against emote names when autocompleting. */
export type EmoteMatchMode = "prefix" | "substring";

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
