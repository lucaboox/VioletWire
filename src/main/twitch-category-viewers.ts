import { z } from "zod";

/**
 * How many people are watching each Twitch category right now.
 *
 * Helix lists categories but has never said how many are watching one; the
 * old Kraken API did, until Twitch shut it down in 2022. Twitch's own site
 * gets the number from its GraphQL API, so this asks that API the same way:
 * anonymously, with the site's public client ID, which is also what the
 * bundled Streamlink does for every Twitch stream. No account token is sent.
 *
 * The counts are an extra. Any failure (a timeout, a changed schema, Twitch
 * refusing the request) leaves them out, and the categories show as before.
 */

const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const GQL_URL = "https://gql.twitch.tv/gql";
// The Browse page waits on this, so it gives up quickly.
const TIMEOUT_MS = 2_500;
// A page of categories is 30; this only bounds an unexpected caller.
const MAX_CATEGORIES = 100;
// Twitch refuses a query with more aliased root fields than this ("exceeds
// the root field aliases limit allowed (15)"), so a page goes in groups.
export const CATEGORIES_PER_REQUEST = 15;
const CATEGORY_ID = /^\d{1,12}$/;

const responseSchema = z.object({
  data: z
    .record(
      z.string(),
      z
        .object({
          id: z.string(),
          viewersCount: z.number().int().nonnegative().nullish(),
        })
        .nullable(),
    )
    .nullish(),
});

interface CategoryViewersRequest {
  query: string;
  variables: Record<string, string>;
}

/**
 * The requests that ask for these categories' counts: as few as Twitch
 * allows, each with one aliased field per category and its id as a variable.
 */
export function buildCategoryViewersRequests(ids: readonly string[]): CategoryViewersRequest[] {
  const valid = [...new Set(ids)].filter((id) => CATEGORY_ID.test(id)).slice(0, MAX_CATEGORIES);
  const requests: CategoryViewersRequest[] = [];
  for (let start = 0; start < valid.length; start += CATEGORIES_PER_REQUEST) {
    const group = valid.slice(start, start + CATEGORIES_PER_REQUEST);
    const variables = Object.fromEntries(group.map((id, index) => [`c${index}`, id]));
    const declarations = group.map((_, index) => `$c${index}: ID!`).join(", ");
    const fields = group
      .map((_, index) => `c${index}: game(id: $c${index}) { id viewersCount }`)
      .join(" ");
    requests.push({ query: `query CategoryViewers(${declarations}) { ${fields} }`, variables });
  }
  return requests;
}

export async function fetchCategoryViewerCounts(
  ids: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  // Side by side; a group that fails only leaves its own categories out.
  const groups = await Promise.all(buildCategoryViewersRequests(ids).map(requestCounts));
  for (const group of groups) {
    for (const [id, viewers] of group) counts.set(id, viewers);
  }
  return counts;
}

async function requestCounts(request: CategoryViewersRequest): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(GQL_URL, {
      method: "POST",
      headers: {
        "Client-ID": TWITCH_WEB_CLIENT_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) return counts;
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success || !parsed.data.data) return counts;
    const asked = new Set(Object.values(request.variables));
    for (const entry of Object.values(parsed.data.data)) {
      if (entry && asked.has(entry.id) && typeof entry.viewersCount === "number") {
        counts.set(entry.id, entry.viewersCount);
      }
    }
  } catch {
    // Unavailable for now; the categories are still worth showing.
  } finally {
    clearTimeout(timer);
  }
  return counts;
}
