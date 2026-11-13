"""Private Streamlink JSON-lines resolver. No exception text on pipes.

The linked playback session, when there is one, arrives on stdin with each
request and is used only as Twitch's API header for that lookup."""
import contextlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(sys.executable).resolve().parent.parent / "pkgs"))
protocol = sys.stdout
with contextlib.redirect_stdout(sys.stderr):
    from streamlink import Streamlink
    from streamlink.plugins.twitch import __plugin__ as Twitch
    session = Streamlink()
    session.set_option("http-timeout", 8)

NAME = set("abcdefghijklmnopqrstuvwxyz0123456789_")
TOKEN = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")


def valid(text, limit):
    return isinstance(text, str) and 1 <= len(text) <= limit and all(c in NAME for c in text)


print('{"ready":true}', file=protocol, flush=True)
while True:
    line = sys.stdin.buffer.readline(4096)
    if not line:
        break
    try:
        request = json.loads(line)
        login = request["login"]
        quality = request.get("quality") or "best"
        if not valid(login, 25) or not valid(quality, 16):
            raise ValueError()
        token = request.get("token")
        options = {"low-latency": True, "supported-codecs": ["h264"]}
        if isinstance(token, str) and 20 <= len(token) <= 64 and all(c in TOKEN for c in token):
            options["api-header"] = [("Authorization", f"OAuth {token}")]
        with contextlib.redirect_stdout(sys.stderr):
            streams = Twitch(session, f"https://www.twitch.tv/{login}", options=options).streams()
            qualities = [name for name in streams if name not in ("best", "worst")]
            url = None
            chosen = None
            if streams:
                # "best" (Auto) is the highest variant. Media Engine's own
                # adaptive switching drops to 160p at the live edge, so the
                # app never hands it the multivariant playlist.
                name = quality if quality in streams else "best" if "best" in streams else next(iter(streams))
                url = streams[name].to_url()
                chosen = "best" if quality == "best" else name
        response = {"url": url, "qualities": qualities, "quality": chosen}
    except Exception:
        response = {"error": True}
    print(json.dumps(response), file=protocol, flush=True)
