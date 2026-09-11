/**
 * 服务端渲染的 HTML 模板。
 *
 * 这里渲染的是**普通 HTML**：`<feedback-widget>` 在服务端只是一个未知标签，
 * 真正常规行为（注册自定义元素、截图、面板）全部发生在客户端——见
 * server.mjs 注入的内联模块脚本，它在浏览器里才 `import()` 组件包。
 */

/** HTML 文本转义（服务端插值一律走它）。 */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * 渲染整个页面。
 *
 * @param {object} data
 * @param {string} data.renderedAt 服务端渲染时间（ISO 字符串，证明这是 SSR 输出）
 * @param {Array<{id: string, title: string, owner: string}>} data.orders
 *   服务端查询到的数据（示例里是内存里造的数据，换成数据库查询即可）
 * @param {string} data.appId
 * @param {string} data.apiBase
 */
export function renderPage({ renderedAt, orders, appId, apiBase }) {
  const rows = orders
    .map(
      (order) => `        <tr>
          <td><code>${escapeHtml(order.id)}</code></td>
          <td>${escapeHtml(order.title)}</td>
          <td>${escapeHtml(order.owner)}</td>
        </tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Feedback × SSR 示例</title>
    <style>
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #0f172a; }
      main { max-width: 760px; padding: 40px; }
      table { border-collapse: collapse; margin-bottom: 20px; }
      th, td { border: 1px solid #e2e8f0; padding: 6px 12px; text-align: left; font-size: 14px; }
      .row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
      button { font: inherit; padding: 8px 16px; border: 1px solid #cbd5e1; border-radius: 8px; background: #f8fafc; cursor: pointer; }
      button:hover { background: #eef2f7; }
      .hint { font-size: 13px; color: #64748b; line-height: 1.6; }
      .status { color: #059669; min-height: 24px; }
      .sensitive { border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; background: #f8fafc; max-width: 420px; margin-bottom: 20px; }
      code { background: #f1f5f9; padding: 1px 4px; border-radius: 4px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Feedback × SSR 示例</h1>
      <p class="hint">
        这一页由 Node 在服务端渲染（<code>rendered-at: ${escapeHtml(renderedAt)}</code>），
        而反馈组件只在浏览器里通过动态 <code>import()</code> 加载。
      </p>

      <h2>服务端渲染的数据</h2>
      <table>
        <thead>
          <tr><th>ID</th><th>标题</th><th>负责人</th></tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>

      <h2>反馈入口（客户端挂载）</h2>
      <div class="row">
        <button id="btn-open" type="button">打开面板（不截图）</button>
        <button id="btn-capture" type="button">截图并打开</button>
      </div>
      <p class="hint">
        <code>open()</code> 只打开面板；截图要用元素的 <code>captureAndOpen()</code>。
      </p>
      <p id="status" class="status" role="status"></p>

      <div class="sensitive" data-feedback-capture-mask>
        <strong>敏感数据保护演示区</strong>
        <p class="hint">带 <code>data-feedback-capture-mask</code> 的区域在截图时会被中性遮罩覆盖：</p>
        <div>密钥：<code>sk-live-sensitive-token-999</code></div>
      </div>

      <p class="hint">
        截图范围是<strong>当前应用视口</strong>；拖拽落点只标记问题位置，
        没有局部裁剪、没有系统悬浮窗、不跨应用截图。
      </p>
    </main>

    <!--
      服务端渲染的元素标记：此刻它只是未知标签，没有任何行为。
      launcher-mode / capture-mode 必须显式写（组件默认 tab / off）。
    -->
    <feedback-widget
      id="widget"
      api-base="${escapeHtml(apiBase)}"
      app-id="${escapeHtml(appId)}"
      app-version="1.0.0"
      page-label="ssr-orders"
      side="right"
      launcher-mode="orb"
      capture-mode="viewport"
    ></feedback-widget>

    <script type="module">
      const status = document.getElementById('status');
      const say = (text, color) => {
        status.textContent = text;
        status.style.color = color;
      };

      // ★ 关键：组件只在**客户端**动态 import。
      // @feedback/web 的入口顶层就会执行 customElements 注册，并在类定义里
      // 直接 extends HTMLElement（见 packages/web/src/index.ts / element.ts），
      // 这些都是浏览器全局；在 Node 里 import 会立刻抛
      // "ReferenceError: HTMLElement is not defined"。
      // 所以服务端渲染绝不 import 它，只有浏览器才加载。
      let widget;
      try {
        await import('/vendor/@feedback/web/feedback-web.js');
        widget = document.getElementById('widget');
      } catch (error) {
        say('组件未加载：' + error.message + '（先执行 pnpm --filter @feedback/web build，见 README）', '#dc2626');
      }

      if (widget) {
        // 服务已接收提交（201/200）后派发；不是"Kaneo 已归档"通知。
        widget.addEventListener('feedback-submitted', (event) => {
          const { feedbackId, status: submitStatus, replayed } = event.detail;
          say('服务已接收：feedbackId=' + feedbackId + ' status=' + submitStatus + (replayed ? '（重放）' : ''), '#059669');
        });

        document.getElementById('btn-open').addEventListener('click', () => widget.open());
        document.getElementById('btn-capture').addEventListener('click', () => widget.captureAndOpen());
      }
    </script>
  </body>
</html>
`;
}
