import { describe, expect, it } from "vitest";
import { extractRscLivestreams } from "./kick-service";

describe("extractRscLivestreams", () => {
  it("returns nothing when the payload has no livestreams array", () => {
    expect(extractRscLivestreams('a:1["nope"]')).toEqual([]);
  });

  it("parses the livestreams array out of a flight payload", () => {
    const raw =
      '3:["$","div",null,{"livestreams":[{"id":"1","channel":{"slug":"a"}},{"id":"2","channel":{"slug":"b"}}]}]';
    const result = extractRscLivestreams(raw);
    expect(result).toHaveLength(2);
    expect((result[0] as { id: string }).id).toBe("1");
  });

  it("is not thrown off by brackets inside string values", () => {
    // The title contains ] and [, which must not end the array early.
    const raw =
      '{"livestreams":[{"id":"1","title":"loot [drop] ] here","channel":{"slug":"a"}}]}';
    const result = extractRscLivestreams(raw);
    expect(result).toHaveLength(1);
    expect((result[0] as { title: string }).title).toBe("loot [drop] ] here");
  });

  it("keeps the largest array when several are present", () => {
    const raw =
      '{"livestreams":[]} more {"livestreams":[{"id":"1"},{"id":"2"},{"id":"3"}]}';
    expect(extractRscLivestreams(raw)).toHaveLength(3);
  });
});
