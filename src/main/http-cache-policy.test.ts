import { describe, expect, it } from "vitest";
import { cacheDecisionFor, rewriteCacheHeaders } from "./http-cache-policy";

describe("cacheDecisionFor", () => {
  it("keeps 7TV emote images far longer than 7TV asks", () => {
    expect(cacheDecisionFor("https://cdn.7tv.app/emote/01F6MZGCKG/2x.webp")).toBe(
      "keep-long",
    );
  });

  it("leaves the services that already get it right alone", () => {
    expect(cacheDecisionFor("https://cdn.betterttv.net/emote/abc/2x.webp")).toBe(
      "leave-alone",
    );
    expect(cacheDecisionFor("https://cdn.frankerfacez.com/emote/1/2")).toBe(
      "leave-alone",
    );
    expect(cacheDecisionFor("https://static-cdn.jtvnw.net/emoticons/v2/1/2.0")).toBe(
      "leave-alone",
    );
  });

  it("is not fooled by a host that merely ends with the same words", () => {
    expect(cacheDecisionFor("https://cdn.7tv.app.example.test/emote/1/2x.webp")).toBe(
      "leave-alone",
    );
  });

  it("leaves an address it cannot parse alone", () => {
    expect(cacheDecisionFor("not a url")).toBe("leave-alone");
  });
});

describe("rewriteCacheHeaders", () => {
  it("replaces every caching header the server sent", () => {
    const rewritten = rewriteCacheHeaders({
      "Cache-Control": ["max-age=10, immutable"],
      Expires: ["Thu, 01 Jan 2099 00:00:00 GMT"],
      Pragma: ["cache"],
      "Content-Type": ["image/webp"],
    });
    expect(rewritten["cache-control"]).toEqual([
      `public, max-age=${30 * 24 * 60 * 60}, immutable`,
    ]);
    expect(rewritten["Content-Type"]).toEqual(["image/webp"]);
    for (const dropped of ["Cache-Control", "Expires", "Pragma"]) {
      expect(Object.keys(rewritten)).not.toContain(dropped);
    }
  });

  it("copes with a response that carried no headers", () => {
    expect(rewriteCacheHeaders(undefined)).toEqual({
      "cache-control": [`public, max-age=${30 * 24 * 60 * 60}, immutable`],
    });
  });
});
