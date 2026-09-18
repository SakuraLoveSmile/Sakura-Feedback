#!/usr/bin/env python3
"""Focused browser regression checks for the admin feedback workbench.

Uses the built admin bundle and Playwright API-route mocks. No server, database,
external service, or repository state is touched.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import socket
import threading
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.environ.get("FB_E2E_ADMIN_DIST", os.path.join(ROOT, "apps", "admin", "dist"))


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def item(fid: str, created: str, status: str = "received", title: str | None = None) -> dict:
    return {
        "id": fid,
        "appId": "review-app",
        "appName": "Review App",
        "username": "review-user",
        "status": status,
        "createdAt": created,
        "updatedAt": created,
        "title": title or fid,
        "textPreview": fid,
        "mgmtState": "inbox",
        "lifecycleVersion": 1,
        "availableActions": [],
    }


def detail(fid: str) -> dict:
    return {
        **item(fid, "2026-01-01T00:00:00.000Z"),
        "text": f"Text for {fid}",
        "readOnly": False,
        "classificationLocked": False,
        "classification": {"version": 1, "projectId": "project-1", "columnId": "column-1", "labelIds": [], "assigneeId": ""},
        "recovery": None,
        "availableActions": [],
        "logs": [],
        "processed": None,
    }


class Static(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, directory: str, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def log_message(self, *_args):
        pass

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.rstrip("/") == "/admin":
            self.path = "/index.html"
        elif parsed.path.startswith("/admin/"):
            self.path = parsed.path.removeprefix("/admin")
        super().do_GET()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    if not os.path.exists(os.path.join(DIST, "index.html")):
        raise SystemExit(f"missing admin build: {DIST}; run pnpm --filter @feedback/admin build")

    port = free_port()
    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", port), functools.partial(Static, directory=DIST)
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    checks: list[str] = []

    def check(name: str, condition: bool) -> None:
        if not condition:
            raise AssertionError(name)
        checks.append(name)
        print(f"PASS {name}")

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=not args.headed)
            page = browser.new_page()
            state = {
                "list_calls": 0,
                "poll_mode": False,
                "hold_detail": None,
                "held_detail": {},
                "classify_calls": [],
                "detail_calls": [],
                "poll_items": [
                    item("new", "2026-01-04T00:00:00.000Z"),
                    item("head", "2026-01-03T00:00:00.000Z"),
                ],
            }

            def mock(route):
                req = route.request
                parsed = urlparse(req.url)
                path = parsed.path
                if path == "/api/auth/session":
                    return route.fulfill(status=200, content_type="application/json", body="{}")
                if path == "/api/admin/feedback/app-options":
                    return route.fulfill(status=200, content_type="application/json", body=json.dumps({"items": []}))
                if path == "/api/admin/feedback/counts":
                    return route.fulfill(status=200, content_type="application/json", body='{"inbox":3,"archived":0,"trash":0}')
                if path == "/api/admin/feedback":
                    state["list_calls"] += 1
                    if state["poll_mode"]:
                        body = {"items": state["poll_items"], "nextCursor": "cursor-1" if state["poll_items"] else None}
                    elif "cursor=" in parsed.query:
                        body = {"items": [item("page-2", "2026-01-01T00:00:00.000Z")], "nextCursor": None}
                    else:
                        body = {"items": [item("head", "2026-01-03T00:00:00.000Z"), item("tail", "2026-01-02T00:00:00.000Z")], "nextCursor": "cursor-1"}
                    return route.fulfill(status=200, content_type="application/json", body=json.dumps(body))
                if path.startswith("/api/admin/feedback/") and path.endswith("/classify"):
                    payload = json.loads(req.post_data or "{}")
                    state["classify_calls"].append(payload.get("operationId"))
                    if len(state["classify_calls"]) == 1:
                        return route.fulfill(status=409, content_type="application/json", body='{"error":{"code":"conflict","message":"分类版本已变化"}}')
                    return route.fulfill(status=200, content_type="application/json", body='{"ok":true,"classifyVersion":2}')
                if path.startswith("/api/admin/feedback/"):
                    fid = path.rsplit("/", 1)[-1]
                    state["detail_calls"].append(fid)
                    if state["hold_detail"] == fid:
                        state["held_detail"][fid] = route
                        return
                    return route.fulfill(status=200, content_type="application/json", body=json.dumps(detail(fid)))
                if path == "/api/admin/connection/kaneo/projects":
                    return route.fulfill(status=200, content_type="application/json", body='{"ok":true,"projects":[{"id":"project-1","name":"Project 1","workspaceId":"w1"}]}')
                if path == "/api/admin/apps":
                    return route.fulfill(status=200, content_type="application/json", body='{"apps":[]}')
                if path == "/api/admin/feedback/options":
                    return route.fulfill(status=200, content_type="application/json", body='{"project":{"id":"project-1"},"columns":[{"id":"column-1","slug":"todo","name":"Todo"}],"labels":[{"id":"label-1","name":"Bug"}],"members":[]}')
                return route.fulfill(status=200, content_type="application/json", body="{}")

            page.route("**/api/**", mock)
            page.goto(f"{base}/admin/?page=feedbacks", wait_until="domcontentloaded")
            page.locator('.nav-item:has-text("反馈")').last.wait_for(timeout=5000)

            # Polling replacement keeps the old tail because it is older than the response tail.
            page.get_by_text("tail", exact=True).first.wait_for(timeout=5000)
            state["poll_mode"] = True
            page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
            page.wait_for_timeout(150)
            check("poll preserves older paginated tail", page.get_by_text("tail", exact=True).count() >= 1)
            state["poll_mode"] = False
            page.get_by_role("button", name="加载更多").click()
            page.wait_for_timeout(150)
            check("pagination remains available after poll", page.get_by_text("page-2", exact=True).count() >= 1)
            state["poll_items"] = []
            state["poll_mode"] = True
            page.get_by_role("button", name="刷新", exact=True).click()
            page.wait_for_timeout(150)
            check("empty final refresh removes disappeared rows", page.get_by_text("tail", exact=True).count() == 0)
            state["poll_mode"] = False

            # Detail identity: hold A, switch the same mounted view to B, then release A.
            state["hold_detail"] = "A"
            page.goto(f"{base}/admin/?page=feedbacks&id=A", wait_until="domcontentloaded")
            page.wait_for_timeout(100)
            page.evaluate("history.pushState({}, '', '/admin/?page=feedbacks&id=B'); window.dispatchEvent(new PopStateEvent('popstate'))")
            page.wait_for_selector("text=Text for B", timeout=5000)
            state["held_detail"]["A"].fulfill(status=200, content_type="application/json", body=json.dumps(detail("A")))
            page.wait_for_timeout(100)
            check("late A response cannot overwrite B", page.get_by_text("Text for B", exact=True).count() >= 1 and page.get_by_text("Text for A", exact=True).count() == 0)

            # Hold B's polling response, close the mounted drawer, then release it.
            state["hold_detail"] = "B"
            page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
            page.wait_for_timeout(100)
            page.evaluate("history.pushState({}, '', '/admin/?page=feedbacks'); window.dispatchEvent(new PopStateEvent('popstate'))")
            if "B" in state["held_detail"]:
                state["held_detail"]["B"].fulfill(status=200, content_type="application/json", body=json.dumps(detail("B")))
            page.wait_for_timeout(100)
            check("late closed-drawer response cannot reopen detail", page.get_by_text("Text for B", exact=True).count() == 0)
            state["hold_detail"] = None

            # Failed classify keeps the idempotency key and does not show success.
            page.goto(f"{base}/admin/?page=feedbacks&id=classify-id", wait_until="domcontentloaded")
            page.wait_for_selector("text=Text for classify-id", timeout=5000)
            page.get_by_role("button", name="保存", exact=True).click()
            page.wait_for_timeout(100)
            check("classify conflict has no success notice", page.get_by_text("已保存", exact=True).count() == 0)
            page.get_by_role("button", name="保存", exact=True).click()
            page.wait_for_timeout(150)
            check("classify retry succeeds", page.get_by_text("已保存", exact=True).count() == 1)
            check("classify retry reuses operation id", len(state["classify_calls"]) >= 2 and state["classify_calls"][0] == state["classify_calls"][1])
            browser.close()
    finally:
        server.shutdown()
    print(f"{len(checks)} focused admin browser checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
