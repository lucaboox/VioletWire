import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("./streamlink-process", () => ({ spawnStreamlinkWorker: mocks.spawn }));
import { StreamlinkWorker } from "./streamlink-worker";

function setup() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn() }),
    kill: vi.fn(),
  });
  mocks.spawn.mockReturnValue(child);
  const worker = new StreamlinkWorker();
  return { worker, child };
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe("Streamlink worker pipe", () => {
  it("reuses its process and handles fragmented and coalesced replies", async () => {
    const { worker, child } = setup();
    const first = worker.resolve("one", "private-test-token");
    const second = worker.resolve("two", null);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(child.stdin.write.mock.calls[0][0])).toEqual({
      id: 1,
      login: "one",
      token: "private-test-token",
    });
    child.stdout.emit("data", Buffer.from('{"ready":true}\n{"id":1,"str'));
    child.stdout.emit(
      "data",
      Buffer.from(
        'eams":{"best":"https://example.com/one"}}\n{"id":2,"streams":{"best":"https://example.com/two"}}\n',
      ),
    );
    await expect(first).resolves.toEqual({ best: "https://example.com/one" });
    await expect(second).resolves.toEqual({ best: "https://example.com/two" });
    worker.destroy();
  });
  it("fails only the lookup Streamlink could not resolve, and stays running", async () => {
    const { worker, child } = setup();
    const offline = expect(worker.resolve("offline", null)).rejects.toThrow("could not resolve");
    const live = worker.resolve("live", null);
    child.stdout.emit(
      "data",
      Buffer.from('{"id":1,"error":true}\n{"id":2,"streams":{"best":"https://example.com/live"}}\n'),
    );
    await offline;
    await expect(live).resolves.toEqual({ best: "https://example.com/live" });
    expect(child.kill).not.toHaveBeenCalled();
    // The same process takes the next request.
    void worker.resolve("next", null).catch(() => undefined);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    worker.destroy();
  });
  it("rejects all pending requests on exit and backs off instead of respawning repeatedly", async () => {
    const { worker, child } = setup();
    const first = expect(worker.resolve("one", null)).rejects.toThrow(
      "unavailable",
    );
    child.emit("close", 1);
    await first;
    await expect(worker.resolve("two", null)).rejects.toThrow("unavailable");
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
  it("bounds a stalled request and rejects malformed or unsafe stream URLs", async () => {
    vi.useFakeTimers();
    const { worker, child } = setup();
    const first = expect(worker.resolve("one", null)).rejects.toThrow(
      "unavailable",
    );
    child.stdout.emit(
      "data",
      Buffer.from('{"id":1,"streams":{"best":"file:///secret"}}\n'),
    );
    await first;
    await vi.advanceTimersByTimeAsync(60_000);
    const second = expect(worker.resolve("two", null)).rejects.toThrow(
      "unavailable",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await second;
    expect(child.kill).toHaveBeenCalled();
  });
});
