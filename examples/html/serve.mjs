#!/usr/bin/env node
/**
 * 极简静态服务器：零依赖，只服务 examples/html 目录。
 *
 * 存在的意义是把 .js / .mjs / .cjs 一律按 JavaScript MIME 返回：
 * 很多静态服务器把 .cjs 当成 application/octet-stream，浏览器会以
 * "MIME type is not executable" 拒绝执行 UMD 产物。
 *
 * 用法：node serve.mjs   （或 pnpm --filter @feedback/example-html serve）
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.env.PORT ?? 8080);

const contentTypes = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.cjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
  }),
);

const missingBundleHint =
  '404 %s\n\n' +
  '如果缺的是 UMD 产物，先构建再拷贝：\n' +
  '  pnpm --filter @feedback/web build\n' +
  '  cp packages/web/dist/feedback-web.umd.cjs examples/html/feedback-web.umd.js\n';

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  const target = resolve(join(root, normalize(pathname)));
  if (target !== root && !target.startsWith(root + '/')) {
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
        contentTypes.get(extname(target).toLowerCase()) ?? 'application/octet-stream',
      'content-length': body.byteLength,
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(missingBundleHint.replace('%s', pathname));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`examples/html → http://127.0.0.1:${port}/`);
});
