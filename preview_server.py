from __future__ import annotations

import argparse
import json
import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
ALLOWED_FILES = {"delivery-areas.geojson", "suburb-boundaries.geojson"}
MAX_UPLOAD_BYTES = 120 * 1024 * 1024


class PreviewHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/save-boundary-file":
            self.send_error(404)
            return

        filename = parse_qs(parsed.query).get("name", [""])[0]
        if filename not in ALLOWED_FILES:
            self.send_error(400, "Unsupported boundary filename")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(400, "Invalid Content-Length")
            return
        if length <= 0 or length > MAX_UPLOAD_BYTES:
            self.send_error(413, "Boundary file is empty or too large")
            return

        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_error(400, "Invalid JSON")
            return
        if payload.get("type") != "FeatureCollection" or not isinstance(payload.get("features"), list):
            self.send_error(400, "Expected a GeoJSON FeatureCollection")
            return

        DATA_DIR.mkdir(parents=True, exist_ok=True)
        target = DATA_DIR / filename
        temporary = DATA_DIR / f".{filename}.tmp"
        temporary.write_bytes(raw)
        temporary.replace(target)

        response = json.dumps({"ok": True, "name": filename, "bytes": len(raw)}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)


def main() -> None:
    parser = argparse.ArgumentParser(description="Local server for the Google Maps preview and boundary builder")
    parser.add_argument("--port", type=int, default=18080)
    parser.add_argument("--open-browser", action="store_true")
    args = parser.parse_args()
    handler = partial(PreviewHandler, directory=str(ROOT))
    url = f"http://localhost:{args.port}/"
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    except OSError as error:
        print(f"Could not start the local server on port {args.port}: {error}")
        print("If the website is already open, return to it and refresh the page.")
        if args.open_browser:
            webbrowser.open(url)
        return

    print(f"Serving Google Maps preview at {url}")
    print("Keep this window open while using the local website.")
    if args.open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
