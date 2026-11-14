# Kick lookups through Streamlink's own Kick plugin, which handles Kick's
# browser check (it may open a headless Edge/Chrome once and keeps the
# cookies in Streamlink's cache). One JSON request on stdin, one JSON line
# out. Only public channel data is asked for; no account is involved.
import json
import re
import sys


def main():
    request = json.loads(sys.stdin.readline())
    kind = request.get("kind")
    slug = request.get("slug", "")
    if not re.fullmatch(r"[a-z0-9_-]{1,40}", slug):
        raise ValueError("bad slug")

    from streamlink import Streamlink
    from streamlink.plugin.api import validate
    from urllib.parse import quote

    session = Streamlink()
    _, plugin_class, url = session.resolve_url(f"https://kick.com/{slug}")
    plugin = plugin_class(session, url)
    anything = validate.Schema(dict)

    if kind == "streams":
        streams = plugin.streams()
        out = {
            name: stream.url
            for name, stream in streams.items()
            if name not in ("best", "worst") and isinstance(getattr(stream, "url", None), str)
        }
    elif kind == "channel":
        out = plugin._query_api(f"https://kick.com/api/v2/channels/{slug}", anything)
    elif kind == "search":
        term = str(request.get("term", ""))[:60]
        out = plugin._query_api(f"https://kick.com/api/search?searched_word={quote(term)}", anything)
    else:
        raise ValueError("bad request")
    print(json.dumps({"data": out}), flush=True)


try:
    main()
except Exception as error:  # noqa: BLE001 - reported as one short line
    kind = type(error).__name__
    print(json.dumps({"error": "offline" if kind == "NoStreamsError" else kind}), flush=True)
