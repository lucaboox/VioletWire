import type { Session } from "electron";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_SCHEME,
  registerAppProtocol,
  resolveAppAssetPath,
} from "./app-protocol";

type ProtocolHandler = (request: Request) => Response | Promise<Response>;

describe("app protocol", () => {
  let rendererDirectory: string;
  let handler: ProtocolHandler;
  let fetchFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    rendererDirectory = await mkdtemp(
      path.join(tmpdir(), "violetwire-app-protocol-"),
    );
    await mkdir(path.join(rendererDirectory, "assets"));
    await writeFile(
      path.join(rendererDirectory, "index.html"),
      "<main>VioletWire</main>",
    );
    fetchFile = vi.fn(
      async () =>
        new Response("<main>VioletWire</main>", {
          headers: { "Content-Type": "text/html" },
        }),
    );
    const target = {
      fetch: fetchFile,
      protocol: {
        handle: vi.fn((scheme: string, registered: ProtocolHandler) => {
          expect(scheme).toBe(APP_SCHEME);
          handler = registered;
        }),
      },
    } as unknown as Session;
    registerAppProtocol(target, rendererDirectory, async () => null);
  });

  afterEach(async () => {
    await rm(rendererDirectory, { force: true, recursive: true });
  });

  it("serves the root index with hardened no-cache headers", async () => {
    const response = await handler(new Request("violetwire://app/"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("<main>VioletWire</main>");
    expect(fetchFile).toHaveBeenCalledOnce();
  });

  it("rejects non-read requests before touching the filesystem", async () => {
    const response = await handler(
      new Request("violetwire://app/index.html", { method: "POST" }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it("rejects another authority and directories", async () => {
    const foreign = await handler(new Request("violetwire://other/index.html"));
    const directory = await handler(new Request("violetwire://app/assets/"));

    expect(foreign.status).toBe(404);
    expect(directory.status).toBe(404);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it("maps encoded assets inside the renderer directory", () => {
    expect(
      resolveAppAssetPath(rendererDirectory, "/assets/app%20shell.js"),
    ).toBe(path.join(rendererDirectory, "assets", "app shell.js"));
  });

  it("rejects traversal and malformed URL encoding", () => {
    expect(
      resolveAppAssetPath(rendererDirectory, "/%5c..%5csecret.txt"),
    ).toBeNull();
    expect(resolveAppAssetPath(rendererDirectory, "/assets/%")).toBeNull();
  });
});
