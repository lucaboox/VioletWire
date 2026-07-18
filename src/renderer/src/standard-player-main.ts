import "./standard-player.css";

interface TwitchPlayerInstance {
  addEventListener(event: string, listener: () => void): void;
  play(): void;
  setMuted(muted: boolean): void;
}

interface TwitchPlayerConstructor {
  new (elementId: string, options: Record<string, unknown>): TwitchPlayerInstance;
  READY?: string;
  PLAY?: string;
  PLAYBACK_BLOCKED?: string;
}

declare global {
  interface Window {
    Twitch?: { Player: TwitchPlayerConstructor };
  }
}

const root = document.getElementById("root");
const channel = new URLSearchParams(window.location.search).get("channel") ?? "";

if (!root || !channel || !window.Twitch?.Player) {
  if (root) root.innerHTML = '<div class="standard-player-error">Unable to initialize Twitch playback.</div>';
} else {
  root.innerHTML = `
    <main class="standard-player-shell">
      <div id="twitch-video"></div>
    </main>
  `;

  const TwitchPlayer = window.Twitch.Player;
  const player = new TwitchPlayer("twitch-video", {
    channel,
    width: "100%",
    height: "100%",
    parent: ["localhost"],
    autoplay: true,
    muted: false,
    controls: true,
  });

  let playbackStarted = false;
  let unmuteAfterStart = false;
  const retryTimers: number[] = [];
  const attemptPlayback = () => {
    if (!playbackStarted) player.play();
  };
  const scheduleStartupAttempts = () => {
    for (const delay of [0, 250, 1_000, 2_500]) {
      retryTimers.push(window.setTimeout(attemptPlayback, delay));
    }
  };

  if (TwitchPlayer.PLAY) {
    player.addEventListener(TwitchPlayer.PLAY, () => {
      playbackStarted = true;
      for (const timer of retryTimers) window.clearTimeout(timer);
      retryTimers.length = 0;
      if (unmuteAfterStart) {
        unmuteAfterStart = false;
        window.setTimeout(() => player.setMuted(false), 100);
      }
    });
  }
  if (TwitchPlayer.READY) {
    player.addEventListener(TwitchPlayer.READY, scheduleStartupAttempts);
  } else {
    scheduleStartupAttempts();
  }
  if (TwitchPlayer.PLAYBACK_BLOCKED) {
    player.addEventListener(TwitchPlayer.PLAYBACK_BLOCKED, () => {
      if (playbackStarted) return;
      // Chromium can still reject audible autoplay in an embedded frame even
      // when the host application permits it. Starting muted satisfies that
      // policy; restore audio as soon as Twitch confirms playback.
      unmuteAfterStart = true;
      player.setMuted(true);
      player.play();
    });
  }
}

export {};
