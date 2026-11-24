import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Moves an installed Electron VioletWire onto the Rust build.
 *
 * electron-updater can only install another Electron build, so this release
 * does the move itself: it finds the newest Rust release on the project's
 * GitHub releases, downloads its installer, checks it against the SHA-256 in
 * that release's manifest, and runs it. The Rust installer then removes this
 * Electron install (`/REMOVEELECTRON`) and opens the new app.
 *
 * If the Rust build is already installed — the move ran before but this
 * install could not be removed, because the administrator prompt was declined
 * — this just opens it instead.
 *
 * Nothing here is fatal: on any failure VioletWire carries on as it is and
 * tries again at the next launch.
 */

const REPOSITORY = "lucaboox/VioletWire";
const RELEASES_URL = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=50`;
const ASSET_PREFIX = `https://github.com/${REPOSITORY}/releases/download/`;
const MANIFEST_NAME = "violetwire-rust.json";
const MAX_RELEASES_BYTES = 2_000_000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_INSTALLER_BYTES = 400 * 1024 * 1024;
/** The Rust installer's Inno Setup AppId (rust/packaging/violetwire.iss). */
const RUST_UNINSTALL_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{6F0B9C2E-6E51-4F2D-9A3B-4D6A2E7C9B10}_is1";
const RUST_EXECUTABLE = "VioletWire.exe";
/** As the Rust app's own updater runs it, plus the removal of this install. */
const INSTALLER_ARGUMENTS = [
  "/SILENT",
  "/SUPPRESSMSGBOXES",
  "/NORESTART",
  "/RELAUNCH",
  "/REMOVEELECTRON",
];

const releasesSchema = z
  .array(
    z.object({
      draft: z.boolean(),
      assets: z
        .array(
          z.object({
            name: z.string().min(1).max(200),
            browser_download_url: z.string().max(1_000),
            size: z.number().int().nonnegative(),
          }),
        )
        .max(100),
    }),
  )
  .max(100);

const manifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/).max(64),
  file: z.string().regex(/^[A-Za-z0-9._-]+\.exe$/).max(200),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
});

export interface RustInstaller {
  version: string;
  file: string;
  url: string;
  sha256: string;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface RustMigrationDependencies {
  fetcher?: Fetcher;
  /** Where the installer is downloaded to. */
  temporaryDirectory: string;
  /** This Electron build's own executable, never mistaken for the Rust one. */
  ownExecutable: string;
  /** The Rust build's install folder from the registry, if it is installed. */
  readRustInstallLocation?: () => Promise<string | null>;
  /** Starts a program on its own, outliving this process. */
  launch?: (file: string, args: string[]) => void;
}

function isReleaseAsset(url: string): boolean {
  return url.startsWith(ASSET_PREFIX);
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) throw new Error("The download is larger than expected.");
  if (!response.body) throw new Error("The download had no content.");
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("The download is larger than expected.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * The newest published release that carries a Rust build: one with the
 * manifest and the installer it names, both on the project's own releases.
 */
export async function findRustInstaller(fetcher: Fetcher = fetch): Promise<RustInstaller | null> {
  const response = await fetcher(RELEASES_URL, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
  const releases = releasesSchema.parse(
    JSON.parse((await readLimited(response, MAX_RELEASES_BYTES)).toString("utf8")),
  );
  for (const release of releases) {
    if (release.draft) continue;
    const manifestAsset = release.assets.find((asset) => asset.name === MANIFEST_NAME);
    if (!manifestAsset || !isReleaseAsset(manifestAsset.browser_download_url)) continue;
    const manifestResponse = await fetcher(manifestAsset.browser_download_url);
    if (!manifestResponse.ok) continue;
    const manifest = manifestSchema.safeParse(
      JSON.parse((await readLimited(manifestResponse, MAX_MANIFEST_BYTES)).toString("utf8")),
    );
    if (!manifest.success) continue;
    const installer = release.assets.find((asset) => asset.name === manifest.data.file);
    if (
      !installer ||
      !isReleaseAsset(installer.browser_download_url) ||
      installer.size > MAX_INSTALLER_BYTES
    ) {
      continue;
    }
    return {
      version: manifest.data.version,
      file: manifest.data.file,
      url: installer.browser_download_url,
      sha256: manifest.data.sha256.toLowerCase(),
    };
  }
  return null;
}

/** Downloads the installer and returns its path once its SHA-256 matches. */
export async function downloadRustInstaller(
  installer: RustInstaller,
  directory: string,
  fetcher: Fetcher = fetch,
): Promise<string> {
  const response = await fetcher(installer.url);
  if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
  const bytes = await readLimited(response, MAX_INSTALLER_BYTES);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== installer.sha256) {
    throw new Error("The downloaded installer did not match its checksum.");
  }
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, installer.file);
  await fs.writeFile(target, bytes);
  return target;
}

/** `InstallLocation` from the Rust installer's uninstall entry. */
export function parseInstallLocation(regOutput: string): string | null {
  const match = /^\s*InstallLocation\s+REG_SZ\s+(.+?)\s*$/m.exec(regOutput);
  const location = match?.[1];
  return location && path.win32.isAbsolute(location) ? location : null;
}

function readRustInstallLocationFromRegistry(): Promise<string | null> {
  const reg = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
  return new Promise((resolve) => {
    execFile(
      reg,
      ["query", RUST_UNINSTALL_KEY, "/v", "InstallLocation"],
      { windowsHide: true, timeout: 5_000 },
      (error, stdout) => resolve(error ? null : parseInstallLocation(stdout)),
    );
  });
}

function launchDetached(file: string, args: string[]): void {
  spawn(file, args, { detached: true, stdio: "ignore", windowsHide: false }).unref();
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

export class RustMigrationService {
  private readonly fetcher: Fetcher;
  private readonly readRustInstallLocation: () => Promise<string | null>;
  private readonly launch: (file: string, args: string[]) => void;

  constructor(private readonly dependencies: RustMigrationDependencies) {
    this.fetcher = dependencies.fetcher ?? fetch;
    this.readRustInstallLocation =
      dependencies.readRustInstallLocation ?? readRustInstallLocationFromRegistry;
    this.launch = dependencies.launch ?? launchDetached;
  }

  /** Opens the Rust build if it is already installed. Quick: no network. */
  async openInstalledRust(): Promise<boolean> {
    const location = await this.readRustInstallLocation();
    if (!location) return false;
    const executable = path.win32.join(location, RUST_EXECUTABLE);
    if (
      executable.toLowerCase() === this.dependencies.ownExecutable.toLowerCase() ||
      !(await exists(executable))
    ) {
      return false;
    }
    this.launch(executable, []);
    return true;
  }

  /** Downloads, checks and starts the Rust installer. */
  async installRust(): Promise<boolean> {
    const installer = await findRustInstaller(this.fetcher);
    if (!installer) return false;
    const file = await downloadRustInstaller(
      installer,
      this.dependencies.temporaryDirectory,
      this.fetcher,
    );
    this.launch(file, INSTALLER_ARGUMENTS);
    return true;
  }
}
