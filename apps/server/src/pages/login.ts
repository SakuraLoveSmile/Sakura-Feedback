/** 登录窗口页面。内联脚本经 CSP nonce 白名单，所有动态值转义。 */

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function loginPageHtml(nonce: string): string {
  const script = `
(function () {
  var params = new URLSearchParams(location.search);
  var cb = params.get("cb");
  var appId = params.get("appId");
  var reqNonce = params.get("nonce");
  var statusEl = document.getElementById("status");
  var form = document.getElementById("login-form");

  function setStatus(msg) { statusEl.textContent = msg; }

  async function api(path, opts) {
    var res = await fetch(path, Object.assign({ credentials: "same-origin" }, opts || {}));
    var data = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    return { ok: res.ok, status: res.status, data: data };
  }

  async function handshake() {
    if (!cb || !appId) {
      setStatus("登录成功，可关闭本窗口");
      location.replace("/admin/");
      return;
    }
    setStatus("正在完成登录握手…");
    var v = await api("/api/auth/handshake/validate?appId=" + encodeURIComponent(appId) + "&origin=" + encodeURIComponent(cb));
    if (!v.ok) {
      setStatus("该应用来源未被允许接收登录令牌：" + ((v.data && v.data.error && v.data.error.code) || "拒绝"));
      return;
    }
    var h = await api("/api/auth/handshake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: appId, origin: cb })
    });
    if (!h.ok || !h.data || !h.data.accessToken) {
      setStatus("握手失败：" + ((h.data && h.data.error && h.data.error.message) || h.status));
      return;
    }
    try {
      window.opener.postMessage(
        { type: "feedback:auth", nonce: reqNonce, accessToken: h.data.accessToken, expiresAt: h.data.expiresAt },
        cb
      );
      setStatus("登录完成，窗口即将关闭…");
      setTimeout(function () { window.close(); }, 400);
      setTimeout(function () { document.getElementById("manual-close").hidden = false; }, 3000);
    } catch (e) {
      setStatus("无法回传登录结果：" + e.message);
    }
  }

  async function restoreSession() {
    var s = await api("/api/auth/session");
    if (s.ok) { await handshake(); return; }
    form.hidden = false;
    document.getElementById("username").focus();
  }

  form.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var btn = document.getElementById("submit");
    btn.disabled = true;
    setStatus("正在登录…");
    var r = await api("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("username").value,
        password: document.getElementById("password").value
      })
    });
    btn.disabled = false;
    if (!r.ok) {
      setStatus(((r.data && r.data.error && r.data.error.message) || "登录失败"));
      document.getElementById("password").value = "";
      return;
    }
    await handshake();
  });

  document.getElementById("manual-close").addEventListener("click", function () { window.close(); });
  restoreSession();
})();
`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>登录 — Feedback</title>
<style>
  body { font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         background:#f6f7f9; color:#1c1e21; display:flex; min-height:100vh; margin:0; align-items:center; justify-content:center; }
  .box { background:#fff; border-radius:12px; box-shadow:0 4px 24px rgba(0,0,0,.08); padding:32px; width:min(360px, 90vw); }
  h1 { font-size:18px; margin:0 0 20px; }
  label { display:block; font-size:13px; color:#555; margin:12px 0 4px; }
  input { width:100%; box-sizing:border-box; padding:9px 10px; border:1px solid #d0d3d8; border-radius:8px; font-size:14px; }
  button { width:100%; margin-top:18px; padding:10px; border:0; border-radius:8px; background:#2563eb; color:#fff; font-size:14px; cursor:pointer; }
  button:disabled { opacity:.6; cursor:default; }
  #status { font-size:13px; color:#666; margin-top:14px; min-height:18px; line-height:1.5; }
</style>
</head>
<body>
  <main class="box">
    <h1>Feedback 登录</h1>
    <form id="login-form" hidden>
      <label for="username">用户名</label>
      <input id="username" name="username" autocomplete="username" required>
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button id="submit" type="submit">登录</button>
    </form>
    <p id="status" role="status" aria-live="polite">正在检查登录状态…</p>
    <button id="manual-close" hidden type="button">手动关闭此窗口</button>
  </main>
  <script nonce="${esc(nonce)}">${script}</script>
</body>
</html>
`;
}
