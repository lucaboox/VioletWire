import { app, BrowserWindow, safeStorage, session, type Session } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PlaybackSessionState } from "../shared/twitch";
import {
  APP_UI_PARTITION,
  TWITCH_WEBSITE_PARTITION,
} from "./session-partitions";

const storedPlaybackSessionSchema = z.object({
  token: z.string().min(20),
  login: z.string().optional(),
});

export class PlaybackSessionService {
  private token: string | null = null;
  private login: string | undefined;
  private loginWindow: BrowserWindow | null = null;
  private sessionConfigured = false;

  constructor(
    private readonly getMainWindow: () => BrowserWindow | null,
    private readonly iconPath: string,
  ) {}

  private get storagePath(): string {
    return path.join(app.getPath("userData"), "twitch-playback-session.bin");
  }

  private get twitchSession(): Session {
    return session.fromPartition(TWITCH_WEBSITE_PARTITION);
  }

  private get appUiSession(): Session {
    return session.fromPartition(APP_UI_PARTITION);
  }

  async initialize(): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) return;
    try {
      const encrypted = await fs.readFile(this.storagePath);
      const stored = storedPlaybackSessionSchema.parse(
        JSON.parse(safeStorage.decryptString(encrypted)),
      );
      this.token = stored.token;
      this.login = stored.login;
      await this.syncAppUiCookie(stored.token);
    } catch {
      this.token = null;
      this.login = undefined;
    }
  }

  getToken(): string | null {
    return this.token;
  }

  getState(): PlaybackSessionState {
    return this.token
      ? {
          linked: true,
          login: this.login,
          message: "Experimental website playback session is linked.",
        }
      : {
          linked: false,
          message: "Twitch website playback is not linked.",
        };
  }

  async link(): Promise<PlaybackSessionState> {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.focus();
      return this.getState();
    }

    const owner = this.getMainWindow();
    const authSession = this.twitchSession;
    if (!this.sessionConfigured) {
      authSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      authSession.on("will-download", (event) => event.preventDefault());
      this.sessionConfigured = true;
    }

    const loginWindow = new BrowserWindow({
      parent: owner ?? undefined,
      icon: this.iconPath,
      width: 760,
      height: 760,
      minWidth: 560,
      minHeight: 620,
      title: "Link Twitch playback session",
      autoHideMenuBar: true,
      backgroundColor: "#0e0e10",
      webPreferences: {
        partition: TWITCH_WEBSITE_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.loginWindow = loginWindow;
    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (this.isAllowedLoginNavigation(url)) void loginWindow.loadURL(url);
      return { action: "deny" };
    });
    loginWindow.webContents.on("will-navigate", (event, url) => {
      if (!this.isAllowedLoginNavigation(url)) event.preventDefault();
    });
    loginWindow.webContents.on("will-redirect", (event, url) => {
      if (!this.isAllowedLoginNavigation(url)) event.preventDefault();
    });

    return new Promise<PlaybackSessionState>((resolve, reject) => {
      let settled = false;
      const finish = (state: PlaybackSessionState) => {
        if (settled) return;
        settled = true;
        authSession.cookies.removeListener("changed", cookieListener);
        resolve(state);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        authSession.cookies.removeListener("changed", cookieListener);
        reject(error);
      };
      const acceptCookie = (cookie: Electron.Cookie) => {
        if (
          cookie.name !== "auth-token" ||
          !cookie.value ||
          !this.isTwitchHostname(cookie.domain ?? "")
        ) {
          return;
        }
        void this.acceptToken(cookie.value)
          .then((state) => {
            finish(state);
            if (!loginWindow.isDestroyed()) loginWindow.close();
          })
          .catch(fail);
      };
      const cookieListener = (
        _event: Electron.Event,
        cookie: Electron.Cookie,
        _cause: string,
        removed: boolean,
      ) => {
        if (!removed) acceptCookie(cookie);
      };

      authSession.cookies.on("changed", cookieListener);
      loginWindow.webContents.on("did-finish-load", () => {
        void authSession.cookies
          .get({ url: "https://www.twitch.tv", name: "auth-token" })
          .then((cookies) => {
            const cookie = cookies[0];
            if (cookie) acceptCookie(cookie);
          })
          .catch(() => undefined);
      });
      loginWindow.on("closed", () => {
        this.loginWindow = null;
        finish(this.getState());
      });
      void loginWindow.loadURL("https://www.twitch.tv/login").catch((error: unknown) => {
        fail(error);
      });
    });
  }

  async unlink(): Promise<PlaybackSessionState> {
    this.token = null;
    this.login = undefined;
    try {
      await fs.unlink(this.storagePath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await this.twitchSession.clearStorageData({
      storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"],
    });
    await this.appUiSession.cookies.remove("https://www.twitch.tv", "auth-token");
    return this.getState();
  }

  private async acceptToken(token: string): Promise<PlaybackSessionState> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Windows protected storage is unavailable; the playback session was not saved.");
    }
    let login: string | undefined;
    try {
      const response = await fetch("https://id.twitch.tv/oauth2/validate", {
        headers: { Authorization: `OAuth ${token}` },
      });
      if (response.ok) {
        const payload = z.object({ login: z.string().optional() }).parse(await response.json());
        login = payload.login;
      }
    } catch {
      // The website cookie can still be valid for playback if validation is temporarily unavailable.
    }
    this.token = token;
    this.login = login;
    await this.syncAppUiCookie(token);
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
    await fs.writeFile(
      this.storagePath,
      safeStorage.encryptString(JSON.stringify({ token, login })),
      { mode: 0o600 },
    );
    return this.getState();
  }

  private async syncAppUiCookie(token: string): Promise<void> {
    await this.appUiSession.cookies.set({
      url: "https://www.twitch.tv",
      name: "auth-token",
      value: token,
      domain: ".twitch.tv",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "no_restriction",
    });
  }

  private isTwitchHostname(rawHostname: string): boolean {
    const hostname = rawHostname.toLowerCase().replace(/^\./, "");
    return hostname === "twitch.tv" || hostname.endsWith(".twitch.tv");
  }

  private isAllowedLoginNavigation(rawUrl: string): boolean {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:") return false;
      const hostname = url.hostname.toLowerCase();
      return (
        this.isTwitchHostname(hostname) ||
        hostname === "accounts.google.com" ||
        hostname === "appleid.apple.com" ||
        hostname === "amazon.com" ||
        hostname.endsWith(".amazon.com")
      );
    } catch {
      return false;
    }
  }
}
