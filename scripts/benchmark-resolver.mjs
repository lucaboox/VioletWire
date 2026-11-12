// Anonymous public-channel benchmark; never prints stream URLs or credentials.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { performance } from "node:perf_hooks";
import { setTimeout, clearTimeout } from "node:timers";
const login = process.argv[2] ?? "monstercat";
if (!/^[a-z0-9_]{1,25}$/.test(login)) throw new Error("Invalid Twitch login");
const root = process.cwd();
const worker = spawn(
  path.join(root, "vendor/native/streamlink/Python/python.exe"),
  [path.join(root, "native/streamlink-launcher.py"), "--worker"],
  { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
);
const lines = createInterface({ input: worker.stdout });
const waiting = [];
lines.on("line", (line) => waiting.shift()?.(JSON.parse(line)));
const next = () => new Promise((resolve) => waiting.push(resolve));
const timeout = setTimeout(() => {
  worker.kill();
  process.exitCode = 1;
}, 60_000);
try {
  const start = performance.now();
  await next();
  console.log(`Worker ready: ${Math.round(performance.now() - start)}ms`);
  for (let id = 1; id <= 3; id++) {
    const reply = next();
    const begin = performance.now();
    worker.stdin.write(`${JSON.stringify({ id, login, token: null })}\n`);
    const response = await reply;
    console.log(
      `Worker lookup ${id}: ${Math.round(performance.now() - begin)}ms; qualities=${Object.keys(response.streams ?? {}).length}; error=${!!response.error}`,
    );
  }
  for (let id = 1; id <= 3; id++) {
    const begin = performance.now();
    const child = spawn(
      path.join(root, "vendor/native/streamlink/bin/streamlink.exe"),
      [
        "--no-config",
        "--loglevel",
        "error",
        "--stream-url",
        "--twitch-low-latency",
        "--twitch-supported-codecs",
        "h264,h265,av1",
        `https://www.twitch.tv/${login}`,
        "best",
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    let hasUrl = false;
    child.stdout.on("data", (data) => {
      if (/^https?:\/\//m.test(data.toString())) hasUrl = true;
    });
    const code = await new Promise((resolve, reject) => {
      child.on("close", resolve);
      child.on("error", reject);
    });
    console.log(
      `CLI lookup ${id}: ${Math.round(performance.now() - begin)}ms; playable=${hasUrl}; exit=${code}`,
    );
  }
} finally {
  clearTimeout(timeout);
  worker.kill();
  lines.close();
}
