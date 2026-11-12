import type { ChildProcess } from "node:child_process";
import { z } from "zod";
import { spawnStreamlinkWorker } from "./streamlink-process";

const streamsSchema = z.object({
  id: z.number().int(),
  streams: z.record(
    z.string(),
    z
      .string()
      .url()
      .refine((url) => /^https?:\/\//.test(url)),
  ),
});
// Streamlink failed for that one channel (offline, refused, a plugin error).
// The worker says nothing more, since an error's text can carry credentials.
const errorSchema = z.object({ id: z.number().int().nullable(), error: z.literal(true) });
const responseSchema = z.union([streamsSchema, errorSchema]);

/** One private, bounded JSON-lines pipe. No credentials or signed URLs in logs. */
export class StreamlinkWorker {
  private child: ChildProcess | null = null;
  private disabledUntil = 0;
  private nextId = 0;
  private buffer = "";
  private readonly pending = new Map<
    number,
    {
      resolve: (streams: Record<string, string>) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  start(): void {
    if (this.child || Date.now() < this.disabledUntil) return;
    try {
      const child = spawnStreamlinkWorker();
      if (!child) {
        this.disabledUntil = Date.now() + 60_000;
        return;
      }
      this.child = child;
      this.buffer = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        if (this.child !== child) return;
        this.buffer += chunk.toString();
        if (this.buffer.length > 1_048_576) {
          this.fail();
          return;
        }
        let end: number;
        while ((end = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + 1);
          try {
            const raw: unknown = JSON.parse(line);
            if (typeof raw === "object" && raw !== null && "ready" in raw)
              continue;
            const result = responseSchema.safeParse(raw);
            if (!result.success) {
              this.fail();
              return;
            }
            const reply = result.data;
            const pending = reply.id === null ? undefined : this.pending.get(reply.id);
            if (!pending || reply.id === null) continue;
            this.pending.delete(reply.id);
            clearTimeout(pending.timer);
            // A failed lookup fails only itself; the worker stays warm for
            // the next channel, and the caller falls back to the CLI.
            if ("error" in reply) pending.reject(new Error("Background resolver could not resolve that channel."));
            else pending.resolve(reply.streams);
          } catch {
            this.fail();
            return;
          }
        }
      });
      const failed = () => {
        if (this.child === child) this.fail();
      };
      child.on("error", failed);
      child.on("close", failed);
      child.stdin?.on("error", failed);
    } catch {
      this.fail();
    }
  }

  resolve(
    login: string,
    token: string | null,
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    this.start();
    const child = this.child;
    if (!child?.stdin || this.pending.size >= 4 || signal?.aborted) {
      return Promise.reject(new Error("Background resolver unavailable."));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(new Error("Stream resolution cancelled."));
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      this.pending.set(id, {
        resolve: (streams) => {
          cleanup();
          resolve(streams);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timer: setTimeout(() => this.fail(), 10_000),
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        child.stdin!.write(`${JSON.stringify({ id, login, token })}\n`);
      } catch {
        this.fail();
      }
    });
  }

  destroy(): void {
    this.fail();
  }

  private fail(): void {
    const child = this.child;
    this.child = null;
    this.buffer = "";
    this.disabledUntil = Date.now() + 60_000;
    child?.kill();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Background resolver unavailable."));
    }
    this.pending.clear();
  }
}
