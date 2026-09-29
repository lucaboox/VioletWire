"""Launch Streamlink with authentication received over stdin.

Neither the Twitch website token nor a session cookie such as Kick's may be
placed in the operating system process command line, where any other program
can read it. VioletWire sends one small JSON payload through this process's
private stdin pipe, then this launcher invokes the bundled Streamlink CLI in
the same Python process.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def optional_secret(payload: dict, key: str, label: str) -> str | None:
    value = payload.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value or any(
        character in value for character in "\r\n\0"
    ):
        raise SystemExit(f"Invalid {label}.")
    return value


def main() -> None:
    payload = json.loads(sys.stdin.buffer.readline(131_072))
    arguments = payload.get("arguments")
    if not isinstance(arguments, list) or not all(
        isinstance(argument, str) for argument in arguments
    ):
        raise SystemExit("Invalid Streamlink argument payload.")
    token = optional_secret(payload, "token", "Twitch playback token")
    http_cookie = optional_secret(payload, "httpCookie", "session cookie")
    if token is None and http_cookie is None:
        raise SystemExit("No credentials were supplied to the secure launcher.")

    runtime_root = Path(sys.executable).resolve().parent.parent
    packages = runtime_root / "pkgs"
    if not packages.is_dir():
        raise SystemExit("The bundled Streamlink packages are unavailable.")
    sys.path.insert(0, str(packages))

    # Mutating Python's in-process argv does not alter the command line Windows
    # recorded when this process was created. Streamlink still receives the
    # exact documented authentication option and all existing playback flags.
    credentials: list[str] = []
    if token is not None:
        credentials.append(f"--twitch-api-header=Authorization=OAuth {token}")
    if http_cookie is not None:
        credentials.extend(["--http-cookie", http_cookie])
    sys.argv = ["streamlink", *credentials, *arguments]
    del payload
    del token
    del http_cookie
    del credentials

    from streamlink_cli.main import main as streamlink_main

    streamlink_main()


if __name__ == "__main__":
    main()
