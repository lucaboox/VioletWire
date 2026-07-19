"""Launch Streamlink with authentication received over stdin.

The Twitch website token must not be placed in the operating system process
command line. VioletWire sends one small JSON payload through this process's
private stdin pipe, then this launcher invokes the bundled Streamlink CLI in
the same Python process.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> None:
    payload = json.loads(sys.stdin.buffer.readline(131_072))
    arguments = payload.get("arguments")
    token = payload.get("token")
    if not isinstance(arguments, list) or not all(
        isinstance(argument, str) for argument in arguments
    ):
        raise SystemExit("Invalid Streamlink argument payload.")
    if not isinstance(token, str) or not token or any(
        character in token for character in "\r\n\0"
    ):
        raise SystemExit("Invalid Twitch playback token.")

    runtime_root = Path(sys.executable).resolve().parent.parent
    packages = runtime_root / "pkgs"
    if not packages.is_dir():
        raise SystemExit("The bundled Streamlink packages are unavailable.")
    sys.path.insert(0, str(packages))

    # Mutating Python's in-process argv does not alter the command line Windows
    # recorded when this process was created. Streamlink still receives the
    # exact documented authentication option and all existing playback flags.
    sys.argv = [
        "streamlink",
        f"--twitch-api-header=Authorization=OAuth {token}",
        *arguments,
    ]
    del payload
    del token

    from streamlink_cli.main import main as streamlink_main

    streamlink_main()


if __name__ == "__main__":
    main()
