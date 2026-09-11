/**
 * Web 截图生命周期回归测试（实施计划 3.x 验收点）：
 * 捕获会话（合并 / 重拍 / 取消 / 关闭 / 卸载 / 替换 / 身份变化的失效语义，
 * A-B 任意顺序完成、旧 finally 不串扰、重挂载不重复绑定、两实例隔离）
 * + 冻结提交快照（同 key 同字节重试、409 不换 key、未知结果修改留原请求、
 * 登录/提交/重拍交错时图片文字与幂等 key 对应）
 * + 必需遮挡失败时无新预览、无新图片提交（内置路径，html2canvas-pro 已被 mock）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 内置路径假渲染器（mock 的 html2canvas-pro 与生命周期测试共享同一 state）
const hoisted = vi.hoisted(() => ({
  state: {
    paint: true,
    tainted: false,
    toBlobCalls: 0,
    renderCalls: 0,
    blobSizes: undefined as number[] | undefined,
    honorVisibility: undefined as boolean | undefined,
  },
}));
vi.mock('html2canvas-pro', async () => {
  const fx = await import('./pixel-fixture');
  return { default: fx.createFakeRenderer(hoisted.state as never) };
});

import '../src/index';
import {
  cleanup,
  deliverAuthMessage,
  httpResponse,
  mount,
  setTextarea,
  stubWindowOpen,
  completeLogin,
} from './helpers';
import { addNode, blobToPng, installGeometryPatch, isCoverPixel, pixelColor } from './pixel-fixture';

const PNG = (tag: string) => new Blob([tag], { type: 'image/png' });
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Shot = { blob: Blob; width: number; height: number };

let teardownGeometry: (() => void) | null = null;

beforeEach(() => {
  teardownGeometry = installGeometryPatch();
  vi.spyOn(URL, 'createObjectURL').mockImplementation(
    (b: Blob | MediaSource) => `blob:mock-${(b as Blob).size ?? 0}`,
  );
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  hoisted.state.paint = true;
  hoisted.state.tainted = false;
  hoisted.state.toBlobCalls = 0;
  hoisted.state.renderCalls = 0;
  hoisted.state.blobSizes = undefined;
});

afterEach(() => {
  teardownGeometry?.();
  teardownGeometry = null;
  cleanup();
});

describe('捕获会话', () => {
  it('普通呼出合并进行中的捕获（provider 只调一次）', async () => {
    const m = mount({ 'capture-mode': 'viewport' });
    const d = deferred<Shot>();
    m.widget.captureProvider = vi.fn(() => d.promise);
    const a = m.widget.captureAndOpen();
    const b = m.widget.captureAndOpen();
    expect(m.widget.captureProvider).toHaveBeenCalledTimes(1);
    d.resolve({ blob: PNG('x'), width: 100, height: 100 });
    await Promise.all([a, b]);
    expect(m.screenshotWrap.hidden).toBe(false);
  });

  it('有文字/截图草稿时再次呼出：恢复草稿不重拍', async () => {
    const m = mount({ 'capture-mode': 'viewport' });
    m.widget.captureProvider = vi.fn(async () => ({ blob: PNG('a'), width: 100, height: 100 }));
    setTextarea(m, '已有草稿');
    await m.widget.captureAndOpen();
    expect(m.widget.captureProvider).not.toHaveBeenCalled();
    expect(m.panel.classList.contains('is-open')).toBe(true);
    expect(m.textarea.value).toBe('已有草稿');
  });

  it('重拍取消旧会话：旧 signal abort，旧结果不写草稿', async () => {
    const m = mount();
    const d1 = deferred<Shot>();
    const d2 = deferred<Shot>();
    let n = 0;
    let sig1: AbortSignal | undefined;
    m.widget.captureProvider = vi.fn(async (ctx) => {
      n++;
      if (n === 1) {
        sig1 = ctx.signal;
        return d1.promise;
      }
      return d2.promise;
    });
    const p1 = m.widget.captureAndOpen();
    const p2 = m.widget.retakeScreenshot();
    expect(n).toBe(2);
    expect(sig1?.aborted).toBe(true);
    d2.resolve({ blob: PNG('new'), width: 200, height: 200 });
    await p2;
    expect(m.screenshotThumb.src).toContain('blob:mock-3'); // 'new'
    d1.resolve({ blob: PNG('stale!'), width: 300, height: 300 });
    await p1;
    expect(m.screenshotThumb.src).toContain('blob:mock-3'); // 旧结果被丢弃
  });

  it('旧请求先完成：finally 不得恢复新请求的 UI', async () => {
    const m = mount();
    const d1 = deferred<Shot>();
    const d2 = deferred<Shot>();
    let n = 0;
    m.widget.captureProvider = vi.fn(async () => (++n === 1 ? d1.promise : d2.promise));
    const p1 = m.widget.captureAndOpen();
    const p2 = m.widget.retakeScreenshot();
    d1.resolve({ blob: PNG('stale'), width: 100, height: 100 });
    await p1;
    expect(m.panel.style.visibility).toBe('hidden'); // 新会话仍在进行，UI 归新会话管
    d2.resolve({ blob: PNG('ok!'), width: 100, height: 100 });
    await p2;
    expect(m.panel.style.visibility).toBe('');
  });

  it('新请求先完成、旧请求迟落地：不影响草稿与 UI', async () => {
    const m = mount();
    const d1 = deferred<Shot>();
    const d2 = deferred<Shot>();
    let n = 0;
    m.widget.captureProvider = vi.fn(async () => (++n === 1 ? d1.promise : d2.promise));
    const p1 = m.widget.captureAndOpen();
    const p2 = m.widget.retakeScreenshot();
    d2.resolve({ blob: PNG('good'), width: 100, height: 100 });
    await p2;
    d1.resolve({ blob: PNG('late-old'), width: 100, height: 100 });
    await p1;
    expect(m.screenshotThumb.src).toContain('blob:mock-4'); // 'good'
    expect(m.panel.style.visibility).toBe('');
    expect(m.statusRegion.textContent).not.toContain('截图未完成');
  });

  it('close() 取消进行中的截图：不开面板、不写草稿、不报错', async () => {
    const m = mount({ 'capture-mode': 'viewport' });
    const d = deferred<Shot>();
    m.widget.captureProvider = vi.fn(() => d.promise);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = m.widget.captureAndOpen();
    m.widget.close();
    d.resolve({ blob: PNG('late'), width: 100, height: 100 });
    await p;
    expect(m.panel.classList.contains('is-open')).toBe(false);
    expect(m.screenshotWrap.hidden).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('cancelCapture：失效旧会话、恢复 UI，迟到的结果丢弃', async () => {
    const m = mount();
    const d = deferred<Shot>();
    m.widget.captureProvider = vi.fn(() => d.promise);
    const p = m.widget.captureAndOpen();
    m.widget.cancelCapture();
    expect(m.panel.style.visibility).toBe('');
    d.resolve({ blob: PNG('late'), width: 100, height: 100 });
    await p;
    expect(m.screenshotWrap.hidden).toBe(true);
  });

  it('captureProvider 替换使旧会话失效', async () => {
    const m = mount();
    const d1 = deferred<Shot>();
    m.widget.captureProvider = vi.fn(() => d1.promise);
    const p1 = m.widget.captureAndOpen();
    m.widget.captureProvider = vi.fn(async () => ({ blob: PNG('B'), width: 50, height: 50 }));
    expect(m.panel.style.visibility).toBe('');
    d1.resolve({ blob: PNG('stale'), width: 100, height: 100 });
    await p1;
    expect(m.screenshotWrap.hidden).toBe(true); // 旧结果未写入
  });

  it('卸载失效进行中的捕获；重挂载保留字节并重建预览 URL、不重复绑定', async () => {
    const m = mount({ 'capture-mode': 'viewport' });
    m.widget.captureProvider = vi.fn(async () => ({ blob: PNG('keep'), width: 100, height: 100 }));
    await m.widget.captureAndOpen();
    expect(m.screenshotThumb.src).toContain('blob:mock-4');

    m.widget.remove();
    document.body.appendChild(m.widget);
    expect(m.screenshotWrap.hidden).toBe(false); // 字节保留、URL 重建
    const before = (m.widget.captureProvider as ReturnType<typeof vi.fn>).mock.calls.length;
    m.fab.click();
    await tick();
    // 有草稿：恢复不重拍；且重挂载未双绑定（否则 open/close 行为会翻倍）
    expect((m.widget.captureProvider as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });

  it('appId 变化：进行中的捕获与旧草稿全部废弃', async () => {
    const m = mount();
    const d = deferred<Shot>();
    m.widget.captureProvider = vi.fn(() => d.promise);
    const p = m.widget.captureAndOpen();
    setTextarea(m, '旧身份');
    m.widget.setAttribute('app-id', 'com.other.app');
    d.resolve({ blob: PNG('late'), width: 100, height: 100 });
    await p;
    expect(m.textarea.value).toBe('');
    expect(m.screenshotWrap.hidden).toBe(true);
  });

  it('两实例互不影响（不互释图片与草稿）', async () => {
    const a = mount();
    const b = mount();
    a.widget.captureProvider = vi.fn(async () => ({ blob: PNG('A'), width: 100, height: 100 }));
    await a.widget.captureAndOpen();
    setTextarea(b, 'B 的文字');
    expect(a.screenshotWrap.hidden).toBe(false);
    expect(b.screenshotWrap.hidden).toBe(true);
    expect(a.textarea.value).toBe('');
    expect(b.textarea.value).toBe('B 的文字');
    // A 的截图不得出现在 B
    a.widget.remove();
    b.widget.remove();
  });

  it('敏感区域存在而 provider 无同帧证明 → 拒用截图，旧草稿保留', async () => {
    const m = mount();
    addNode('<input type="password" value="s3cret">', '100,100,120,24');
    m.widget.captureProvider = vi.fn(async () => ({ blob: PNG('unsafe'), width: 100, height: 100 }));
    await m.widget.captureAndOpen();
    expect(m.screenshotWrap.hidden).toBe(true); // 拒用
    expect(m.statusRegion.textContent).toContain('截图未完成');
  });

  it('敏感区域 + 同帧证明 → 接受，capture 元数据区分 viewport/pixel', async () => {
    const m = mount();
    addNode('<input type="password" value="s3cret">', '100,100,120,24');
    m.widget.captureProvider = vi.fn(async () => ({
      blob: PNG('safe'),
      width: 200,
      height: 100,
      viewport: { width: 800, height: 600 },
      sameFrameMasking: true,
      maskedRegions: [{ x: 20, y: 20, width: 40, height: 8 }],
    }));
    await m.widget.captureAndOpen();
    expect(m.screenshotWrap.hidden).toBe(false);

    completeLogin(m);
    setTextarea(m, '带遮挡证明的反馈');
    let meta: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (_u: unknown, init?: { body?: FormData }) => {
      meta = JSON.parse((init?.body?.get('metadata') as string) ?? 'null');
      return httpResponse(201, { feedbackId: 'fb-mask', status: 'received' });
    });
    vi.stubGlobal('fetch', fetchMock);
    m.submitBtn.click();
    await tick();
    expect(meta).not.toBeNull();
    const capture = meta!.capture as Record<string, unknown>;
    expect(capture.viewportWidth).toBe(800);
    expect(capture.pixelWidth).toBe(200);
    expect(capture.pixelHeight).toBe(100);
  });
});

describe('冻结提交快照', () => {
  it('提交期间禁用编辑与重复提交', async () => {
    const d = deferred<unknown>();
    const fetchMock = vi.fn(() => d.promise as Promise<unknown>);
    vi.stubGlobal('fetch', fetchMock);
    const m = mount();
    completeLogin(m);
    setTextarea(m, '快照文字');
    m.submitBtn.click();
    await tick(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(m.textarea.disabled).toBe(true);
    m.submitBtn.click();
    m.submitBtn.click();
    await tick(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    d.resolve(httpResponse(201, { feedbackId: 'f1', status: 'received' }));
    await tick();
  });

  it('失败后草稿未变：重试用同 key 同字节', async () => {
    const bodies: unknown[] = [];
    let first = true;
    const fetchMock = vi.fn(async (_u: unknown, init?: { body?: string }) => {
      bodies.push(init?.body);
      if (first) {
        first = false;
        return httpResponse(500, { error: { code: 'server_error', message: 'boom' } });
      }
      return httpResponse(201, { feedbackId: 'f2', status: 'received' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const m = mount();
    completeLogin(m);
    setTextarea(m, '重试内容');
    m.submitBtn.click();
    await tick();
    const retry = m.errorRegion.querySelector<HTMLButtonElement>('.fb-retry');
    expect(retry).not.toBeNull();
    retry?.click();
    await tick();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]); // 同 key 同字节
  });

  it('结果未知后修改草稿：新请求新 key，原请求保留供核对', async () => {
    const keys: string[] = [];
    const fetchMock = vi.fn(async (_u: unknown, init?: { body?: string }) => {
      keys.push(String(JSON.parse(init!.body!).idempotencyKey));
      return httpResponse(500, { error: { code: 'server_error', message: 'boom' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const m = mount();
    completeLogin(m);
    setTextarea(m, '第一次');
    m.submitBtn.click();
    await tick();
    setTextarea(m, '第二次修改后的内容');
    m.submitBtn.click();
    await tick();
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(m.errorRegion.textContent).toContain('结果未知的原请求');
  });

  it('409 idempotency_conflict：显示冲突且不自动换 key', async () => {
    const keys: string[] = [];
    const fetchMock = vi.fn(async (_u: unknown, init?: { body?: string }) => {
      keys.push(String(JSON.parse(init!.body!).idempotencyKey));
      return httpResponse(409, { error: { code: 'idempotency_conflict', message: '冲突' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const m = mount();
    completeLogin(m);
    setTextarea(m, '冲突内容');
    m.submitBtn.click();
    await tick();
    expect(m.errorRegion.textContent).toContain('提交冲突');
    m.errorRegion.querySelector<HTMLButtonElement>('.fb-retry')?.click();
    await tick();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]); // 不自动换 key
  });

  it('重拍失败不丢旧截图', async () => {
    const m = mount();
    let n = 0;
    m.widget.captureProvider = vi.fn(async () => {
      n++;
      if (n === 1) return { blob: PNG('old!'), width: 100, height: 100 };
      throw new Error('provider boom');
    });
    await m.widget.captureAndOpen();
    expect(m.screenshotThumb.src).toContain('blob:mock-4');
    m.retakeBtn.click();
    await tick();
    expect(m.screenshotThumb.src).toContain('blob:mock-4'); // 旧图仍在
    expect(m.statusRegion.textContent).toContain('截图未完成');
  });

  it('登录挂起期间迟到的捕获不进入请求；提交冻结后无图片', async () => {
    const m = mount();
    completeLogin(m);
    const d = deferred<Shot>();
    m.widget.captureProvider = vi.fn(() => d.promise);
    const capturePromise = m.widget.captureAndOpen();
    setTextarea(m, '只有文字');
    let initBody: unknown = 'sentinel';
    const fetchMock = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
      initBody = init?.body;
      return httpResponse(201, { feedbackId: 'f3', status: 'received' });
    });
    vi.stubGlobal('fetch', fetchMock);
    m.submitBtn.click(); // 快照冻结（无图）→ 进行中的捕获被失效
    await tick();
    d.resolve({ blob: PNG('late!'), width: 100, height: 100 });
    await capturePromise;
    expect(typeof initBody).toBe('string'); // JSON 提交而非 multipart
    const body = JSON.parse(initBody as string);
    expect(body.text).toBe('只有文字');
    expect(body.capture).toBeUndefined();
    expect(m.screenshotWrap.hidden).toBe(true); // 迟到的截图被丢弃
  });

  it('登录期间重拍先完成：自动提交用新 key 与新图片字节', async () => {
    const m = mount();
    // 1) 首次捕获成功 image1
    m.widget.captureProvider = vi.fn(async () => ({ blob: PNG('image1'), width: 100, height: 100 }));
    await m.widget.captureAndOpen();
    expect(m.screenshotThumb.src).toContain('blob:mock-6');
    setTextarea(m, '交错测试');

    // 2) 未登录点击提交 → 冻结快照（key K1，未发送）+ 登录挂起
    const { urls } = stubWindowOpen({ closed: false });
    m.submitBtn.click();
    await tick(5);
    expect(urls).toHaveLength(1);

    // 3) 登录挂起期间重拍 image2 并完成（会话有效：草稿被替换）
    m.widget.captureProvider = vi.fn(async () => ({ blob: PNG('image2'), width: 100, height: 100 }));
    await m.widget.retakeScreenshot();
    expect(m.screenshotThumb.src).toContain('blob:mock-6'); // 'image2' size=6 同长——用字节断言区分

    let formBody: FormData | null = null;
    const fetchMock = vi.fn(async (_u: unknown, init?: { body?: FormData }) => {
      formBody = init?.body ?? null;
      return httpResponse(201, { feedbackId: 'f4', status: 'received' });
    });
    vi.stubGlobal('fetch', fetchMock);

    // 4) 登录完成 → 自动提交：草稿已变 → 新快照新 key + image2 字节
    const nonce = new URL(urls[0]!).searchParams.get('nonce')!;
    deliverAuthMessage({ token: 'tok', nonce });
    await tick(20);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(formBody).toBeInstanceOf(FormData);
    const meta = JSON.parse(((formBody as unknown) as FormData).get('metadata') as string);
    expect(meta.text).toBe('交错测试');
    expect(meta.idempotencyKey).toBeTruthy(); // K1 从未上线，实际发出的是新 key
    const shot = ((formBody as unknown) as FormData).get('screenshot') as Blob;
    expect(shot).toBeInstanceOf(Blob);
    expect(new TextDecoder().decode(await shot.arrayBuffer())).toBe('image2');
  });
});

describe('遮挡失败时的提交行为（内置路径）', () => {
  async function mountLoggedIn(): Promise<ReturnType<typeof mount>> {
    const m = mount();
    completeLogin(m);
    return m;
  }

  it('必需遮挡失败：无新预览；首次截图失败后提交不含图片', async () => {
    hoisted.state.paint = false; // 位图填充失效 → verify-failed
    addNode('<input type="password" value="pw">', '100,100,120,24');
    const m = await mountLoggedIn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await m.widget.captureAndOpen(); // 无 provider → 内置路径（mock 渲染器）
    expect(m.screenshotWrap.hidden).toBe(true); // 无新预览
    expect(m.statusRegion.textContent).toContain('截图未完成');
    expect(hoisted.state.toBlobCalls).toBe(0); // 遮挡失败时从未编码

    setTextarea(m, '继续文字反馈');
    let body: unknown = 'sentinel';
    const fetchMock = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
      body = init?.body;
      return httpResponse(201, { feedbackId: 'f-text-only', status: 'received' });
    });
    vi.stubGlobal('fetch', fetchMock);
    m.submitBtn.click();
    await tick();
    expect(typeof body).toBe('string'); // JSON：无截图部件
    expect(JSON.parse(body as string).capture).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('遮挡失败重拍：旧预览与旧截图字节保留，提交仍用旧图', async () => {
    const m = await mountLoggedIn();
    m.widget.captureProvider = vi.fn(async () => ({ blob: PNG('image1'), width: 100, height: 100 }));
    await m.widget.captureAndOpen();
    expect(m.screenshotThumb.src).toContain('blob:mock-6');

    // 撤掉 provider 走内置路径 + 填充失效 → 遮挡验证失败
    addNode('<input type="password" value="pw">', '300,300,50,20');
    m.widget.captureProvider = undefined;
    hoisted.state.paint = false;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await m.widget.retakeScreenshot();
    expect(m.screenshotThumb.src).toContain('blob:mock-6'); // 无新预览，旧图在
    expect(m.statusRegion.textContent).toContain('截图未完成');

    setTextarea(m, '用旧截图提交');
    let form: FormData | null = null;
    const fetchMock = vi.fn(async (_u: unknown, init?: { body?: FormData }) => {
      form = init?.body ?? null;
      return httpResponse(201, { feedbackId: 'f-old', status: 'received' });
    });
    vi.stubGlobal('fetch', fetchMock);
    m.submitBtn.click();
    await tick();
    expect(form).toBeInstanceOf(FormData);
    const shot = ((form as unknown) as FormData).get('screenshot') as Blob;
    expect(new TextDecoder().decode(await shot.arrayBuffer())).toBe('image1'); // 提交的仍是旧字节
    warnSpy.mockRestore();
  });

  it('内置路径成功：敏感区在最终 PNG 中为覆盖色，草稿元数据含 pixel 尺寸', async () => {
    addNode('<input type="password" value="pw">', '100,100,120,24');
    addNode('<div></div>', '10,10,30,30', { color: [0, 128, 0, 255] });
    const m = await mountLoggedIn();
    await m.widget.captureAndOpen();
    expect(m.screenshotWrap.hidden).toBe(false);

    let form: FormData | null = null;
    const fetchMock = vi.fn(async (_u: unknown, init?: { body?: FormData }) => {
      form = init?.body ?? null;
      return httpResponse(201, { feedbackId: 'f-builtin', status: 'received' });
    });
    vi.stubGlobal('fetch', fetchMock);
    setTextarea(m, '内置截图反馈');
    m.submitBtn.click();
    await tick();
    const meta = JSON.parse(((form as unknown) as FormData).get('metadata') as string);
    // 元数据区分逻辑视口与输出像素（dpr 1 → 相同）
    expect(meta.capture.viewportWidth).toBe(window.innerWidth);
    expect(meta.capture.pixelWidth).toBeGreaterThan(0);
    expect(meta.capture.pixelWidth).toBeLessThanOrEqual(2048);
    // 提交的 PNG：敏感区覆盖色、装饰节点原色（组件级端到端像素断言）
    const shot = ((form as unknown) as FormData).get('screenshot') as Blob;
    expect(shot.type).toBe('image/png');
    const png = await blobToPng(shot);
    expect(isCoverPixel(png, 150, 110)).toBe(true);
    expect(isCoverPixel(png, 99, 99)).toBe(true);
    expect(pixelColor(png, 25, 25)).toEqual([0, 128, 0, 255]);
  });
});
