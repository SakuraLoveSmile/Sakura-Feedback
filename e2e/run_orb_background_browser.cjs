#!/usr/bin/env node
// Run with Playwright and pngjs available to Node; all requests stay on this loopback fixture.
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const root = path.resolve(__dirname, '..');
const bundle = path.resolve(option('--bundle', path.join(root, 'packages/web/dist/feedback-web.umd.cjs')));
const output = path.resolve(option('--output', path.join(root, 'e2e/shots/orb-background')));
fs.mkdirSync(output, { recursive: true });
const bytes = fs.readFileSync(bundle);
const results = [];
let browser;
const server = http.createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/sdk.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(bytes);
  } else if (request.url === '/api/features') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ images: 4, dialogue: true }));
  } else if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;background:#0000ff;color:#fff;font:16px system-ui}
      #scene{min-height:200vh;background:#0000ff}
      #secret{position:absolute;left:40px;top:40px;width:160px;height:80px;background:#f00}
      aside{position:fixed;left:240px;top:40px;pointer-events:none}
    </style></head><body><main id="scene"><div id="secret" data-feedback-capture-mask>PRIVATE</div>
    <aside data-html2canvas-ignore>灵感球待机背景更新 · 隔离验证</aside></main>
    <feedback-widget api-base="http://127.0.0.1:${server.address().port}" app-id="orb-background-browser"
      launcher-mode="orb" capture-mode="off" theme="dark" launcher-bottom="45%"></feedback-widget>
    <script src="/sdk.js"></script></body></html>`);
  } else {
    response.statusCode = 404;
    response.end();
  }
});

async function check(name, action) {
  try {
    const measured = await action();
    results.push({ name, passed: true, measured });
    console.log(`PASS ${name} ${JSON.stringify(measured)}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
    throw error;
  }
}

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 900, height: 650 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Observe actual PNG texture uploads without replacing capture or shader behavior.
  await page.addInitScript(() => {
    window.__uploads = [];
    window.__maxClones = 0;
    window.__cloneStarts = [];
    const original = WebGLRenderingContext.prototype.texImage2D;
    WebGLRenderingContext.prototype.texImage2D = function (...values) {
      if (values.length === 6 && values[5]?.width > 1) {
        const image = values[5], canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        const pixel = (x, y) => [...ctx.getImageData(Math.floor(x * canvas.width / innerWidth), Math.floor(y * canvas.height / innerHeight), 1, 1).data];
        window.__uploads.push({ at: performance.now(), scrollY, background: pixel(20, 20), mask: pixel(80, 70) });
      }
      return original.apply(this, values);
    };
    new MutationObserver(records => {
      window.__maxClones = Math.max(window.__maxClones, document.querySelectorAll('iframe.html2canvas-container').length);
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && node.matches('iframe.html2canvas-container')) window.__cloneStarts.push(performance.now());
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const uploads = () => page.evaluate(() => window.__uploads);
  const waitColor = (color, after = 0) => page.waitForFunction(({ color, after }) =>
    window.__uploads.some(frame => frame.at >= after && frame.background.every((v, i) => v === color[i])),
    { color, after }, { timeout: 6000 });
  const scene = async color => page.evaluate(color => {
    document.querySelector('#scene').style.backgroundColor = color;
    return performance.now();
  }, color);

  await check('initial blue texture and opaque sensitive mask', async () => {
    await waitColor([0, 0, 255, 255]);
    const first = (await uploads())[0];
    if (first.mask.join() !== '110,110,115,255') throw new Error(JSON.stringify(first));
    return first;
  });
  await page.screenshot({ path: path.join(output, 'initial-blue.png') });
  await check('same page and idle orb follow green and red host content', async () => {
    const greenAt = await scene('#00ff00');
    await waitColor([0, 255, 0, 255], greenAt);
    const green = (await uploads()).find(frame => frame.at >= greenAt && frame.background[1] === 255);
    const box = await page.locator('feedback-widget').locator('canvas.fb-orb-lens').boundingBox();
    const png = PNG.sync.read(await page.screenshot({ path: path.join(output, 'full-current-green.png') }));
    const center = (Math.floor(box.y + box.height / 2) * png.width + Math.floor(box.x + box.width / 2)) * 4;
    const rendered = [...png.data.subarray(center, center + 4)];
    if (rendered[1] < rendered[0] + 100 || rendered[1] < rendered[2] + 100) throw new Error(`visible glass retained old scene: ${rendered}`);
    const redAt = await scene('#ff0000');
    await waitColor([255, 0, 0, 255], redAt);
    return { greenDelayMs: green.at - greenAt, renderedGreenRgba: rendered, uploads: (await uploads()).length };
  });
  await check('collapsed handle follows current green background and wakes', async () => {
    await page.waitForFunction(() => document.querySelector('feedback-widget').shadowRoot.querySelector('.fb-orb').classList.contains('is-collapsed'), null, { timeout: 8000 });
    const changed = await scene('#00ff00');
    await waitColor([0, 255, 0, 255], changed);
    await page.screenshot({ path: path.join(output, 'handle-current-green.png') });
    await page.locator('feedback-widget').locator('.fb-orb').click({ force: true });
    await page.waitForFunction(() => !document.querySelector('feedback-widget').shadowRoot.querySelector('.fb-orb').classList.contains('is-collapsed'));
    return { uploads: (await uploads()).length };
  });
  await check('open panel stops decorative capture; close restores current scene', async () => {
    await page.evaluate(() => document.querySelector('feedback-widget').open());
    await page.waitForTimeout(450);
    const before = (await uploads()).length;
    await scene('#0000ff');
    await page.waitForTimeout(750);
    if ((await uploads()).length !== before) throw new Error('capture continued behind panel');
    const closedAt = await page.evaluate(() => { document.querySelector('feedback-widget').close(); return performance.now(); });
    await waitColor([0, 0, 255, 255], closedAt);
    return { uploadsWhileOpen: before };
  });
  await check('scroll resumes with current texture and no concurrent clones', async () => {
    const burst = await page.evaluate(async () => {
      const before = window.__cloneStarts.length;
      for (let i = 0; i < 20; i++) {
        scrollTo(0, 20 + i * 5);
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      return window.__cloneStarts.length - before;
    });
    if (burst > 3) throw new Error(`scroll bypassed bounded sampling: ${burst} clones in 20 frames`);
    const changed = await scene('#ff0000');
    await waitColor([255, 0, 0, 255], changed);
    const max = await page.evaluate(() => window.__maxClones);
    if (max > 1) throw new Error(`overlapping clones: ${max}`);
    return { maxClones: max, clonesDuring20ScrollFrames: burst };
  });
  await check('all unscrolled texture samples retain opaque sensitive mask', async () => {
    const frames = await uploads();
    const unscrolled = frames.filter(frame => frame.scrollY === 0);
    if (unscrolled.length < 3 || unscrolled.some(frame => frame.mask.join() !== '110,110,115,255')) throw new Error('missing safe-mask frames');
    return { safeFrames: unscrolled.length };
  });
  await page.screenshot({ path: path.join(output, 'final-current-red.png') });
  await check('edge idle keeps updating without page-label or route changes', async () => {
    await page.evaluate(() => localStorage.setItem('feedback:orb-idle:v1:orb-background-browser', JSON.stringify({ version: 1, style: 'edge' })));
    await page.reload();
    await waitColor([0, 0, 255, 255]);
    await page.waitForFunction(() => document.querySelector('feedback-widget').shadowRoot.querySelector('.fb-orb').classList.contains('is-collapsed'), null, { timeout: 8000 });
    const changed = await scene('#00ff00');
    await waitColor([0, 255, 0, 255], changed);
    await page.screenshot({ path: path.join(output, 'edge-current-green.png') });
    return { uploads: (await uploads()).length };
  });
  await check('hidden idle stops sampling and host reopen restores current background', async () => {
    await page.evaluate(() => localStorage.setItem('feedback:orb-idle:v1:orb-background-browser', JSON.stringify({ version: 1, style: 'hidden' })));
    await page.reload();
    await waitColor([0, 0, 255, 255]);
    await page.waitForFunction(() => document.querySelector('feedback-widget').shadowRoot.querySelector('.fb-orb').classList.contains('is-idle-hidden'), null, { timeout: 8000 });
    await page.waitForTimeout(450);
    const count = (await uploads()).length;
    await scene('#00ff00');
    await page.waitForTimeout(750);
    if ((await uploads()).length !== count) throw new Error('hidden idle continued capturing');
    const restoredAt = await page.evaluate(() => {
      const widget = document.querySelector('feedback-widget'); widget.open(); widget.close();
      return performance.now();
    });
    await waitColor([0, 255, 0, 255], restoredAt);
    return { hiddenUploads: count, restoredUploads: (await uploads()).length };
  });
  await check('disconnect stops captures and removes clone iframes', async () => {
    await page.evaluate(() => document.querySelector('feedback-widget').remove());
    await page.waitForTimeout(450);
    const count = (await uploads()).length;
    await page.waitForTimeout(700);
    if ((await uploads()).length !== count) throw new Error('capture continued after disconnect');
    if (await page.locator('iframe.html2canvas-container').count()) throw new Error('clone iframe leaked');
    if (errors.length) throw new Error(errors.join('\n'));
    return { uploads: count, pageErrors: errors };
  });
  await context.close();
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({
    bundle, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), results,
  }, null, 2));
  await browser?.close();
  server.close();
});
