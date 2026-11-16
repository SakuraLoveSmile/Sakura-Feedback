import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Window, type HTMLLinkElement as TestLinkElement } from 'happy-dom';
import { captureViewport } from '../src/capture';
import { createState, FakeCanvas } from './pixel-fixture';

const viewport = { width: 100, height: 80, scrollX: 0, scrollY: 0, dpr: 1 };
let source: Window;
let clone: Window;
let manualStyleEvent = false;

function emitStyleEvent(link: TestLinkElement, type: 'load' | 'error') {
  manualStyleEvent = true;
  try {
    link.dispatchEvent(new clone.Event(type));
  } finally {
    manualStyleEvent = false;
  }
}

beforeEach(() => {
  source = new Window({
    url: 'https://fixture.test/app/page',
    settings: { disableCSSFileLoading: true, disableIframePageLoading: true },
  });
  clone = new Window({
    url: 'https://fixture.test/app/page',
    settings: { disableCSSFileLoading: true, disableIframePageLoading: true },
  });
  // Happy DOM emits a synchronous error when inserting links with CSS loading
  // disabled. Keep network isolated and model browser load/error events below.
  const dispatch = clone.HTMLLinkElement.prototype.dispatchEvent;
  vi.spyOn(clone.HTMLLinkElement.prototype, 'dispatchEvent').mockImplementation(function (this: TestLinkElement, event) {
    return manualStyleEvent ? dispatch.call(this, event) : true;
  });
  vi.stubGlobal('document', source.document);
});

