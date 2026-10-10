import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCategoryViewersRequests,
  CATEGORIES_PER_REQUEST,
  fetchCategoryViewerCounts,
} from "./twitch-category-viewers";

function stubFetch(handler: (body: { query: string; variables: Record<string, string> }) => Response) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    handler(JSON.parse(String(init?.body))),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const pageOfIds = Array.from({ length: 30 }, (_, index) => String(1000 + index));

describe("buildCategoryViewersRequests", () => {
  it("asks for several categories in one request, passing each id as a variable", () => {
    const [request, ...rest] = buildCategoryViewersRequests(["509658", "32982"]);

    expect(rest).toEqual([]);
    expect(request.variables).toEqual({ c0: "509658", c1: "32982" });
    expect(request.query).toBe(
      "query CategoryViewers($c0: ID!, $c1: ID!) { c0: game(id: $c0) { id viewersCount } c1: game(id: $c1) { id viewersCount } }",
    );
  });

  it("splits a page into requests Twitch accepts", () => {
    // Twitch refuses more than 15 aliased fields in one query.
    const requests = buildCategoryViewersRequests(pageOfIds);

    expect(CATEGORIES_PER_REQUEST).toBe(15);
    expect(requests.map((request) => Object.keys(request.variables).length)).toEqual([15, 15]);
    expect(requests.flatMap((request) => Object.values(request.variables))).toEqual(pageOfIds);
  });

  it("leaves out anything that is not a Twitch category id, and repeats", () => {
    const [request] = buildCategoryViewersRequests(["509658", "509658", 'x") { id } #', ""]);

    expect(request.variables).toEqual({ c0: "509658" });
  });

  it("makes no request for no valid ids", () => {
    expect(buildCategoryViewersRequests([])).toEqual([]);
    expect(buildCategoryViewersRequests(["abc"])).toEqual([]);
  });
});

describe("fetchCategoryViewerCounts", () => {
  it("returns each category's viewers", async () => {
    const fetchMock = stubFetch(() =>
      Response.json({
        data: {
          c0: { id: "509658", viewersCount: 235_544 },
          c1: { id: "32982", viewersCount: 100_773 },
        },
      }),
    );

    const counts = await fetchCategoryViewerCounts(["509658", "32982"]);

    expect(counts).toEqual(new Map([["509658", 235_544], ["32982", 100_773]]));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://gql.twitch.tv/gql");
    // Anonymous: the site's public client id, and never an account token.
    const headers = init?.headers as Record<string, string>;
    expect(headers["Client-ID"]).toBe("kimne78kx3ncx6brgo4mv6wki5h1ko");
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain("authorization");
  });

  it("skips a category Twitch does not know, and ids it was not asked about", async () => {
    stubFetch(() =>
      Response.json({
        data: { c0: null, c1: { id: "32982", viewersCount: 12 }, c2: { id: "999", viewersCount: 5 } },
      }),
    );

    const counts = await fetchCategoryViewerCounts(["1", "32982"]);

    expect(counts).toEqual(new Map([["32982", 12]]));
  });

  it("comes back empty when Twitch refuses or answers in another shape", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));
    await expect(fetchCategoryViewerCounts(["509658"])).resolves.toEqual(new Map());

    stubFetch(() => Response.json({ errors: [{ message: "PersistedQueryNotFound" }] }));
    await expect(fetchCategoryViewerCounts(["509658"])).resolves.toEqual(new Map());

    stubFetch(() => Response.json({ data: { c0: { id: "509658", viewersCount: "lots" } } }));
    await expect(fetchCategoryViewerCounts(["509658"])).resolves.toEqual(new Map());
  });

  it("counts a whole page, and keeps what one failed group leaves", async () => {
    stubFetch(({ variables }) => {
      const ids = Object.entries(variables);
      // The second group of fifteen is refused.
      if (ids.some(([, id]) => id === pageOfIds[20])) return new Response("busy", { status: 503 });
      return Response.json({
        data: Object.fromEntries(ids.map(([alias, id]) => [alias, { id, viewersCount: Number(id) }])),
      });
    });

    const counts = await fetchCategoryViewerCounts(pageOfIds);

    expect([...counts.keys()]).toEqual(pageOfIds.slice(0, 15));
    expect(counts.get("1000")).toBe(1000);
  });

  it("comes back empty when the request fails outright", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));

    await expect(fetchCategoryViewerCounts(["509658"])).resolves.toEqual(new Map());
  });
});
