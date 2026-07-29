import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { TwitchAccount } from "../shared/twitch";

vi.mock("electron", async () => {
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const userDataDirectory = join(tmpdir(), "violetwire-twitch-service-tests");
  return {
    app: { getPath: () => userDataDirectory },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value, "utf8"),
      decryptString: (buffer: Buffer) => buffer.toString("utf8"),
    },
    shell: { openExternal: vi.fn() },
  };
});

import { TwitchService, VALIDATION_LIFETIME } from "./twitch-service";

const CLIENT_ID = "muthgxeegar3t0hj2qwm0ozocqbt8o";
// Must match the directory built inside the electron mock factory above.
const userDataDirectory = join(tmpdir(), "violetwire-twitch-service-tests");
const tokenFilePath = join(userDataDirectory, "twitch-auth.bin");

interface StoredTokenShape {
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  expiresAt: number;
}

interface TwitchServiceInternals {
  token: StoredTokenShape | null;
  account: TwitchAccount | null;
  validatedAt: number;
  sessionGeneration: number;
  validationTimer: NodeJS.Timeout | null;
  ensureAuthenticated(): Promise<void>;
  refreshToken(clientId: string): Promise<void>;
  writeToken(token: StoredTokenShape): Promise<void>;
  helix(
    requestPath: string,
    schema: z.ZodType<unknown>,
    init?: RequestInit,
    validateFirst?: boolean,
  ): Promise<unknown>;
}

const testAccount: TwitchAccount = {
  id: "42",
  login: "tester",
  displayName: "Tester",
  profileImageUrl: "https://example.com/avatar.png",
};

const validatePayload = {
  client_id: CLIENT_ID,
  login: "tester",
  user_id: "42",
  scopes: [],
  expires_in: 12_000,
};

const refreshedTokenPayload = {
  access_token: "access-2",
  refresh_token: "refresh-2",
  expires_in: 12_000,
  scope: [],
};

const accountPayload = {
  data: [
    {
      id: "42",
      login: "tester",
      display_name: "Tester",
      profile_image_url: "https://example.com/avatar.png",
    },
  ],
};

const broadcasterPayload = {
  data: [
    {
      id: "77",
      login: "somechannel",
      display_name: "SomeChannel",
      profile_image_url: "https://example.com/channel.png",
    },
  ],
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function defaultRoutes(url: string): Response {
  if (url.includes("api.ivr.fi/v2/twitch/subage/")) {
    return json({ statusHidden: false, meta: null, cumulative: { months: 0 }, followedAt: null });
  }
  if (url.includes("/oauth2/validate")) return json(validatePayload);
  if (url.includes("/oauth2/token")) return json(refreshedTokenPayload);
  if (url.includes("/helix/users")) return json(accountPayload);
  throw new Error(`Unexpected request in test: ${url}`);
}

function chatAssetRoutes(url: string): Response {
  if (url.includes("/helix/users?login=")) return json(broadcasterPayload);
  if (url.includes("/helix/chat/badges/global")) {
    return json({
      data: [
        {
          set_id: "subscriber",
          versions: [
            { id: "1", title: "Subscriber", image_url_2x: "https://example.com/badge.png" },
          ],
        },
      ],
    });
  }
  if (url.includes("/helix/chat/badges?")) return json({ data: [] });
  if (url.includes("/helix/chat/emotes/global")) {
    return json({
      data: [
        { id: "e1", name: "GlobalEmote", images: { url_2x: "https://example.com/emote.png" } },
      ],
    });
  }
  if (url.includes("/helix/chat/emotes?")) return json({ data: [] });
  return defaultRoutes(url);
}

let fetchMock: ReturnType<typeof vi.fn>;

function installFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal("fetch", fetchMock);
}

function requestCount(urlFragment: string): number {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes(urlFragment)).length;
}

function createService(tokenOverrides: Partial<StoredTokenShape> = {}): {
  service: TwitchService;
  internals: TwitchServiceInternals;
} {
  const service = new TwitchService();
  const internals = service as unknown as TwitchServiceInternals;
  internals.token = {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    scopes: [],
    expiresAt: Date.now() + 3_600_000,
    ...tokenOverrides,
  };
  return { service, internals };
}

