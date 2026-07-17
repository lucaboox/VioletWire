import { createReadStream, promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
]);

export interface RendererServer {
  origin: string;
  close(): Promise<void>;
}

export async function startRendererServer(rendererRoot: string): Promise<RendererServer> {
  const absoluteRoot = path.resolve(rendererRoot);
  const server = createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }

    const host = request.headers.host?.toLowerCase() ?? "";
    if (!/^localhost(?::\d+)?$/.test(host)) {
      response.writeHead(403);
      response.end();
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }

    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(absoluteRoot, relativePath);
    if (
      filePath !== absoluteRoot &&
      !filePath.startsWith(`${absoluteRoot}${path.sep}`)
    ) {
      response.writeHead(403);
      response.end();
      return;
    }

    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error("Not a file");
      response.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": contentTypes.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream",
        "Cache-Control": relativePath.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Unable to determine the packaged renderer server port.");
  }

  return {
    origin: `http://localhost:${address.port}`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}
