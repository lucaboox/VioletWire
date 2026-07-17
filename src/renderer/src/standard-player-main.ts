import "./standard-player.css";

interface TwitchPlayerConstructor {
  new (elementId: string, options: Record<string, unknown>): object;
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
  new TwitchPlayer("twitch-video", {
    channel,
    width: "100%",
    height: "100%",
    parent: ["localhost"],
    autoplay: true,
    controls: true,
  });
}

export {};
