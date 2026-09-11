#!/usr/bin/env python3
"""本地预览：真开一套环境用浏览器看组件效果（不是测试，无断言）。

    python3 e2e/preview.py              # 宿主页 :5189
    python3 e2e/preview.py --port 5190  # 换端口（会同步登记该来源）

启动内容（与 `e2e/run_browser.py` 完全同一套配置，直接复用它的函数）：

  * AI mock :8899、Kaneo mock :8898（`e2e/mock-external.mjs`）——提交后能看到真实归档流程；
  * 反馈服务 :8787（真实 `apps/server`，临时数据目录，与 e2e 相同的主密钥 / 管理员账号，
    并已登记 appId 与宿主页来源）；
  * 静态宿主页 :5189（`e2e/pages`，`/sdk/feedback-web.umd.js` 映射到 `packages/web/dist`
    的**真实产物**，不往仓库里拷文件）；
  * 两个**示例宿主页**（与 `e2e/run_browser.py` 的端口 / appId 完全一致）：
    React 示例 :5187（`examples/react/dist`）、Vue 示例 :5188（`examples/vue/dist`）。
    这两个目录需要先构建（`pnpm -C examples/react build`），缺失时只跳过并提示。

浏览器打开这几个页面（同一个服务，无需改配置）：

  http://localhost:5189/manual.html   默认宿主（未声明 capture-mode / launcher-mode）
                                      ← 本次修复的手动截图入口就在这里：贴边标签 → 面板
                                        →「截取当前页面」；页面里有遮罩区与密码框可验遮挡
  http://localhost:5187/              React 示例：灵感球 + capture-mode="viewport"（呼出即截图）
  http://localhost:5188/              Vue 示例：同上
  http://localhost:5189/orb.html      对照：灵感球 + viewport 的极简宿主页
  http://localhost:5189/mask.html     遮挡演示：把灵感球拖到洋红遮罩区 / 青色密码框上看结果

点「提交」时会弹出真实登录窗（服务端页面）：`--user/--pass` 默认 admin / e2e-browser-pass-1。
Ctrl-C 结束会一并停掉它拉起来的子进程。
"""

import argparse
import os
import signal
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import run_browser as rb  # noqa: E402  复用 e2e 的常量 / 启动 / 托管 / 服务配置

# 与 e2e 相同的主密钥（仅本地预览用，不是任何真实环境的密钥）
MASTER_KEY = "bG9jYWwtZTJlLW1hc3Rlci1rZXktMzItYnl0ZXMhIQ=="

# 自己的 PID 落盘，方便随时停掉（守护方式启动时尤其需要）
PID_FILE = "/tmp/fb-preview.pid"

# 示例宿主页：端口 / appId 与 e2e/run_browser.py 一致（(目录名, 端口, appId, 说明)）
EXAMPLES = [
    ("react", 5187, "com.example.demo-react", "React 示例（灵感球 + viewport）"),
    ("vue", 5188, "com.example.demo-vue", "Vue 示例（灵感球 + viewport）"),
]


