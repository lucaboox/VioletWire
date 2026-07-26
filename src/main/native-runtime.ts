import { app } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { NativePlayerAvailability } from "../shared/player";

function resolveFromPath(executable: string): string | null {
  const result = spawnSync("where.exe", [executable], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout) return null;
  return (
    result.stdout
      .split(/\r?\n/)
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.length > 0 && existsSync(candidate)) ?? null
  );
}

function resolveExecutable(
  environmentVariables: string[],
  executable: string,
  bundledPaths: string[],
  knownPaths: string[],
): string | null {
  for (const environmentVariable of environmentVariables) {
    const override = process.env[environmentVariable]?.trim();
    if (override && existsSync(override)) return override;
  }

  const bundled = bundledPaths.find((candidate) => existsSync(candidate));
  if (bundled) return bundled;

  const fromPath = resolveFromPath(executable);
  if (fromPath) return fromPath;

  return knownPaths.find((candidate) => existsSync(candidate)) ?? null;
}

let cachedAvailability: NativePlayerAvailability | null = null;

export function getNativeRuntimeAvailability(): NativePlayerAvailability {
  if (cachedAvailability) return { ...cachedAvailability };

  const localAppData = process.env.LOCALAPPDATA ?? "";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const nativeResources = app.isPackaged
    ? path.join(process.resourcesPath, "native")
    : path.join(app.getAppPath(), "vendor", "native");
  const streamlinkPath = resolveExecutable(
    ["VIOLETWIRE_STREAMLINK_PATH", "GLINT_STREAMLINK_PATH"],
    "streamlink.exe",
    [path.join(nativeResources, "streamlink", "bin", "streamlink.exe")],
    [
      path.join(programFiles, "Streamlink", "bin", "streamlink.exe"),
      path.join(localAppData, "Programs", "Streamlink", "bin", "streamlink.exe"),
      path.join(localAppData, "Microsoft", "WinGet", "Links", "streamlink.exe"),
    ],
  );

  cachedAvailability = streamlinkPath
    ? { available: true, streamlinkPath }
    : {
        available: false,
        reason: "Streamlink is unavailable.",
      };
  return { ...cachedAvailability };
}