beforeEach(async () => {
  delete process.env.TWITCH_CLIENT_ID;
  await fs.rm(userDataDirectory, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("TwitchService stream tags", () => {
  it("normalizes null Twitch tags and carries valid tags into category cards", async () => {
    installFetch((url) => {
      if (url.includes("/helix/streams?")) {
        return json({
          data: [
            {
              id: "stream-null-tags",
              user_id: "77",
              user_login: "somechannel",
              user_name: "SomeChannel",
              game_id: "509658",
              game_name: "Just Chatting",
              title: "Null tags should still load",
              viewer_count: 123,
              started_at: "2026-07-18T00:00:00Z",
              language: "en",
              tags: null,
              thumbnail_url: "https://example.com/{width}x{height}.jpg",
              is_mature: false,
            },
            {
              id: "stream-with-tags",
              user_id: "78",
              user_login: "taggedchannel",
              user_name: "TaggedChannel",
              game_id: "509658",
              game_name: "Just Chatting",
              title: "Tags should reach the card",
              viewer_count: 45,
              started_at: "2026-07-18T00:00:00Z",
              language: "en",
              tags: ["English", "DropsEnabled"],
              thumbnail_url: "https://example.com/{width}x{height}.jpg",
              is_mature: false,
            },
          ],
          pagination: {},
        });
      }
      if (url.includes("/helix/users?")) {
        return json({
          data: [
            {
              id: "77",
              login: "somechannel",
              display_name: "SomeChannel",
              profile_image_url: "https://example.com/channel.png",
            },
            {
              id: "78",
              login: "taggedchannel",
              display_name: "TaggedChannel",
              profile_image_url: "https://example.com/tagged.png",
            },
          ],
        });
      }
      return defaultRoutes(url);
    });
    const { service, internals } = createService();
    internals.account = testAccount;
    internals.validatedAt = Date.now();

    const result = await service.getCategoryStreams("509658");

    expect(result.items.map((stream) => stream.tags)).toEqual([
      [],
      ["English", "DropsEnabled"],
    ]);
  });
});

describe("TwitchService authentication", () => {
  it("reuses a successful validation within the cache interval", async () => {
    installFetch(defaultRoutes);
    const { service } = createService();

    await service.getAuthState();
    await service.getAuthState();

    expect(requestCount("/oauth2/validate")).toBe(1);
    expect(requestCount("/helix/users")).toBe(1);
  });

  it("validates again once the cached validation is stale", async () => {
    installFetch(defaultRoutes);
    const { service, internals } = createService();

    await service.getAuthState();
    internals.validatedAt = Date.now() - 56 * 60_000;
    await service.getAuthState();

    expect(requestCount("/oauth2/validate")).toBe(2);
  });

  it("shares one validation between concurrent authentication checks", async () => {
    let releaseValidate!: () => void;
    const validateGate = new Promise<void>((resolve) => {
      releaseValidate = resolve;
    });
    installFetch(async (url) => {
      if (url.includes("/oauth2/validate")) {
        await validateGate;
        return json(validatePayload);
      }
      return defaultRoutes(url);
    });
    const { service } = createService();

    const pending = Promise.all([service.getAuthState(), service.getAuthState()]);
    releaseValidate();
    const [first, second] = await pending;

    expect(first.status).toBe("signed-in");
    expect(second.status).toBe("signed-in");
    expect(requestCount("/oauth2/validate")).toBe(1);
  });

  it("shares one refresh between concurrent expired-token requests", async () => {
    installFetch(defaultRoutes);
    const { service, internals } = createService({ expiresAt: Date.now() - 1_000 });

    await Promise.all([service.getAuthState(), service.getAuthState()]);

    expect(requestCount("/oauth2/token")).toBe(1);
    expect(internals.token?.accessToken).toBe("access-2");
    expect(internals.token?.refreshToken).toBe("refresh-2");
  });

  it("propagates one refresh failure to all concurrent callers without a second refresh", async () => {
    installFetch(async (url) => {
      if (url.includes("/oauth2/token")) return json({ message: "Invalid refresh token" }, 400);
      return defaultRoutes(url);
    });
    const { internals } = createService();

    const first = internals.refreshToken(CLIENT_ID);
    const second = internals.refreshToken(CLIENT_ID);

    await expect(first).rejects.toThrow("Invalid refresh token");
    await expect(second).rejects.toThrow("Invalid refresh token");
    expect(requestCount("/oauth2/token")).toBe(1);
    expect(internals.token?.refreshToken).toBe("refresh-1");
  });

  it("retries a Helix request exactly once after a 401", async () => {
    installFetch((url) => {
      if (url.includes("/helix/users")) return json({ message: "Invalid OAuth token" }, 401);
      return defaultRoutes(url);
    });
    const { service, internals } = createService();
    internals.account = testAccount;
    internals.validatedAt = Date.now();

    await expect(service.getStreamMetadata("somechannel")).rejects.toThrow(
      "Invalid OAuth token",
    );

    expect(requestCount("/helix/users")).toBe(2);
    expect(requestCount("/oauth2/token")).toBe(1);
  });

  it("does not record a validation timestamp after a failed validation", async () => {
    installFetch((url) => {
      if (url.includes("/oauth2/validate")) return json({ message: "unavailable" }, 500);
      return defaultRoutes(url);
    });
    const { internals } = createService();

    await expect(internals.ensureAuthenticated()).rejects.toThrow();
    expect(internals.validatedAt).toBe(0);
  });

  it("stays signed out when sign-out happens during a delayed refresh", async () => {
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    installFetch(async (url) => {
      if (url.includes("/oauth2/token")) {
        await refreshGate;
        return json(refreshedTokenPayload);
      }
      return defaultRoutes(url);
    });
    const { service, internals } = createService({ expiresAt: Date.now() - 1_000 });

    const pendingAuth = service.getAuthState();
    const pendingSignOut = service.signOut();
    releaseRefresh();
    const signOutState = await pendingSignOut;
    const staleAuthState = await pendingAuth;

    expect(signOutState.status).toBe("signed-out");
    expect(staleAuthState.status).toBe("signed-out");
    expect(internals.token).toBeNull();
    expect((await service.getAuthState()).status).toBe("signed-out");
    // The stale refresh result must never recreate the credential file.
    await expect(fs.access(tokenFilePath)).rejects.toThrow();
    expect(requestCount("/oauth2/token")).toBe(1);
  });

  it("keeps credentials across a transient scheduled-validation failure", async () => {
    vi.useFakeTimers();
    let failValidate = false;
    installFetch((url) => {
      if (url.includes("/oauth2/validate") && failValidate) {
        return json({ message: "service unavailable" }, 500);
      }
      return defaultRoutes(url);
    });
    const { service, internals } = createService();

    await service.getAuthState();
    failValidate = true;
    await vi.advanceTimersByTimeAsync(VALIDATION_LIFETIME + 1_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(internals.token).not.toBeNull();
    expect((await service.getAuthState()).status).toBe("signed-in");
  });
});

describe("TwitchService scheduled validation", () => {
  it("revalidates on the hourly timer without duplicate timers", async () => {
    vi.useFakeTimers();
    installFetch(defaultRoutes);
    const { service, internals } = createService();

    await service.getAuthState();
    expect(requestCount("/oauth2/validate")).toBe(1);
    expect(internals.validationTimer).not.toBeNull();
    const firstTimer = internals.validationTimer;

    await vi.advanceTimersByTimeAsync(VALIDATION_LIFETIME + 1_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(requestCount("/oauth2/validate")).toBe(2);
    // The successful scheduled check must reuse the timer, not add another.
    expect(internals.validationTimer).toBe(firstTimer);
  });

  it("stops the validation timer on sign-out", async () => {
    vi.useFakeTimers();
    installFetch(defaultRoutes);
    const { service, internals } = createService();

    await service.getAuthState();
    expect(internals.validationTimer).not.toBeNull();

    await service.signOut();
    expect(internals.validationTimer).toBeNull();

    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(3 * VALIDATION_LIFETIME);
    expect(requestCount("/oauth2/validate")).toBe(0);
  });

  it("clears credentials when scheduled validation confirms they are invalid", async () => {
    vi.useFakeTimers();
    let rejectValidation = false;
    installFetch((url) => {
      if (url.includes("/oauth2/validate") && rejectValidation) {
        return json({ message: "Invalid OAuth token" }, 401);
      }
      return defaultRoutes(url);
    });
    const { service, internals } = createService();
    await internals.writeToken(internals.token!);

    await service.getAuthState();
    rejectValidation = true;
    await vi.advanceTimersByTimeAsync(VALIDATION_LIFETIME + 1_000);
    await vi.waitFor(() => expect(internals.token).toBeNull());

    expect(internals.account).toBeNull();
    expect(internals.validationTimer).toBeNull();
    await expect(fs.access(tokenFilePath)).rejects.toThrow();
  });
});

describe("TwitchService credential storage", () => {
  it("writes the credential file atomically without leaving temporary files", async () => {
    installFetch(defaultRoutes);
    const { internals } = createService();
    const stored = {
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      scopes: [],
      expiresAt: 123,
    };

    await internals.writeToken(stored);

    const entries = await fs.readdir(userDataDirectory);
    expect(entries).toContain("twitch-auth.bin");
    expect(entries.filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
    // The mock encrypter is an identity transform, so the file is JSON.
    const persisted = JSON.parse((await fs.readFile(tokenFilePath)).toString("utf8"));
    expect(persisted).toEqual(stored);
  });
});

describe("TwitchService Helix 401 coordination", () => {
  it("shares one refresh across delayed concurrent 401 responses", async () => {
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const authorizationOf = (init?: RequestInit): string =>
      (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    installFetch(async (url, init) => {
      if (url.includes("/helix/first")) {
        return authorizationOf(init) === "Bearer access-2"
          ? json({ ok: true })
          : json({ message: "unauthorized" }, 401);
      }
      if (url.includes("/helix/second")) {
        if (authorizationOf(init) === "Bearer access-2") return json({ ok: true });
        await secondGate;
        return json({ message: "unauthorized" }, 401);
      }
      return defaultRoutes(url);
    });
    const { internals } = createService();
    const schema = z.object({ ok: z.boolean() });

    const firstRequest = internals.helix("/first", schema, undefined, false);
    const secondRequest = internals.helix("/second", schema, undefined, false);
    const firstResult = await firstRequest;
    // The second request's 401 arrives only after the first already
    // refreshed and replaced the token.
    releaseSecond();
    const secondResult = await secondRequest;

    expect(firstResult).toEqual({ ok: true });
    expect(secondResult).toEqual({ ok: true });
    expect(requestCount("/oauth2/token")).toBe(1);
    expect(requestCount("/helix/first")).toBe(2);
    expect(requestCount("/helix/second")).toBe(2);
  });
});

describe("TwitchService chat assets", () => {
  function createAuthenticatedService(): {
    service: TwitchService;
    internals: TwitchServiceInternals;
  } {
    const { service, internals } = createService();
    internals.account = testAccount;
    internals.validatedAt = Date.now();
    return { service, internals };
  }

  it("deduplicates concurrent chat-asset requests for the same channel", async () => {
    installFetch(chatAssetRoutes);
    const { service } = createAuthenticatedService();

    const [first, second] = await Promise.all([
      service.getChatAssets("SomeChannel"),
      service.getChatAssets("somechannel"),
    ]);

    expect(requestCount("/helix/users?login=")).toBe(1);
    expect(requestCount("/helix/chat/badges/global")).toBe(1);
    expect(requestCount("/helix/chat/emotes/global")).toBe(1);
    expect(first).toEqual(second);
    expect(first.broadcasterId).toBe("77");
  });

  it("hands out copies so callers cannot mutate the cached assets", async () => {
    installFetch(chatAssetRoutes);
    const { service } = createAuthenticatedService();

    const first = await service.getChatAssets("somechannel");
    first.badges.push({ key: "tampered", title: "Tampered", imageUrl: "https://example.com/x" });
    first.emotes[0].name = "Tampered";

    const second = await service.getChatAssets("somechannel");
    expect(second.badges).toHaveLength(1);
    expect(second.emotes[0].name).toBe("GlobalEmote");
  });

  it("evicts failed chat-asset requests so they can be retried", async () => {
    let failBroadcasterLookup = true;
    installFetch((url) => {
      if (url.includes("/helix/users?login=") && failBroadcasterLookup) {
        return json({ message: "boom" }, 500);
      }
      return chatAssetRoutes(url);
    });
    const { service } = createAuthenticatedService();

    await expect(service.getChatAssets("somechannel")).rejects.toThrow("boom");

    failBroadcasterLookup = false;
    const result = await service.getChatAssets("somechannel");

    expect(result.broadcasterId).toBe("77");
    expect(requestCount("/helix/users?login=")).toBe(2);
  });

  it("loads and groups every Twitch emote available to the signed-in user", async () => {
    installFetch((url) => {
      if (url.includes("/helix/chat/emotes/user?")) {
        return json({
          data: [
            {
              id: "subscriber-emote",
              name: "OtherChannelLove",
              owner_id: "88",
              emote_type: "subscriptions",
              tier: "1000",
              format: ["static", "animated"],
              scale: ["1.0", "2.0", "3.0"],
              theme_mode: ["light", "dark"],
            },
            {
              id: "event-emote",
              name: "EventHype",
              owner_id: "",
              emote_type: "limitedtime",
              format: ["static"],
              scale: ["1.0", "2.0"],
              theme_mode: ["dark"],
            },
          ],
          template: "https://static-cdn.jtvnw.net/emoticons/v2/{{id}}/{{format}}/{{theme_mode}}/{{scale}}",
          pagination: {},
        });
      }
      if (url.includes("/helix/users?id=88")) {
        return json({
          data: [{
            id: "88",
            login: "otherchannel",
            display_name: "OtherChannel",
            profile_image_url: "https://example.com/other-channel.png",
          }],
        });
      }
      return chatAssetRoutes(url);
    });
    const { service, internals } = createAuthenticatedService();
    if (!internals.token) throw new Error("Expected test token.");
    internals.token.scopes = ["user:read:emotes"];

    const result = await service.getChatAssets("somechannel");

    expect(result.emotes).toEqual([
      expect.objectContaining({
        id: "subscriber-emote",
        ownerId: "88",
        ownerName: "OtherChannel",
        ownerImageUrl: "https://example.com/other-channel.png",
      }),
      expect.objectContaining({
        id: "event-emote",
        scope: "global",
        categoryId: "limitedtime",
        categoryName: "Limited-time emotes",
        ownerId: undefined,
        ownerImageUrl: undefined,
      }),
    ]);
  });

  it("keeps badges and emotes when Twitch returns a non-user emote owner ID", async () => {
    installFetch((url) => {
      if (url.includes("/helix/chat/emotes/user?")) {
        return json({
          data: [{
            id: "event-emote",
            name: "EventHype",
            owner_id: "twitch",
            emote_type: "limitedtime",
            format: ["static"],
            scale: ["2.0"],
            theme_mode: ["dark"],
          }],
          template: "https://static-cdn.jtvnw.net/emoticons/v2/{{id}}/{{format}}/{{theme_mode}}/{{scale}}",
          pagination: {},
        });
      }
      return chatAssetRoutes(url);
    });
    const { service, internals } = createAuthenticatedService();
    if (!internals.token) throw new Error("Expected test token.");
    internals.token.scopes = ["user:read:emotes"];

    const result = await service.getChatAssets("somechannel");

    expect(result.badges).toHaveLength(1);
    expect(result.emotes).toEqual([
      expect.objectContaining({
        id: "event-emote",
        name: "EventHype",
        scope: "global",
        categoryId: "limitedtime",
      }),
    ]);
    expect(requestCount("/helix/users?id=twitch")).toBe(0);
  });
});

describe("TwitchService chat replies", () => {
  it("sends the official reply parent message ID to Helix", async () => {
    let requestBody: unknown;
    installFetch((url, init) => {
      if (url.includes("/helix/users?login=")) return json(broadcasterPayload);
      if (url.includes("/helix/chat/messages")) {
        requestBody = JSON.parse(String(init?.body));
        return json({ data: [{ message_id: "sent-id", is_sent: true }] });
      }
      return defaultRoutes(url);
    });
    const { service, internals } = createService();
    internals.account = testAccount;
    internals.validatedAt = Date.now();

    const sent = await service.sendChatMessage(
      "somechannel",
      "This is a reply",
      "719e45c4-5861-4c3f-932d-e34141177b0e",
    );

    expect(requestBody).toEqual({
      broadcaster_id: "77",
      sender_id: "42",
      message: "This is a reply",
      reply_parent_message_id: "719e45c4-5861-4c3f-932d-e34141177b0e",
    });
    expect(sent).toMatchObject({
      id: "sent-id",
      channel: "somechannel",
      login: "tester",
      displayName: "Tester",
      text: "This is a reply",
      pending: true,
    });
  });

  it("reuses a channel id for subsequent messages", async () => {
    let sentCount = 0;
    installFetch((url) => {
      if (url.includes("/helix/users?login=")) return json(broadcasterPayload);
      if (url.includes("/helix/chat/messages")) {
        sentCount += 1;
        return json({ data: [{ message_id: `sent-${sentCount}`, is_sent: true }] });
      }
      return defaultRoutes(url);
    });
    const { service, internals } = createService();
    internals.account = testAccount;
    internals.validatedAt = Date.now();

    await service.sendChatMessage("somechannel", "First");
    await service.sendChatMessage("somechannel", "Second");

    expect(requestCount("/helix/users?login=somechannel")).toBe(1);
    expect(requestCount("/helix/chat/messages")).toBe(2);
  });
});

describe("TwitchService chat color", () => {
  it("reads the authenticated user's current Twitch chat color", async () => {
    installFetch((url) => {
      if (url.includes("/helix/chat/color?")) {
        return json({
          data: [
            {
              user_id: "42",
              user_login: "tester",
              user_name: "Tester",
              color: "#9146FF",
            },
          ],
        });
      }
      return defaultRoutes(url);
    });
    const { service, internals } = createService({
      scopes: ["user:manage:chat_color"],
    });
    internals.account = testAccount;
    internals.validatedAt = Date.now();

    await expect(service.getChatColor()).resolves.toEqual({
      color: "#9146FF",
      canUpdate: true,
    });
  });

  it("updates a custom color through Twitch and returns the saved color", async () => {
    let updateUrl = "";
    installFetch((url, init) => {
      if (url.includes("/helix/chat/color?") && init?.method === "PUT") {
        updateUrl = url;
        return new Response(null, { status: 204 });
      }
      if (url.includes("/helix/chat/color?")) {
        return json({
          data: [
            {
              user_id: "42",
              user_login: "tester",
              user_name: "Tester",
              color: "#A970FF",
            },
          ],
        });
      }
      return defaultRoutes(url);
    });
    const { service, internals } = createService({
      scopes: ["user:manage:chat_color"],
    });
    internals.account = testAccount;
    internals.validatedAt = Date.now();

    await expect(service.updateChatColor("#A970FF")).resolves.toEqual({
      color: "#A970FF",
      canUpdate: true,
    });
    expect(updateUrl).toContain("user_id=42");
    expect(updateUrl).toContain("color=%23A970FF");
  });

  it("requires a one-time reauthorization before changing chat color", async () => {
    installFetch(defaultRoutes);
    const { service, internals } = createService();
    internals.account = testAccount;
    internals.validatedAt = Date.now();

    await expect(service.updateChatColor("blue")).rejects.toThrow(
      "Sign in with Twitch again",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("TwitchService pinned chat messages", () => {
  it("maps the currently pinned Twitch chat message", async () => {
    installFetch((url) => {
      if (url.includes("/helix/chat/pins?")) {
        return json({
          data: [
            {
              message_id: "pin-1",
              broadcaster_id: "77",
              sender_user_id: "88",
              sender_user_login: "otheruser",
              sender_user_name: "OtherUser",
              pinned_by_user_id: "42",
              pinned_by_user_login: "tester",
              pinned_by_user_name: "Tester",
              message: {
                text: "Welcome Kappa",
                fragments: [
                  { type: "text", text: "Welcome " },
                  {
                    type: "emote",
                    text: "Kappa",
                    emote: { id: "25", format: ["static", "animated"] },
                  },
                ],
              },
              starts_at: "2026-07-26T18:00:00Z",
              ends_at: "2026-07-26T18:05:00Z",
              updated_at: "2026-07-26T18:00:00Z",
            },
          ],
        });
      }
      return defaultRoutes(url);
    });
    const { service, internals } = createService({
      scopes: ["moderator:read:chat_messages"],
    });
    internals.account = testAccount;
    internals.validatedAt = Date.now();

    await expect(service.getPinnedChatMessage("77")).resolves.toEqual({
      id: "pin-1",
      senderId: "88",
      senderLogin: "otheruser",
      senderName: "OtherUser",
      pinnedByName: "Tester",
      text: "Welcome Kappa",
      fragments: [
        { type: "text", text: "Welcome " },
        {
          type: "emote",
          text: "Kappa",
          emote: { id: "25", formats: ["static", "animated"] },
        },
      ],
      startsAt: "2026-07-26T18:00:00Z",
      endsAt: "2026-07-26T18:05:00Z",
    });
  });

  it("treats a moderator-only forbidden response as no visible pin", async () => {
    installFetch((url) => {
      if (url.includes("/helix/chat/pins?")) {
        return json({ error: "Forbidden", status: 403, message: "Forbidden" }, 403);
      }
      return defaultRoutes(url);
    });
    const { service, internals } = createService();
    internals.account = testAccount;
    internals.validatedAt = Date.now();

    await expect(service.getPinnedChatMessage("77")).resolves.toBeNull();
  });
});

describe("TwitchService chat user profiles", () => {
  it("returns public details without requesting another user's private relationships", async () => {
    installFetch((url) => {
      if (url.includes("api.ivr.fi/v2/twitch/subage/otheruser/somechannel")) {
        return json({
          statusHidden: false,
          meta: { tier: "2" },
          cumulative: { months: 14 },
          followedAt: "2024-11-02T00:00:00Z",
        });
      }
      if (url.includes("/helix/users?login=somechannel")) return json(broadcasterPayload);
      if (url.includes("/helix/users?login=otheruser")) {
        return json({
          data: [{
            id: "88",
            login: "otheruser",
            display_name: "OtherUser",
            profile_image_url: "https://example.com/other.png",
            description: "A chatter",
            created_at: "2024-10-29T00:00:00Z",
          }],
        });
      }
      return defaultRoutes(url);
    });
    const { service, internals } = createService();
    internals.account = testAccount;
    internals.validatedAt = Date.now();

    await expect(service.getChatUserProfile("somechannel", "otheruser")).resolves.toEqual({
      id: "88",
      login: "otheruser",
      displayName: "OtherUser",
      profileImageUrl: "https://example.com/other.png",
      description: "A chatter",
      createdAt: "2024-10-29T00:00:00Z",
      subage: {
        followingSince: "2024-11-02T00:00:00Z",
        subscription: { isHidden: false, isSubscribed: true, tier: "2", cumulativeMonths: 14 },
      },
    });
    expect(requestCount("/channels/followed")).toBe(0);
    expect(requestCount("/subscriptions/user")).toBe(0);
  });

  it("includes the authenticated user's own follow and subscription relationship", async () => {
    installFetch((url) => {
      if (url.includes("/helix/users?login=somechannel")) return json(broadcasterPayload);
      if (url.includes("/helix/users?login=tester")) {
        return json({
          data: [{
            ...accountPayload.data[0],
            description: "Test account",
            created_at: "2020-01-02T00:00:00Z",
          }],
        });
      }
      if (url.includes("/helix/channels/followed?")) {
        return json({
          data: [{
            broadcaster_id: "77",
            broadcaster_login: "somechannel",
            broadcaster_name: "SomeChannel",
            followed_at: "2023-04-05T00:00:00Z",
          }],
          pagination: {},
        });
      }
      if (url.includes("/helix/subscriptions/user?")) {
        return json({ data: [{ tier: "2000", is_gift: true }] });
      }
      return defaultRoutes(url);
    });
    const { service, internals } = createService();
    internals.account = testAccount;
    internals.validatedAt = Date.now();

    const result = await service.getChatUserProfile("somechannel", "tester");

    expect(result.relationship).toEqual({
      isFollowing: true,
      followedAt: "2023-04-05T00:00:00Z",
      subscription: { isSubscribed: true, tier: "2000", isGift: true },
    });
  });
});
