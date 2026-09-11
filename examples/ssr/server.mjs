#!/usr/bin/env node
/**
 * 最小 SSR 示例：Node 内置 http，无框架。
 *
 * 1. `GET /` 在**服务端**渲染完整 HTML（含服务端数据与 <feedback-widget> 标记）；
 * 2. 反馈组件只在客户端动态 `import()`（见 page.mjs 里的 <script type="module">）；
 * 3. `GET /vendor/@feedback/web/*` 把 `packages/web/dist/` 的构建产物直接发给浏览器
 *    （不拷贝、不入库；所以跑之前必须先 `pnpm --filter @feedback/web build`）。
 *
 * 用法：pnpm --filter @feedback/example-ssr start   （或 node server.mjs）
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderPage } from './page.mjs';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
/** 组件包产物目录（仓库内 packages/web/dist，ESM 构建）。 */
const webDist = resolve(here, '../../packages/web/dist');
const webBundle = 'feedback-web.js';

const port = Number(process.env.PORT ?? 3000);
const appId = process.env.FEEDBACK_APP_ID ?? 'com.example.demo-ssr';
const apiBase = process.env.FEEDBACK_API_BASE ?? 'http://localhost:8787';

const contentTypes = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.d.ts': 'text/plain; charset=utf-8',
  }),
);

/** 示例数据：真实项目里换成数据库/接口查询，渲染方式不变。 */
function loadOrders() {
  return [
    { id: 'FB-1001', title: '导出 CSV 时表头重复', owner: '未分配' },
    { id: 'FB-1002', title: '移动端筛选器遮挡列表', owner: '未分配' },
    { id: 'FB-1003', title: '希望支持快捷键提交反馈', owner: '未分配' },
  ];
}

const missingBundleHint =
  '404 %s\n\n' +
  '组件产物不存在。先构建 @feedback/web：\n' +
  '  pnpm --filter @feedback/web build\n' +
  '再重新访问本页（服务端会在每次请求时读取 dist/，无需重启）。\n';

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/' || pathname === '/index.html') {
    const body = renderPage({
      renderedAt: new Date().toISOString(),
      orders: loadOrders(),
      appId,
      apiBase,
    });
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(body);
    return;
  }

  // 把 packages/web/dist 的 ESM 产物按原路径发给浏览器：
  // /vendor/@feedback/web/feedback-web.js → packages/web/dist/feedback-web.js
  // （懒加载的 html2canvas-pro chunk 也在同一个目录里，因此整目录透传。）
  const vendorPrefix = '/vendor/@feedback/web/';
  if (pathname.startsWith(vendorPrefix)) {
    const relative = pathname.slice(vendorPrefix.length);
    const target = resolve(join(webDist, relative));
    if (!target.startsWith(webDist + '/')) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden\n');
      return;
    }
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new Error('not a file');
      const body = await readFile(target);
      res.writeHead(200, {
        'content-type':
          contentTypes.get(extname(target).toLowerCase()) ??
          'application/octet-stream',
        'content-length': body.byteLength,
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(missingBundleHint.replace('%s', pathname));
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`404 ${pathname}\n`);
});

server.listen(port, '127.0.0.1', async () => {
  console.log(`examples/ssr → http://127.0.0.1:${port}/`);
  try {
    await stat(join(webDist, webBundle));
    console.log(`组件产物: ${join(webDist, webBundle)}`);
  } catch {
    console.warn(
      `[警告] 找不到 ${join(webDist, webBundle)}：页面能打开，但组件不会加载。\n` +
        '        先执行 pnpm --filter @feedback/web build。',
    );
  }
});
