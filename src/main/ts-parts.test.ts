import { describe, expect, it } from "vitest";
import { firstTsVideoTime, looksLikeTransportStream, planTsParts } from "./ts-parts";

const TS_PACKET_SIZE = 188;
const VIDEO_PID = 0x100;
const AUDIO_PID = 0x101;

function writeTimestamp(packet: Uint8Array, at: number, seconds: number, prefix: number): void {
  let remaining = Math.round(seconds * 90_000);
  const top = Math.floor(remaining / 2 ** 30) & 0x07;
  remaining %= 2 ** 30;
  const second = Math.floor(remaining / 2 ** 22);
  remaining %= 2 ** 22;
  const third = Math.floor(remaining / 2 ** 15);
  remaining %= 2 ** 15;
  const fourth = Math.floor(remaining / 2 ** 7);
  const fifth = remaining % 2 ** 7;

  packet[at] = (prefix << 4) | (top << 1) | 0x01;
  packet[at + 1] = second;
  packet[at + 2] = (third << 1) | 0x01;
  packet[at + 3] = fourth;
  packet[at + 4] = (fifth << 1) | 0x01;
}

/**
 * A packet that opens a PES payload carrying `seconds` as its timestamp: a
 * video frame of unstated length, beginning with a start code, unless told
 * otherwise.
 */
function timedPacket(
  seconds: number,
  { pid = VIDEO_PID, streamId = 0xe0, length = 0, decodeSeconds, runsOn = false }: {
    pid?: number;
    streamId?: number;
    /** PES_packet_length: the bytes after the length field, 0 for unbounded. */
    length?: number;
    decodeSeconds?: number;
    /** The payload opens with the previous frame's last bytes, not a start code. */
    runsOn?: boolean;
  } = {},
): Uint8Array {
  const packet = new Uint8Array(TS_PACKET_SIZE);
  packet[0] = 0x47;
  packet[1] = 0x40 | ((pid >> 8) & 0x1f); // payload unit start
  packet[2] = pid & 0xff;
  packet[3] = 0x10; // payload only
  packet[4] = 0x00;
  packet[5] = 0x00;
  packet[6] = 0x01; // PES start code
  packet[7] = streamId;
  packet[8] = (length >> 8) & 0xff;
  packet[9] = length & 0xff;
  packet[10] = 0x80;
  if (decodeSeconds === undefined) {
    packet[11] = 0x80; // a presentation timestamp follows
    packet[12] = 0x05;
    writeTimestamp(packet, 13, seconds, 0x2);
  } else {
    packet[11] = 0xc0; // presentation and decode timestamps follow
    packet[12] = 0x0a;
    writeTimestamp(packet, 13, seconds, 0x3);
    writeTimestamp(packet, 18, decodeSeconds, 0x1);
  }
  // The elementary stream: an access unit delimiter, or run-on slice bytes.
  const body = 13 + packet[12];
  packet.set(runsOn ? [0x3d, 0x43, 0xd7, 0x14, 0x00, 0x00, 0x00, 0x01, 0x09] : [0x00, 0x00, 0x00, 0x01, 0x09], body);
  return packet;
}

/** An audio PES packet that runs on for `packets` transport packets in all. */
function audioStart(seconds: number, packets: number): Uint8Array {
  // Each packet after the header one carries 184 payload bytes.
  const payloadBytes = 184 * packets;
  return timedPacket(seconds, { pid: AUDIO_PID, streamId: 0xc0, length: payloadBytes - 6 });
}

/** A packet continuing an earlier payload, so it carries no timestamp. */
function continuationPacket(pid = VIDEO_PID): Uint8Array {
  const packet = new Uint8Array(TS_PACKET_SIZE);
  packet[0] = 0x47;
  packet[1] = (pid >> 8) & 0x1f;
  packet[2] = pid & 0xff;
  packet[3] = 0x10;
  return packet;
}

function stream(...packets: Uint8Array[]): Uint8Array {
  const data = new Uint8Array(packets.length * TS_PACKET_SIZE);
  packets.forEach((packet, index) => data.set(packet, index * TS_PACKET_SIZE));
  return data;
}

