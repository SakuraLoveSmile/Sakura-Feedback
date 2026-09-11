#!/usr/bin/env python3
"""向本地反馈服务预配置 mock 连接与两个示例应用（幂等，可重复运行）。"""
import json
import sys
import urllib.request
from http.cookiejar import CookieJar

BASE = "http://127.0.0.1:8787"
cj = CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    req.add_header("origin", BASE)  # 管理接口同源检查
    try:
        with opener.open(req, timeout=15) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


import os

env = {}
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for line in open(os.path.join(root, ".env")):
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.strip().split("=", 1)
        env[k] = v

s, _ = call("POST", "/api/auth/login", {
    "username": env.get("FEEDBACK_ADMIN_USER", "admin"),
    "password": env.get("FEEDBACK_ADMIN_PASSWORD", ""),
})
if s != 200:
    print("登录失败", s, "——检查 .env 与服务是否已启动")
    sys.exit(1)

call("PUT", "/api/admin/connection/kaneo", {"baseUrl": "http://127.0.0.1:8898", "apiKey": "mock-key"})
call("PUT", "/api/admin/connection/ai", {"baseUrl": "http://127.0.0.1:8899/v1", "model": "mock", "apiKey": "mock-key"})

apps = [
    ("com.example.demo-react", "示例 React", ["http://localhost:5187", "http://127.0.0.1:5187"]),
    ("com.example.demo-vue", "示例 Vue", ["http://localhost:5188", "http://127.0.0.1:5188"]),
]
for app_id, name, origins in apps:
    s, r = call("POST", "/api/admin/apps", {
        "appId": app_id, "name": name, "allowedOrigins": origins,
        "kaneoProjectId": "p-e2e", "kaneoColumnSlug": "triage",
    })
    print(f"{app_id}: {'已创建' if s == 201 else ('已存在' if s == 409 else r)}")

s, r = call("POST", "/api/admin/connection/kaneo/test", {"projectId": "p-e2e"})
print("Kaneo mock 连通:", r and r.get("ok"))
s, r = call("POST", "/api/admin/connection/ai/test")
print("AI mock 连通:", r and r.get("ok"))
