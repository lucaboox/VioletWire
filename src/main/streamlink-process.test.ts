import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtimeAvailable: true,
  spawn: vi.fn(),
  stdin: {
    end: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "C:\\VioletWire",
    isPackaged: false,
  },
}));

vi.mock("node:fs", () => ({
  existsSync: () => mocks.runtimeAvailable,
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

import {
  redactSensitivePlaybackText,
  spawnStreamlink,
} from "./streamlink-process";

describe("secure Streamlink launching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtimeAvailable = true;
    mocks.spawn.mockReturnValue({ stdin: mocks.stdin });
  });

  it("sends authenticated launch data over stdin without putting the token in argv", () => {
    const token = "abcdefghijklmnopqrstuvwxyz0123";
    const arguments_ = ["--no-config", "https://www.twitch.tv/example", "best"];

    spawnStreamlink("C:\\Streamlink\\streamlink.exe", arguments_, { twitchToken: token }, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const [executable, processArguments] = mocks.spawn.mock.calls[0] as [
      string,
      string[],
    ];
    expect(executable).toMatch(/python\.exe$/i);
    expect(processArguments.join(" ")).not.toContain(token);
    expect(mocks.stdin.end).toHaveBeenCalledWith(
      `${JSON.stringify({ arguments: arguments_, token, httpCookie: null })}\n`,
      "utf8",
    );
  });

  it("sends a session cookie over stdin even with no Twitch token", () => {
    const cookie = "session_token=kick-secret-value";
    const arguments_ = ["--no-config", "--stream-url", "https://kick.com/example", "best"];

    spawnStreamlink(
      "C:\\Streamlink\\streamlink.exe",
      arguments_,
      { twitchToken: null, httpCookie: cookie },
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );

    const [executable, processArguments] = mocks.spawn.mock.calls[0] as [
      string,
      string[],
    ];
    expect(executable).toMatch(/python\.exe$/i);
    expect(processArguments.join(" ")).not.toContain("kick-secret-value");
    expect(mocks.stdin.end).toHaveBeenCalledWith(
      `${JSON.stringify({ arguments: arguments_, token: null, httpCookie: cookie })}\n`,
      "utf8",
    );
  });

  it("drops a session cookie rather than put it in argv when the secure runtime is missing", () => {
    const cookie = "session_token=kick-secret-value";
    const arguments_ = ["--no-config", "https://kick.com/example", "best"];
    mocks.runtimeAvailable = false;

    spawnStreamlink(
      "C:\\Streamlink\\streamlink.exe",
      arguments_,
      { twitchToken: null, httpCookie: cookie },
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );

    const [executable, processArguments] = mocks.spawn.mock.calls[0] as [
      string,
      string[],
    ];
    expect(executable).toBe("C:\\Streamlink\\streamlink.exe");
    expect(processArguments).toEqual(arguments_);
    expect(mocks.stdin.end).not.toHaveBeenCalled();
  });

  it("launches the plain executable when there is nothing secret to send", () => {
    const arguments_ = ["--no-config", "https://www.twitch.tv/example", "best"];

    spawnStreamlink(
      "C:\\Streamlink\\streamlink.exe",
      arguments_,
      { twitchToken: null, httpCookie: null },
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );

    expect(mocks.spawn.mock.calls[0][0]).toBe("C:\\Streamlink\\streamlink.exe");
    expect(mocks.stdin.end).not.toHaveBeenCalled();
  });

  it("continues anonymously instead of leaking a token when the secure runtime is unavailable", () => {
    const token = "abcdefghijklmnopqrstuvwxyz0123";
    const arguments_ = ["--no-config", "https://www.twitch.tv/example", "best"];
    mocks.runtimeAvailable = false;

    spawnStreamlink("C:\\Streamlink\\streamlink.exe", arguments_, { twitchToken: token }, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const [executable, processArguments] = mocks.spawn.mock.calls[0] as [
      string,
      string[],
    ];
    expect(executable).toBe("C:\\Streamlink\\streamlink.exe");
    expect(processArguments).toEqual(arguments_);
    expect(processArguments.join(" ")).not.toContain(token);
    expect(mocks.stdin.end).not.toHaveBeenCalled();
  });

  it("redacts playback credentials and signed URL parameters from diagnostics", () => {
    expect(
      redactSensitivePlaybackText(
        "Authorization=OAuth secret123 https://usher.ttvnw.net/a.m3u8?sig=abc&token=def",
      ),
    ).toBe(
      "Authorization=OAuth [REDACTED] https://usher.ttvnw.net/a.m3u8?sig=[REDACTED]&token=[REDACTED]",
    );
  });
});