describe("planTsParts", () => {
  it("cuts a part once the target duration has passed", () => {
    // Timestamps a second apart, so a half-second target cuts at each one.
    const data = stream(timedPacket(10), timedPacket(11), timedPacket(12));

    const parts = planTsParts(data, 0, 0.5);

    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ end: TS_PACKET_SIZE, duration: 1 });
    expect(parts[1]).toEqual({ end: TS_PACKET_SIZE * 2, duration: 1 });
  });

  it("keeps cutting on packet boundaries", () => {
    const data = stream(
      timedPacket(0),
      continuationPacket(),
      continuationPacket(),
      timedPacket(1),
    );

    const parts = planTsParts(data, 0, 0.5);

    expect(parts).toHaveLength(1);
    expect(parts[0].end % TS_PACKET_SIZE).toBe(0);
    expect(parts[0].end).toBe(TS_PACKET_SIZE * 3);
  });

  it("holds back a part that has not reached the target yet", () => {
    const data = stream(timedPacket(0), timedPacket(0.2));

    expect(planTsParts(data, 0, 1)).toEqual([]);
  });

  it("ignores a trailing partial packet", () => {
    const whole = stream(timedPacket(0), timedPacket(1));
    const data = new Uint8Array(whole.length + 40);
    data.set(whole);

    const parts = planTsParts(data, 0, 0.5);

    expect(parts).toHaveLength(1);
    expect(parts[0].end).toBe(TS_PACKET_SIZE);
  });

  it("resumes from an offset already cut", () => {
    const data = stream(timedPacket(0), timedPacket(1), timedPacket(2));

    const parts = planTsParts(data, TS_PACKET_SIZE, 0.5);

    expect(parts).toHaveLength(1);
    expect(parts[0].end).toBe(TS_PACKET_SIZE * 2);
  });

  it("is not confused by interleaved timestamps running backwards", () => {
    // Audio and video are interleaved, so a later packet can carry an earlier
    // time; parts are measured on the video alone.
    const data = stream(timedPacket(10), audioStart(9.9, 1), timedPacket(11));

    const parts = planTsParts(data, 0, 0.5);

    expect(parts).toEqual([{ end: TS_PACKET_SIZE * 2, duration: 1 }]);
  });

  it("only ends a part where a video frame begins", () => {
    // An audio packet past the target is not a place to cut: the video frame
    // before it may still be arriving, and would be split.
    const data = stream(
      timedPacket(0),
      audioStart(0.8, 1),
      continuationPacket(),
      timedPacket(1),
    );

    const parts = planTsParts(data, 0, 0.5);

    expect(parts).toEqual([{ end: TS_PACKET_SIZE * 3, duration: 1 }]);
  });

  it("never cuts while an audio packet is still arriving", () => {
    // The audio packet opened before the second frame runs on past it, so the
    // cut waits for the frame after, when the audio is complete.
    const data = stream(
      timedPacket(0),
      audioStart(0.3, 3),
      continuationPacket(AUDIO_PID),
      timedPacket(1),
      continuationPacket(AUDIO_PID),
      timedPacket(1.1),
    );

    const parts = planTsParts(data, 0, 0.5);

    expect(parts).toEqual([{ end: TS_PACKET_SIZE * 5, duration: 1.1 }]);
  });

  it("never cuts where the previous frame runs on into the next packet", () => {
    // The packet at one second carries the tail of the frame before it ahead
    // of its own start code; cutting there would cost that frame its end.
    const data = stream(
      timedPacket(0),
      timedPacket(1, { runsOn: true }),
      continuationPacket(),
      timedPacket(1.02),
    );

    expect(planTsParts(data, 0, 0.5)).toEqual([{ end: TS_PACKET_SIZE * 3, duration: 1.02 }]);
  });

  it("measures by decode time when a frame carries one", () => {
    // Reordered frames present out of order; decode times advance steadily.
    const data = stream(
      timedPacket(10.2, { decodeSeconds: 10 }),
      timedPacket(10.1, { decodeSeconds: 10.5 }),
    );

    expect(planTsParts(data, 0, 0.5)).toEqual([{ end: TS_PACKET_SIZE, duration: 0.5 }]);
  });

  it("stops cutting where the stream loses sync", () => {
    const broken = stream(timedPacket(0), continuationPacket(), timedPacket(1));
    broken[TS_PACKET_SIZE] = 0x00;

    expect(planTsParts(broken, 0, 0.5)).toEqual([]);
  });

  it("reads a timestamp past the 32-bit boundary", () => {
    // Above 2^32 units the top bit only survives if it is not shifted away.
    const base = 2 ** 32 / 90_000;
    const data = stream(timedPacket(base), timedPacket(base + 1));

    const parts = planTsParts(data, 0, 0.5);

    expect(parts).toHaveLength(1);
    expect(parts[0].duration).toBeCloseTo(1, 2);
  });

  it("returns nothing for a target of zero", () => {
    expect(planTsParts(stream(timedPacket(0), timedPacket(5)), 0, 0)).toEqual([]);
  });
});

describe("firstTsVideoTime", () => {
  it("reads the first video frame's time, skipping audio", () => {
    expect(firstTsVideoTime(stream(audioStart(4.9, 1), timedPacket(5)))).toBeCloseTo(5, 5);
  });

  it("waits for a video frame to arrive", () => {
    expect(firstTsVideoTime(stream(audioStart(4.9, 1)))).toBeNull();
  });
});

describe("looksLikeTransportStream", () => {
  it("accepts a buffer starting on a sync byte", () => {
    expect(looksLikeTransportStream(stream(timedPacket(0)))).toBe(true);
  });

  it("rejects something that is not a transport stream", () => {
    expect(looksLikeTransportStream(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
