import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RustMigrationService,
  downloadRustInstaller,
  findRustInstaller,
  parseInstallLocation,
} from "./rust-migration";

const DOWNLOADS = "https://github.com/lucaboox/VioletWire/releases/download";
const installerBytes = Buffer.from("not really an installer");
const sha256 = createHash("sha256").update(installerBytes).digest("hex");
const file = "VioletWire-Rust-Setup-0.3.5-x64.exe";

function asset(tag: string, name: string, size = 10) {
  return { name, browser_download_url: `${DOWNLOADS}/${tag}/${name}`, size };
}

/** A fetcher serving a fixed set of URLs. */
function serving(routes: Record<string, Buffer | string | object>) {
  return vi.fn(async (input: string) => {
    const body = routes[input];
    if (body === undefined) return new Response("missing", { status: 404 });
    if (Buffer.isBuffer(body)) return new Response(new Uint8Array(body));
    return new Response(typeof body === "string" ? body : JSON.stringify(body));
  });
}

const RELEASES = "https://api.github.com/repos/lucaboox/VioletWire/releases?per_page=50";

describe("findRustInstaller", () => {
  it("passes over Electron releases and takes the newest Rust one", async () => {
    const fetcher = serving({
      [RELEASES]: [
        { draft: false, assets: [asset("v0.3.5", "latest.yml"), asset("v0.3.5", "VioletWire-Setup.exe")] },
        { draft: true, assets: [asset("rust-v9", "violetwire-rust.json"), asset("rust-v9", file)] },
        { draft: false, assets: [asset("rust-v0.3.5", "violetwire-rust.json"), asset("rust-v0.3.5", file)] },
      ],
      [`${DOWNLOADS}/rust-v0.3.5/violetwire-rust.json`]: { version: "0.3.5", file, sha256: sha256.toUpperCase() },
    });
    await expect(findRustInstaller(fetcher)).resolves.toEqual({
      version: "0.3.5",
      file,
      url: `${DOWNLOADS}/rust-v0.3.5/${file}`,
      sha256,
    });
  });

  it("refuses a manifest that names a path, or assets hosted elsewhere", async () => {
    const elsewhere = { name: file, browser_download_url: `https://evil.example/${file}`, size: 10 };
    const fetcher = serving({
      [RELEASES]: [
        { draft: false, assets: [asset("rust-a", "violetwire-rust.json"), asset("rust-a", file)] },
        { draft: false, assets: [asset("rust-b", "violetwire-rust.json"), elsewhere] },
      ],
      [`${DOWNLOADS}/rust-a/violetwire-rust.json`]: { version: "0.3.5", file: "../evil.exe", sha256 },
      [`${DOWNLOADS}/rust-b/violetwire-rust.json`]: { version: "0.3.5", file, sha256 },
    });
    await expect(findRustInstaller(fetcher)).resolves.toBeNull();
  });
});

describe("downloadRustInstaller", () => {
  let directory = "";
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "violetwire-migration-"));
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("keeps an installer whose checksum matches and refuses one that does not", async () => {
    const url = `${DOWNLOADS}/rust-v0.3.5/${file}`;
    const fetcher = serving({ [url]: installerBytes });
    const saved = await downloadRustInstaller({ version: "0.3.5", file, url, sha256 }, directory, fetcher);
    expect(await fs.readFile(saved)).toEqual(installerBytes);

    const other = path.join(directory, "other");
    await expect(
      downloadRustInstaller({ version: "0.3.5", file, url, sha256: "0".repeat(64) }, other, fetcher),
    ).rejects.toThrow(/checksum/);
    await expect(fs.stat(path.join(other, file))).rejects.toThrow();
  });
});

describe("RustMigrationService", () => {
  let directory = "";
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "violetwire-migration-"));
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("opens an installed Rust build, but never this build itself", async () => {
    const executable = path.join(directory, "VioletWire.exe");
    await fs.writeFile(executable, "");
    const launch = vi.fn();
    const base = { temporaryDirectory: directory, readRustInstallLocation: async () => directory, launch };

    const service = new RustMigrationService({ ...base, ownExecutable: String.raw`C:\Program Files\VioletWire\VioletWire.exe` });
    await expect(service.openInstalledRust()).resolves.toBe(true);
    expect(launch).toHaveBeenCalledWith(executable, []);

    launch.mockClear();
    const self = new RustMigrationService({ ...base, ownExecutable: executable.toUpperCase() });
    await expect(self.openInstalledRust()).resolves.toBe(false);
    const absent = new RustMigrationService({ ...base, ownExecutable: "x", readRustInstallLocation: async () => null });
    await expect(absent.openInstalledRust()).resolves.toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });

  it("runs the verified installer with the removal flag", async () => {
    const launch = vi.fn();
    const fetcher = serving({
      [RELEASES]: [{ draft: false, assets: [asset("rust-v0.3.5", "violetwire-rust.json"), asset("rust-v0.3.5", file)] }],
      [`${DOWNLOADS}/rust-v0.3.5/violetwire-rust.json`]: { version: "0.3.5", file, sha256 },
      [`${DOWNLOADS}/rust-v0.3.5/${file}`]: installerBytes,
    });
    const service = new RustMigrationService({ fetcher, temporaryDirectory: directory, ownExecutable: "x", launch });
    await expect(service.installRust()).resolves.toBe(true);
    expect(launch).toHaveBeenCalledWith(path.join(directory, file), [
      "/SILENT",
      "/SUPPRESSMSGBOXES",
      "/NORESTART",
      "/RELAUNCH",
      "/REMOVEELECTRON",
    ]);
  });

  it("does nothing when no Rust release exists", async () => {
    const launch = vi.fn();
    const fetcher = serving({ [RELEASES]: [{ draft: false, assets: [asset("v0.3.5", "latest.yml")] }] });
    const service = new RustMigrationService({ fetcher, temporaryDirectory: directory, ownExecutable: "x", launch });
    await expect(service.installRust()).resolves.toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("parseInstallLocation", () => {
  it("reads reg.exe's answer", () => {
    const location = String.raw`C:\Users\A B\AppData\Local\Programs\VioletWire Rust`;
    const output = [
      "",
      String.raw`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\{6F0B9C2E}_is1`,
      `    InstallLocation    REG_SZ    ${location}`,
      "",
    ].join("\r\n");
    expect(parseInstallLocation(output)).toBe(location);
    expect(parseInstallLocation("ERROR: The system was unable to find the specified registry key")).toBeNull();
    expect(parseInstallLocation("    InstallLocation    REG_SZ    relative/path")).toBeNull();
  });
});
