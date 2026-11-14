# Kick lookups through Streamlink's own Kick plugin, which handles Kick's
# browser check (it may open a headless Edge/Chrome once and keeps the
# cookies in Streamlink's cache). Stays running: one JSON request per line on
# stdin, one JSON line out per request. Only public data is asked for; no
# account is involved.
import json
import re
import sys

SLUG = re.compile(r"[a-z0-9_-]{1,40}")
URL = re.compile(r"https://(web\.)?kick\.com/[A-Za-z0-9/_\-?=&%.,]{1,400}")


def main():
    from streamlink import Streamlink
    from streamlink.plugin.api import validate

    session = Streamlink()
    anything = validate.Schema(validate.any(dict, list))
    general = None

    def plugin_for(slug):
        _, plugin_class, url = session.resolve_url(f"https://kick.com/{slug}")
        return plugin_class(session, url)

    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        reply = {}
        try:
            request = json.loads(line)
            reply["id"] = request.get("id")
            kind = request.get("kind")
            if kind == "streams":
                slug = request.get("slug", "")
                if not SLUG.fullmatch(slug):
                    raise ValueError("bad slug")
                streams = plugin_for(slug).streams()
                reply["data"] = {
                    name: stream.url
                    for name, stream in streams.items()
                    if name not in ("best", "worst") and isinstance(getattr(stream, "url", None), str)
                }
            elif kind == "get":
                url = request.get("url", "")
                if not URL.fullmatch(url):
                    raise ValueError("bad url")
                if general is None:
                    general = plugin_for("search")
                reply["data"] = general._query_api(url, anything)
            else:
                raise ValueError("bad request")
        except Exception as error:  # noqa: BLE001 - reported as one short word
            name = type(error).__name__
            reply["error"] = "offline" if name == "NoStreamsError" else name
        print(json.dumps(reply), flush=True)


main()
