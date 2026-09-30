import { describe, expect, it } from "vitest";
import {
  looksLikeFragmentedMp4,
  mp4StartsIndependent,
  planMp4Parts,
  readMp4Tracks,
} from "./fmp4-parts";
import { AUDIO_TRACK as AUDIO, VIDEO_TRACK as VIDEO, box, fragmentPieces, initSegment, join } from "./test-support/fmp4-fixtures";

const tracks = readMp4Tracks(initSegment());

/** A two-second fragment, with the offset where each of its chunks ends. */
function fragment(start = 100, keyFrames: number[] = [0]): { data: Uint8Array; ends: number[] } {
  const pieces = fragmentPieces(start, keyFrames);
  const ends: number[] = [];
  let offset = pieces[0].length;
  for (const piece of pieces.slice(1)) {
    offset += piece.length;
    ends.push(offset);
  }
  return { data: join(...pieces), ends };
}

describe("readMp4Tracks", () => {
  it("reads each track's timescale and kind", () => {
    expect(tracks).toEqual(
      new Map([
        [AUDIO, { timescale: 48_000, kind: "soun" }],
        [VIDEO, { timescale: 1_000_000, kind: "vide" }],
      ]),
    );
  });

  it("returns nothing for a buffer that is not an initialisation segment", () => {
    expect(readMp4Tracks(new Uint8Array([1, 2, 3, 4]))).toEqual(new Map());
  });
});

describe("planMp4Parts", () => {
  it("cuts a fragment into parts of about the target on chunk boundaries", () => {
    const { data, ends } = fragment();
    const parts = planMp4Parts(data, 0, 0.3, tracks);

    // Three chunks make 0.321s; nineteen give six whole parts and a remainder
    // that waits for more of the stream.
    expect(parts).toHaveLength(6);
    for (const part of parts) {
      expect(part.duration).toBeCloseTo(0.321, 3);
      expect(ends).toContain(part.end);
    }
  });

  it("marks only the part that opens on the key frame as a place to start", () => {
    const { data } = fragment();
    const parts = planMp4Parts(data, 0, 0.3, tracks);

    expect(parts.map((part) => part.independent)).toEqual([true, false, false, false, false, false]);
  });

  it("gives a key frame part of its own, even in the middle of a fragment", () => {
    // A key frame at chunk 4, which would otherwise sit inside the second part.
    const { data, ends } = fragment(100, [0, 4]);
    const parts = planMp4Parts(data, 0, 0.3, tracks);

    expect(parts[0]).toMatchObject({ end: ends[2], independent: true });
    // The second part is cut short so the key frame can open the third.
    expect(parts[1]).toMatchObject({ end: ends[3], independent: false });
    expect(parts[1].duration).toBeCloseTo(0.107, 3);
    expect(parts[2].independent).toBe(true);
  });

  it("leaves a chunk that has not finished arriving for later", () => {
    const { data, ends } = fragment();
    // Everything up to the middle of the fifth chunk.
    const partial = data.subarray(0, ends[3] + 10);
    const parts = planMp4Parts(partial, 0, 0.3, tracks);

    expect(parts).toHaveLength(1);
    expect(parts[0].end).toBe(ends[2]);
  });

  it("carries on from where the previous cut ended", () => {
    const { data } = fragment();
    const first = planMp4Parts(data, 0, 0.3, tracks);
    const resumed = planMp4Parts(data, first[1].end, 0.3, tracks);

    expect(resumed[0].end).toBe(first[2].end);
    expect(resumed[0].independent).toBe(false);
  });

  it("cuts nothing without the tracks from the initialisation segment", () => {
    expect(planMp4Parts(fragment().data, 0, 0.3, new Map())).toEqual([]);
  });
});

describe("mp4StartsIndependent", () => {
  it("says whether the first chunk from an offset opens on a key frame", () => {
    const { data, ends } = fragment();

    expect(mp4StartsIndependent(data, 0, tracks)).toBe(true);
    expect(mp4StartsIndependent(data, ends[5], tracks)).toBe(false);
  });
});

describe("looksLikeFragmentedMp4", () => {
  it("recognises the boxes a fragment can open with", () => {
    for (const type of ["emsg", "styp", "ftyp", "moof"]) {
      expect(looksLikeFragmentedMp4(box(type, new Uint8Array(4)))).toBe(true);
    }
  });

  it("rejects a transport stream", () => {
    const ts = new Uint8Array(188);
    ts[0] = 0x47;
    expect(looksLikeFragmentedMp4(ts)).toBe(false);
  });
});
