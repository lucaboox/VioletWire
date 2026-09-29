import { app } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  spawn,
  type ChildProcess,
} from "node:child_process";

interface StreamlinkSpawnOptions {
  windowsHide: boolean;
  stdio: ["ignore", "ignore" | "pipe", "ignore" | "pipe"];
}

function resolveSecureRuntime(): { launcherPath: string; pythonPath: string } | null {
  const nativeRoot = app.isPackaged
    ? path.join(process.resourcesPath, "native")
    : path.join(app.getAppPath(), "vendor", "native");
  const launcherPath = app.isPackaged
    ? path.join(process.resourcesPath, "native", "streamlink-launcher.py")
    : path.join(app.getAppPath(), "native", "streamlink-launcher.py");
  const pythonPath = path.join(nativeRoot, "streamlink", "Python", "python.exe");
  return existsSync(launcherPath) && existsSync(pythonPath)
    ? { launcherPath, pythonPath }
    : null;
}

/** Credentials a Streamlink run may need, none of which may reach its argv. */
export interface StreamlinkSecrets {
  /** The Twitch website token, sent as Streamlink's Twitch API header. */
  twitchToken: string | null;
  /** A `name=value` cookie sent with every request, such as Kick's session. */
  httpCookie?: string | null;
}

/**
 * Starts Streamlink without placing a secret in Windows' process command line,
 * where any other program on the machine can read it. Anonymous launches keep
 * using the normal executable. A launch carrying a Twitch token or a session
 * cookie goes through the bundled Python runtime instead, which receives them
 * over a private stdin pipe and runs the same Streamlink CLI in-process.
 */
export function spawnStreamlink(
  streamlinkPath: string,
  arguments_: string[],
  secrets: StreamlinkSecrets,
  options: StreamlinkSpawnOptions,
): ChildProcess {
  const token = secrets.twitchToken || null;
  const httpCookie = secrets.httpCookie || null;
  if (!token && !httpCookie) return spawn(streamlinkPath, arguments_, options);

  const runtime = resolveSecureRuntime();
  if (!runtime) {
    // Never fall back to putting a secret in argv. External/unbundled
    // Streamlink installs can still play anonymously.
    console.warn(
      "[streamlink] Secure authentication bridge unavailable; continuing anonymously.",
    );
    return spawn(streamlinkPath, arguments_, options);
  }

  const child: ChildProcess = spawn(runtime.pythonPath, [runtime.launcherPath], {
    ...options,
    stdio: ["pipe", options.stdio[1], options.stdio[2]],
  });
  child.stdin?.on("error", () => {
    // A fast startup failure can close stdin before the payload is flushed.
    // The child error/exit handlers at the call site report the useful error.
  });
  child.stdin?.end(
    `${JSON.stringify({ arguments: arguments_, token, httpCookie })}\n`,
    "utf8",
  );
  return child;
}

export function redactSensitivePlaybackText(text: string): string {
  return text
    .replace(
      /(Authorization(?:=|%3D)OAuth(?:\s|%20)+)[A-Za-z0-9._~-]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /([?&](?:token|sig|signature|authorization)=)[^&\s]+/gi,
      "$1[REDACTED]",
    );
}