afterEach(async () => {
  await source.happyDOM.cancelAsync();
  await clone.happyDOM.cancelAsync();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function stylesheet(href: string, css: string) {
  const link = source.document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  source.document.head.appendChild(link);
  const sheet = new source.CSSStyleSheet();
  sheet.replaceSync(css);
  Object.defineProperty(sheet, 'href', { value: link.href });
  Object.defineProperty(link, 'sheet', { value: sheet });
  return { link, sheet };
}

function cloneSource() {
  clone.document.documentElement.innerHTML = source.document.documentElement.innerHTML;
}

type CloneHook = (doc: Document) => void | Promise<void>;

async function capture(inspect?: (options: Record<string, unknown>) => void) {
  return captureViewport({
    viewport,
    expectedSensitiveCount: 0,
    html2canvas: async (_el, options) => {
      inspect?.(options!);
      cloneSource();
      await (options!.onclone as CloneHook)(clone.document as unknown as Document);
      const canvas = new FakeCanvas(createState());
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      return canvas as unknown as HTMLCanvasElement;
    },
  });
}

function clonedStyles() {
  return [...clone.document.querySelectorAll('style')]
    .filter((style) => !style.hasAttribute('data-feedback-capture-mask-style'));
}

describe('真实源文档与克隆分离的样式捕获边界', () => {
  it('外链 CSS 二次加载失败仍使用源 CSSOM，且不修改源节点', async () => {
    const { link } = stylesheet('/css/main.css', '.desktop-only { display: none; }');
    const sourceMarkup = source.document.documentElement.outerHTML;
    await capture();

    expect(clonedStyles().map((style) => style.textContent).join('')).toContain('.desktop-only');
    expect(clone.document.querySelector('link[rel="stylesheet"]')).toBeNull();
    expect(link.parentNode).toBe(source.document.head);
    expect(source.document.documentElement.outerHTML).toBe(sourceMarkup);
  });

  it('保留多张表的级联顺序、媒体条件，禁用表不会在克隆中重新启用', async () => {
    stylesheet('/css/first.css', '.probe { color: red; }');
    const second = stylesheet('/css/second.css', '.probe { color: blue; }');
    second.link.media = '(min-width: 900px)';
    const disabled = stylesheet('/css/off.css', '.probe { display: none; }');
    // Happy DOM's link type omits the native disabled IDL property.
    Object.defineProperty(disabled.link, 'disabled', { value: true });

    await capture();
    const styles = clonedStyles();
    expect(styles[0]?.textContent).toContain('red');
    expect(styles[1]?.textContent).toContain('blue');
    expect(styles[1]?.media).toBe('(min-width: 900px)');
    expect((clone.document.querySelector('link[href="/css/off.css"]') as unknown as HTMLLinkElement).disabled).toBe(true);
  });

  it('外链背景和字体 URL 仍相对于原 CSS，字符串中的 url 字样不改写', async () => {
    stylesheet('/css/nested/main.css', '.probe { background-image: url("../images/test.png"); content: "url(leave-me)"; } @font-face { font-family: Fixture; src: url(../../fonts/test.woff2); }');
    await capture();
    const css = clonedStyles().map((style) => style.textContent).join('');
    expect(css).toContain('https://fixture.test/css/images/test.png');
    expect(css).toContain('https://fixture.test/fonts/test.woff2');
    expect(css).toContain('url(leave-me)');
  });

  it('在 renderer 前冻结源 CSSOM，途中改变源表不污染本次克隆', async () => {
    const { sheet } = stylesheet('/css/main.css', '.probe { color: red; }');
    await capture(() => sheet.replaceSync('.probe { color: blue; }'));
    const css = clonedStyles().map((style) => style.textContent).join('');
    expect(css).toContain('red');
    expect(css).not.toContain('blue');
  });

  it('不可读的跨源表在克隆中加载失败时拒绝该截图', async () => {
    const { sheet } = stylesheet('https://cdn.fixture.test/main.css', '.probe { color: red; }');
    Object.defineProperty(sheet, 'cssRules', {
      get: () => { throw new source.DOMException('opaque stylesheet', 'SecurityError'); },
    });
    vi.useFakeTimers();
    const result = capture();
    const settled = result.then(() => null, (error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await settled).toMatchObject({ reason: 'verify-failed' });
  });

  it('跨源表请求失败即使 sheet 仍存在也不能当作加载成功', async () => {
    const { sheet } = stylesheet('https://cdn.fixture.test/main.css', '');
    Object.defineProperty(sheet, 'cssRules', {
      get: () => { throw new source.DOMException('opaque stylesheet', 'SecurityError'); },
    });
    await expect(captureViewport({
      viewport,
      expectedSensitiveCount: 0,
      html2canvas: async (_el, options) => {
        cloneSource();
        Object.defineProperty(clone.document.querySelector('link')!, 'sheet', { value: sheet });
        const pending = (options!.onclone as CloneHook)(clone.document as unknown as Document);
        // Chromium retains an opaque CSSStyleSheet even after a failed request.
        // Reproduce that state and the actual network failure event separately.
        const requested = clone.document.querySelector('link')!;
        if (!requested.sheet) Object.defineProperty(requested, 'sheet', { value: sheet });
        emitStyleEvent(requested, 'error');
        await pending;
        return new FakeCanvas(createState()) as unknown as HTMLCanvasElement;
      },
    })).rejects.toMatchObject({ reason: 'verify-failed' });
    expect(clone.document.querySelector('link')).toBeNull();
  });

  it('保留已加载 @import 的 layer/supports/media 和导入表自身的 URL 基址', async () => {
    const { sheet } = stylesheet('/css/main.css', '');
    const imported = new source.CSSStyleSheet();
    imported.replaceSync('.nested { background: url("../images/nested.png"); }');
    // Happy DOM does not load @import. Supply the CSSOM the real browser has
    // after loading it, without performing any serialization for the code under test.
    Object.defineProperty(sheet, 'cssRules', { value: [{
      type: 3,
      href: 'nested/import.css',
      styleSheet: imported,
      media: { mediaText: 'screen and (min-width: 400px)' },
      supportsText: 'display: grid',
      layerName: 'imported',
    }] });
    await capture();
    const css = clonedStyles()[0]!.textContent;
    expect(css).toContain('@layer imported');
    expect(css).toContain('@supports (display: grid)');
    expect(css).toContain('@media screen and (min-width: 400px)');
    expect(css).toContain('https://fixture.test/css/images/nested.png');
  });

  it('资源 token 支持括号与 CSS 转义，并保留本地 SVG 引用和普通字符串', async () => {
    const { sheet } = stylesheet('/css/main.css', '');
    // Happy DOM drops valid url("a(b).png") values. Model that valid CSSRule
    // directly; assertions still exercise the production token parser end to end.
    Object.defineProperty(sheet, 'cssRules', { value: [{ type: 1, cssText:
      '.probe { background: url("images/a(b).png"); mask: url(images/a\\)b.png); cursor: url("images/\\61 b.png"); filter: url(#local); content: "url(leave-me)"; background-image: image-set("images/one.png" 1x, url("images/two.png") 2x); }',
    }] });
    await capture();
    const css = clonedStyles()[0]!.textContent;
    expect(css).toContain('https://fixture.test/css/images/a(b).png');
    expect(css).toContain('https://fixture.test/css/images/a)b.png');
    expect(css).toContain('https://fixture.test/css/images/ab.png');
    expect(css).toContain('url("#local")');
    expect(css).toContain('"url(leave-me)"');
    expect(css).toContain('https://fixture.test/css/images/one.png');
    expect(css).toContain('https://fixture.test/css/images/two.png');
  });

  it('跨源 CSSOM 不可读时通过新链接的 load 事件确认加载并保留属性', async () => {
    const { link: sourceLink, sheet } = stylesheet('https://cdn.fixture.test/main.css', '.probe { color: red; }');
    sourceLink.crossOrigin = 'anonymous';
    sourceLink.referrerPolicy = 'no-referrer';
    sourceLink.setAttribute('integrity', 'sha256-fixture');
    Object.defineProperty(sourceLink, 'nonce', { value: 'fixture-nonce' });
    Object.defineProperty(sheet, 'cssRules', {
      get: () => { throw new source.DOMException('opaque stylesheet', 'SecurityError'); },
    });
    await captureViewport({
      viewport,
      expectedSensitiveCount: 0,
      html2canvas: async (_el, options) => {
        cloneSource();
        const link = clone.document.querySelector('link')!;
        Object.defineProperty(link, 'sheet', { value: sheet });
        const pending = (options!.onclone as CloneHook)(clone.document as unknown as Document);
        const requested = clone.document.querySelector('link')!;
        expect(requested).not.toBe(link);
        Object.defineProperty(requested, 'sheet', { value: sheet });
        emitStyleEvent(requested, 'load');
        await pending;
        expect(link.isConnected).toBe(false);
        expect(requested.isConnected).toBe(true);
        expect(requested.href).toBe(sourceLink.href);
        expect(requested.crossOrigin).toBe('anonymous');
        expect(requested.referrerPolicy).toBe('no-referrer');
        expect(requested.getAttribute('integrity')).toBe('sha256-fixture');
        expect((requested as unknown as HTMLLinkElement).nonce).toBe('fixture-nonce');
        const canvas = new FakeCanvas(createState());
        return canvas as unknown as HTMLCanvasElement;
      },
    });
    expect(clonedStyles()).toHaveLength(0);
  });

  it('data-html2canvas-ignore 子树中的外链不会被误当作克隆缺失样式', async () => {
    const { link } = stylesheet('/css/ignored.css', '.private-ui { color: red; }');
    const ignored = source.document.createElement('aside');
    ignored.setAttribute('data-html2canvas-ignore', '');
    source.document.body.append(ignored);
    ignored.append(link);
    await captureViewport({
      viewport,
      expectedSensitiveCount: 0,
      html2canvas: async (_el, options) => {
        cloneSource();
        // Match html2canvas's actual exclusion, rather than helping the code
        // restore styles that should never have been part of the screenshot.
        clone.document.querySelector('[data-html2canvas-ignore]')!.remove();
        await (options!.onclone as CloneHook)(clone.document as unknown as Document);
        return new FakeCanvas(createState()) as unknown as HTMLCanvasElement;
      },
    });
    expect(clonedStyles()).toHaveLength(0);
    expect(ignored.isConnected).toBe(true);
  });

  it('alternate 表保留 rel/title，且不会被赋 disabled=false 从而意外启用', async () => {
    const { link, sheet } = stylesheet('/css/alternate.css', '.probe { display: none; }');
    link.rel = 'alternate stylesheet';
    link.title = 'Unselected';
    await captureViewport({
      viewport,
      expectedSensitiveCount: 0,
      html2canvas: async (_el, options) => {
        cloneSource();
        const copied = clone.document.querySelector('link')!;
        Object.defineProperty(copied, 'sheet', { value: sheet });
        const toggle = vi.fn();
        // Watch every clone link, including the fresh load-validation link.
        Object.defineProperty(clone.HTMLLinkElement.prototype, 'disabled', { configurable: true, get: () => false, set: toggle });
        const pending = (options!.onclone as CloneHook)(clone.document as unknown as Document);
        const requested = clone.document.querySelector('link')!;
        Object.defineProperty(requested, 'sheet', { value: sheet });
        emitStyleEvent(requested, 'load');
        await pending;
        expect(toggle).not.toHaveBeenCalled();
        expect(copied.isConnected).toBe(false);
        expect(requested.rel).toBe('alternate stylesheet');
        expect(requested.title).toBe('Unselected');
        return new FakeCanvas(createState()) as unknown as HTMLCanvasElement;
      },
    });
    expect(clonedStyles()).toHaveLength(0);
  });

  it('可读父 CSS 的生效导入不可读取时不能只凭父表加载成功就接受截图', async () => {
    const { sheet } = stylesheet('/css/main.css', '');
    const opaque = new source.CSSStyleSheet();
    Object.defineProperty(opaque, 'cssRules', {
      get: () => { throw new source.DOMException('opaque import', 'SecurityError'); },
    });
    Object.defineProperty(sheet, 'cssRules', { value: [{
      type: 3,
      href: 'https://cdn.fixture.test/import.css',
      styleSheet: opaque,
      media: { mediaText: '' },
      supportsText: null,
      layerName: null,
    }] });
    await expect(capture()).rejects.toMatchObject({ reason: 'verify-failed' });
  });

  it('等待跨源样式时取消会终止等待，并清理自己的 iframe', async () => {
    const { sheet } = stylesheet('https://cdn.fixture.test/main.css', '');
    Object.defineProperty(sheet, 'cssRules', {
      get: () => { throw new source.DOMException('opaque stylesheet', 'SecurityError'); },
    });
    const own = source.document.createElement('iframe');
    source.document.body.append(own);
    Object.defineProperty(clone, 'frameElement', { value: own });
    const controller = new AbortController();
    const result = captureViewport({
      viewport,
      expectedSensitiveCount: 0,
      signal: controller.signal,
      html2canvas: async (_el, options) => {
        cloneSource();
        const pending = (options!.onclone as CloneHook)(clone.document as unknown as Document);
        controller.abort();
        await pending;
        throw new Error('unreachable');
      },
    });
    await expect(result).rejects.toMatchObject({ reason: 'aborted' });
    expect(own.isConnected).toBe(false);
    expect(clone.document.querySelector('link')).toBeNull();
  });

  it('样式恢复后先布局再等待实际字体；字体等待期间的取消仍然生效', async () => {
    stylesheet('/css/main.css', '.probe { font-family: Fixture; }');
    const layout = vi.spyOn(clone.document.documentElement, 'getBoundingClientRect');
    let finishFont!: () => void;
    const ready = new Promise<void>((resolve) => { finishFont = resolve; });
    Object.defineProperty(clone.document, 'fonts', { get: () => {
      expect(layout).toHaveBeenCalled();
      return { ready };
    } });
    const controller = new AbortController();
    const result = captureViewport({
      viewport,
      expectedSensitiveCount: 0,
      signal: controller.signal,
      html2canvas: async (_el, options) => {
        cloneSource();
        const pending = (options!.onclone as CloneHook)(clone.document as unknown as Document);
        controller.abort();
        await pending;
        throw new Error('unreachable');
      },
    });
    await expect(result).rejects.toMatchObject({ reason: 'aborted' });
    finishFont();
  });

  it('把取消信号传给 renderer，并且 clone hook 失败仅清理本次 iframe', async () => {
    const own = source.document.createElement('iframe');
    const unrelated = source.document.createElement('iframe');
    source.document.body.append(own, unrelated);
    Object.defineProperty(clone, 'frameElement', { value: own });
    const controller = new AbortController();
    await expect(captureViewport({
      viewport,
      expectedSensitiveCount: 1,
      signal: controller.signal,
      html2canvas: async (_el, options) => {
        expect(options?.signal).toBe(controller.signal);
        await (options!.onclone as CloneHook)(clone.document as unknown as Document);
        throw new Error('unreachable');
      },
    })).rejects.toMatchObject({ reason: 'locate-failed' });
    expect(own.isConnected).toBe(false);
    expect(unrelated.isConnected).toBe(true);
  });
});