def main():
    # 输出可能被重定向到日志文件：行缓冲，别让"就绪"提示卡在缓冲区里
    sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser(description="启动 Web 组件本地预览环境")
    ap.add_argument("--port", type=int, default=5189, help="宿主页端口（默认 5189）")
    ap.add_argument("--user", default=rb.ADMIN_USER, help="登录账号（默认 admin）")
    ap.add_argument("--pass", dest="password", default=rb.ADMIN_PASS, help="登录密码")
    ap.add_argument("--no-examples", action="store_true", help="不拉 React/Vue 示例（:5187/:5188）")
    args = ap.parse_args()

    origin = f"http://localhost:{args.port}"
    if not os.path.exists(rb.SDK_UMD):
        sys.exit("缺少组件产物：先跑 pnpm --filter @feedback/web build")
    try:
        with open(PID_FILE, "w") as f:
            f.write(str(os.getpid()))
    except OSError:
        pass

    procs = []
    data_dir = tempfile.mkdtemp(prefix="fb-preview-")
    env = dict(
        os.environ,
        FEEDBACK_MASTER_KEY=MASTER_KEY,
        FEEDBACK_ADMIN_USER=args.user,
        FEEDBACK_ADMIN_PASSWORD=args.password,
        FEEDBACK_ADMIN_DIST=os.path.join(rb.ROOT, "apps/admin/dist"),
        FEEDBACK_DATA_DIR=data_dir,
        FEEDBACK_PORT="8787",
        NODE_ENV="production",
    )

    try:
        print("→ 启动外部服务 mock（AI :8899 / Kaneo :8898）")
        rb.start(procs, ["node", "e2e/mock-external.mjs"], log=open("/tmp/fb-preview-mock.log", "w"))
        assert rb.wait_http("http://127.0.0.1:8899/__health", 30), "mock 未启动（/tmp/fb-preview-mock.log）"

        print("→ 启动反馈服务 :8787（临时数据目录）")
        rb.start(
            procs,
            ["npx", "tsx", "src/index.ts"],
            cwd=os.path.join(rb.ROOT, "apps/server"),
            env=env,
            log=open("/tmp/fb-preview-server.log", "w"),
        )
        assert rb.wait_http(f"{rb.SERVER}/healthz", 90), "服务未启动（看 /tmp/fb-preview-server.log）"

        # 示例宿主页（React :5187 / Vue :5188）：目录缺失时只跳过并提示先构建
        examples, skipped = [], []
        for name, port, app_id, label in EXAMPLES:
            dist = os.path.join(rb.ROOT, "examples", name, "dist")
            if args.no_examples:
                continue
            if not os.path.exists(os.path.join(dist, "index.html")):
                skipped.append(f"{name}（先跑 pnpm -C examples/{name} build）")
                continue
            rb.serve_static(dist, port, procs)
            examples.append((name, port, app_id, label, f"http://localhost:{port}"))

        apps = [(rb.APP_ID, "本地预览宿主页", [origin])] + [(a, l, [o]) for _, _, a, l, o in examples]
        print(f"→ 配置服务：登录 + Kaneo/AI 连接 + 登记 {len(apps)} 个 appId")
        status = rb.configure_service(rb.SERVER, apps)
        assert status == 200, f"管理登录失败：HTTP {status}"

        rb.serve_pages(args.port, procs)
        assert rb.wait_http(f"{origin}/manual.html", 20), "宿主页未起来"
        for _, port, _, _, o in examples:
            assert rb.wait_http(o, 20), f"{o} 未起来"

        lines = [
            f"    {origin}/manual.html   默认宿主（tab + off）← 本次修复的手动截图入口",
            "                           贴边标签 → 面板底部「截取当前页面」→ 预览 / 放大 / 重新截图 / 移除",
        ]
        lines += [f"    {o}/{'':<12} {l}（示例产物）" for _, _, _, l, o in examples]
        lines += [
            f"    {origin}/orb.html      对照：灵感球 + viewport（呼出即自动截图）",
            f"    {origin}/mask.html     遮挡演示（把灵感球拖到洋红遮罩区 / 青色密码框）",
            f"    {origin}/off.html      默认模式极简页",
        ]
        if skipped:
            lines.append(f"    （跳过示例：{'、'.join(skipped)}）")
        print(
            f"""
✅ 就绪，浏览器打开：

{chr(10).join(lines)}

   登录（点提交时弹窗）：{args.user} / {args.password}
   服务日志：/tmp/fb-preview-server.log     mock 日志：/tmp/fb-preview-mock.log
   停止：kill $(cat {PID_FILE})      （Ctrl-C 也行）
"""
        )
        # 前台常驻。必须**显式**处理 SIGTERM：默认动作会立刻终止进程，
        # `finally` 不执行 → 服务 / mock / 静态托管全变成孤儿继续占端口。
        stop = threading.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: stop.set())
        stop.wait()
    except KeyboardInterrupt:
        print("\n结束预览…")
    finally:
        for p in procs:
            p.terminate()
        time.sleep(0.4)
        for p in procs:
            p.kill()


if __name__ == "__main__":
    main()
