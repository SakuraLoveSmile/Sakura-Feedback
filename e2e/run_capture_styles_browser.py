#!/usr/bin/env python3
"""FB-CAP-001: serve an isolated real-browser screenshot regression fixture.

Build packages/web first, run this script, open the printed URL in a browser and
click “运行截图回归”. The page runs the real component and verifies PNG pixels,
draft preservation and iframe cleanup. Two loopback origins exercise readable
and browser-protected stylesheets. No database, credentials or external service.
Optional --sdk-dist allows the same fixture to verify an older failing bundle.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
PAGE = ROOT / "e2e/pages/capture-styles.html"
HOST_CSS = """
@import url('nested/import.css') screen;
@import url('nested/layer.css') layer(imported) supports(display: grid) (min-width: 0px);
html { background: #f0f3f8; color-scheme: light; }
body { margin: 0; color: #182433; font: 15px system-ui, sans-serif; }
main { padding: 20px; max-width: 960px; }
h1 { font-size: 24px; }
.probes { display: flex; flex-wrap: wrap; gap: 20px; }
.probe { width: 100px; height: 70px; border-radius: 0; }
.probe-label { width: 100px; font-size: 12px; margin: 6px 0 16px; }
#solid-probe, #disabled-probe { background: rgb(18, 140, 90); }
#url-probe { background: url('../images/tile(1).svg') center / cover; }
#media-probe { background: rgb(12, 120, 180); }
.desktop-only { padding: 14px; margin-bottom: 16px; background: #dde6f3; }
.mobile-only, .secret-hidden { display: none; }
.secret-hidden { width: 100px; height: 70px; background: rgb(250, 0, 250); }
#masked-probe { background: #ff2222; color: #fff; }
#cross-probe { background: #fff; }
@supports (display: grid) { #supports-probe { background: rgb(161, 57, 205); } }
@media (max-width: 700px) {
  .desktop-only { display: none; }
  .mobile-only { display: block; }
  #media-probe { background: rgb(220, 150, 20); }
}
"""
IMPORTED_CSS = "#import-probe { background: url('../../images/import-tile.svg') center / cover; }"
LAYER_CSS = "#layer-probe { background: rgb(90, 65, 170); }"
CROSS_CSS = "#cross-probe { background: rgb(35, 95, 160); }"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-dist", type=Path, default=ROOT / "packages/web/dist")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    bundle = args.sdk_dist.resolve() / "feedback-web.umd.cjs"
    if not bundle.is_file():
        parser.error(f"Build @feedback/web first; missing {bundle}")
    mode = {"value": "healthy"}
    requests: list[dict] = []

    class Handler(BaseHTTPRequestHandler):
        def reply(self, status: int, content, mime: str) -> None:
            if isinstance(content, dict):
                content = json.dumps(content).encode()
            elif isinstance(content, str):
                content = content.encode()
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            path = parsed.path
            if path == "/__control":
                requested = parse_qs(parsed.query).get("mode", ["healthy"])[0]
                if requested not in {"healthy", "source-fail", "cross-fail", "cross-slow", "alternate-fail"}:
                    return self.reply(400, {"error": "unknown fixture mode"}, "application/json")
                mode["value"] = requested
                return self.reply(200, {"mode": requested}, "application/json")
            if path == "/__requests":
                return self.reply(200, {"requests": list(requests)}, "application/json")
            if path == "/":
                cross_sheet = "/styles/cross-parent.css" if "imported-cross" in parse_qs(parsed.query, keep_blank_values=True) else cross_origin + "/styles/cross.css"
                page = PAGE.read_text().replace("__CROSS_STYLESHEET__", cross_sheet)
                return self.reply(200, page, "text/html; charset=utf-8")
            if path == "/sdk/feedback-web.umd.cjs":
                return self.reply(200, bundle.read_bytes(), "text/javascript")
            if path.startswith("/styles/"):
                cross = path in {"/styles/cross.css", "/styles/opaque-import.css"}
                current = mode["value"]
                if cross and current == "cross-slow":
                    time.sleep(0.7)
                alternate = "alternate" in parse_qs(parsed.query)
                failed = ((cross and current == "cross-fail")
                          or (not cross and not alternate and current == "source-fail")
                          or (alternate and current == "alternate-fail"))
                status = 503 if failed else 200
                requests.append({"path": path, "status": status, "origin": self.server.server_port})
                if failed:
                    return self.reply(status, "intentional fixture stylesheet failure", "text/plain")
                css = {
                    "/styles/host.css": HOST_CSS,
                    "/styles/nested/import.css": IMPORTED_CSS,
                    "/styles/nested/layer.css": LAYER_CSS,
                    "/styles/disabled.css": "#disabled-probe { background: rgb(250, 0, 250) !important; }",
                    "/styles/cross.css": CROSS_CSS,
                    "/styles/cross-parent.css": f'@import url("{cross_origin}/styles/opaque-import.css");',
                    "/styles/opaque-import.css": CROSS_CSS,
                }.get(path)
                if css is not None:
                    return self.reply(200, css, "text/css")
            if path in {"/images/tile(1).svg", "/images/import-tile.svg"}:
                color = "#e07920" if path.endswith("tile(1).svg") else "#3755c8"
                svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="{color}" d="M0 0h16v16H0z"/></svg>'
                return self.reply(200, svg, "image/svg+xml")
            if path == "/api/features":
                return self.reply(200, {"images": 4, "dialogue": True}, "application/json")
            return self.reply(404, {"error": "fixture not found"}, "application/json")

        def do_POST(self) -> None:
            self.reply(405, {"error": "fixture never accepts submissions"}, "application/json")

    cross_server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    cross_origin = f"http://127.0.0.1:{cross_server.server_port}"
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    threading.Thread(target=cross_server.serve_forever, daemon=True).start()
    print(json.dumps({"url": f"http://127.0.0.1:{server.server_port}/", "cross_origin": cross_origin,
                      "bundle": str(bundle), "sha256": hashlib.sha256(bundle.read_bytes()).hexdigest()}, ensure_ascii=False), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        cross_server.shutdown()
        cross_server.server_close()


if __name__ == "__main__":
    main()
