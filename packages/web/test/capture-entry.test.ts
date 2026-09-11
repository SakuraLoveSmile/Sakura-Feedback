/**
 * 面板内**手动截图入口**回归（本次修复：Web 侧边组件的截图入口缺口）。
 *
 * 缺口成因（源码确认）：
 *  1. 截图操作区（`重新截图 / 移除截图`）整体长在「仅有截图才显示」的预览里
 *     （`syncUi` 里 `draft.screenshotUrl` 为空 → 整个 `.fb-screenshot-wrap` 隐藏），
 *     默认 `capture-mode="off"`（不自动截图）的宿主因而**没有首次截图入口**；
 *  2. 手动补拍若走 `captureAndOpen()`（呼出语义）又会被草稿拦下——`isDraftDirty()`
 *     只看「有文字或有截图」，用户先输入文字后就**再没有补拍入口**。
 *
 * 选定的行为：`capture-mode="off"` 只关闭**自动**截图，面板里始终提供手动截图；
 * 手动入口复用显式重拍流程（可替换旧图、失败不丢旧图与文字）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/index';
import { cleanup, completeLogin, httpResponse, mount, setTextarea } from './helpers';

const PNG = (tag: string) => new Blob([tag], { type: 'image/png' });
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type Shot = { blob: Blob; width: number; height: number };

/** 元素是否真的可见：自身 hidden 或落在 hidden 祖先里都算不可见。 */
function shown(el: HTMLElement): boolean {
  return !el.hidden && el.closest('[hidden]') === null;
}

/** 程序化触发点击：`HTMLElement.click()` 在禁用按钮上会被浏览器吞掉，
 *  这里要验证的是组件自身的重入守卫（而不只是禁用态）。 */
function forceClick(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockImplementation(
    (b: Blob | MediaSource) => `blob:mock-${(b as Blob).size ?? 0}`,
  );
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(cleanup);

describe('面板内手动截图入口', () => {
  it('默认 capture-mode=off：呼出面板不自动拍摄，但面板里有「截取当前页面」', async () => {
    const m = mount();
    const provider = vi.fn(async (): Promise<Shot> => ({ blob: PNG('shot!'), width: 800, height: 600 }));
    m.widget.captureProvider = provider;

    m.fab.click();
    await tick();

    expect(m.panel.classList.contains('is-open')).toBe(true);
    expect(provider).not.toHaveBeenCalled(); // 打开面板 ≠ 自动截图
    expect(shown(m.captureBtn)).toBe(true);
    expect(m.captureBtn.textContent).toBe('截取当前页面');
    expect(m.captureBtn.disabled).toBe(false);
    // 无截图：预览、放大、重拍、移除一律不出现
    expect(shown(m.screenshotWrap)).toBe(false);
    expect(shown(m.retakeBtn)).toBe(false);
    expect(shown(m.removeBtn)).toBe(false);
    // 缩略图不可聚焦（窄屏焦点锁不会把焦点交给不可见元素）
    expect(m.root.querySelector<HTMLElement>('.fb-screenshot-thumb-box')?.tabIndex).toBe(-1);
  });

  it('先输入文字再手动截图：文字保留，captureAndOpen 的草稿恢复规则不变', async () => {
    const m = mount();
    const provider = vi.fn(async (): Promise<Shot> => ({ blob: PNG('manual'), width: 800, height: 600 }));
    m.widget.captureProvider = provider;

    m.fab.click();
    setTextarea(m, '先写的文字');

    // 呼出语义：草稿已脏 → 只恢复草稿、绝不重拍（这条规则保持不变）
    await m.widget.captureAndOpen();
    expect(provider).not.toHaveBeenCalled();

    // 面板内手动入口不受草稿影响
    m.captureBtn.click();
    await tick();

    expect(provider).toHaveBeenCalledTimes(1);
    expect(m.textarea.value).toBe('先写的文字');
    expect(shown(m.screenshotWrap)).toBe(true);
    expect(m.screenshotThumb.src).toContain('blob:mock-');
    expect(shown(m.captureBtn)).toBe(false);
    expect(shown(m.retakeBtn)).toBe(true);
    expect(shown(m.removeBtn)).toBe(true);
    expect(m.panel.classList.contains('is-open')).toBe(true);
    expect(m.panel.style.visibility).toBe(''); // 捕获结束后面板恢复可见
  });

  it('手动截图进入草稿并随 multipart 提交（字节与截图部件一致）', async () => {
    const m = mount();
    const bytes = PNG('manual-bytes');
    m.widget.captureProvider = vi.fn(async (): Promise<Shot> => ({ blob: bytes, width: 1024, height: 768 }));

    m.fab.click();
    m.captureBtn.click();
    await tick();
    setTextarea(m, '手动截图 + 文字');
    completeLogin(m);

    let body: FormData | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: unknown, init?: { body?: FormData }) => {
        body = init?.body ?? null;
        return httpResponse(201, { feedbackId: 'fb-manual', status: 'received' });
      }),
    );
    m.submitBtn.click();
    await tick();

    expect(body).toBeInstanceOf(FormData);
    const form = body as unknown as FormData;
    const shot = form.get('screenshot');
    expect(shot).toBeInstanceOf(Blob);
    expect(new TextDecoder().decode(await (shot as Blob).arrayBuffer())).toBe('manual-bytes');
    const meta = JSON.parse(form.get('metadata') as string);
    expect(meta.text).toBe('手动截图 + 文字');
    expect(meta.capture?.pixelWidth).toBe(1024);
  });

  it('首次截图失败：保留手动重试入口与文字，重试可成功', async () => {
    const m = mount();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    m.widget.captureProvider = vi.fn(async (): Promise<Shot> => {
      n++;
      if (n === 1) throw new Error('first boom');
      return { blob: PNG('second'), width: 800, height: 600 };
    });

    m.fab.click();
    setTextarea(m, '失败也要留住文字');
    m.captureBtn.click();
    await tick();

    expect(shown(m.screenshotWrap)).toBe(false);
    expect(m.statusRegion.textContent).toContain('截图未完成');
    expect(shown(m.captureBtn)).toBe(true);
    expect(m.captureBtn.disabled).toBe(false); // 重试入口可用
    expect(m.captureBtn.textContent).toBe('截取当前页面');
    expect(m.textarea.value).toBe('失败也要留住文字');

    m.captureBtn.click();
    await tick();
    expect(n).toBe(2);
    expect(shown(m.screenshotWrap)).toBe(true);
    warnSpy.mockRestore();
  });

  it('移除截图后回到首个入口：可再次补拍且文字保留', async () => {
    const m = mount();
    let n = 0;
    m.widget.captureProvider = vi.fn(async (): Promise<Shot> => {
      n++;
      return { blob: PNG(n === 1 ? 'first!' : 'again!'), width: 800, height: 600 };
    });

    m.fab.click();
    m.captureBtn.click();
    await tick();
    expect(shown(m.screenshotWrap)).toBe(true);

    setTextarea(m, '移除后仍要保留的文字');
    m.removeBtn.click();

    expect(shown(m.screenshotWrap)).toBe(false);
    expect(shown(m.captureBtn)).toBe(true);
    expect(shown(m.retakeBtn)).toBe(false);
    expect(shown(m.removeBtn)).toBe(false);
    expect(m.textarea.value).toBe('移除后仍要保留的文字');

    m.captureBtn.click();
    await tick();
    expect(n).toBe(2);
    expect(shown(m.screenshotWrap)).toBe(true);
  });

  it('重拍失败保留旧图与文字（经面板按钮）', async () => {
    const m = mount();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    m.widget.captureProvider = vi.fn(async (): Promise<Shot> => {
      n++;
      if (n === 1) return { blob: PNG('old!'), width: 800, height: 600 };
      throw new Error('retake boom');
    });

    m.fab.click();
    m.captureBtn.click();
    await tick();
    const before = m.screenshotThumb.src;
    expect(before).toContain('blob:mock-4');

    setTextarea(m, '重拍失败保留的文字');
    m.retakeBtn.click();
    await tick();

    expect(m.screenshotThumb.src).toBe(before); // 旧图仍在
    expect(shown(m.screenshotWrap)).toBe(true);
    expect(m.textarea.value).toBe('重拍失败保留的文字');
    expect(m.statusRegion.textContent).toContain('截图未完成');
    expect(shown(m.captureBtn)).toBe(false); // 有图时首个入口不重复出现
    expect(m.retakeBtn.disabled).toBe(false);
    warnSpy.mockRestore();
  });

  it('捕获期间禁用重复操作：加载态 + 单次会话（连击不产生第二个会话）', async () => {
    const m = mount();
    const d = deferred<Shot>();
    const provider = vi.fn(() => d.promise);
    m.widget.captureProvider = provider;

    m.fab.click();
    m.captureBtn.click();

    // 加载态与禁用态立刻生效（面板随后整体不可见，因此不可能被拍进截图）
    expect(m.captureBtn.disabled).toBe(true);
    expect(m.captureBtn.textContent).toBe('截取中…');
    expect(m.captureBtn.getAttribute('aria-busy')).toBe('true');
    expect(m.shotArea.classList.contains('is-capturing')).toBe(true);

    forceClick(m.captureBtn); // 连击（绕过禁用态，直接验证重入守卫）
    m.retakeBtn.click();
    m.removeBtn.click();
    expect(provider).toHaveBeenCalledTimes(1);

    d.resolve({ blob: PNG('once!'), width: 800, height: 600 });
    await tick();

    expect(m.captureBtn.disabled).toBe(false);
    expect(m.captureBtn.textContent).toBe('截取当前页面');
    expect(m.captureBtn.hasAttribute('aria-busy')).toBe(false);
    expect(m.shotArea.classList.contains('is-capturing')).toBe(false);
    expect(shown(m.screenshotWrap)).toBe(true);
  });

  it('捕获期间关闭面板：迟到结果不开面板、不写草稿，UI 恢复可用', async () => {
    const m = mount();
    const d = deferred<Shot>();
    m.widget.captureProvider = vi.fn(() => d.promise);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    m.fab.click();
    setTextarea(m, '关面板前的文字');
    m.captureBtn.click();
    m.widget.close();

    d.resolve({ blob: PNG('late!'), width: 800, height: 600 });
    await tick();

    expect(m.panel.classList.contains('is-open')).toBe(false);
    expect(shown(m.screenshotWrap)).toBe(false);
    expect(m.textarea.value).toBe('关面板前的文字'); // 迟到结果不污染草稿
    expect(m.captureBtn.disabled).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();

    m.fab.click(); // 重新呼出：入口仍在
    expect(m.panel.classList.contains('is-open')).toBe(true);
    expect(shown(m.captureBtn)).toBe(true);
  });

  it('捕获期间卸载：迟到结果不写入草稿，重挂载后不出现预览', async () => {
    const m = mount();
    const d = deferred<Shot>();
    m.widget.captureProvider = vi.fn(() => d.promise);

    m.fab.click();
    m.captureBtn.click();
    m.widget.remove();

    d.resolve({ blob: PNG('late!'), width: 800, height: 600 });
    await tick();

    document.body.appendChild(m.widget);
    expect(shown(m.screenshotWrap)).toBe(false);
    expect(shown(m.captureBtn)).toBe(true);
    expect(m.screenshotThumb.getAttribute('src')).toBeNull();
  });

  it('捕获期间切换身份（app-id）：迟到结果不写入新身份', async () => {
    const m = mount();
    const d = deferred<Shot>();
    m.widget.captureProvider = vi.fn(() => d.promise);

    m.fab.click();
    setTextarea(m, '旧身份文字');
    m.captureBtn.click();
    m.widget.setAttribute('app-id', 'com.other.app');

    d.resolve({ blob: PNG('late!'), width: 800, height: 600 });
    await tick();

    expect(shown(m.screenshotWrap)).toBe(false);
    expect(m.textarea.value).toBe('');
    expect(shown(m.captureBtn)).toBe(true);
    expect(m.captureBtn.disabled).toBe(false);
  });

  it('截图后焦点留在面板内（按钮被换成隐藏按钮时不落到 body）', async () => {
    const m = mount();
    m.widget.captureProvider = vi.fn(async (): Promise<Shot> => {
      // 捕获期间面板 visibility:hidden → 真实浏览器把焦点丢到 body
      document.body.focus();
      return { blob: PNG('focus!'), width: 800, height: 600 };
    });

    m.fab.click(); // 打开面板 → 聚焦 textarea
    expect(m.root.activeElement).toBe(m.textarea);
    m.captureBtn.focus();
    expect(m.root.activeElement).toBe(m.captureBtn);

    m.captureBtn.click();
    await tick();

    expect(shown(m.screenshotWrap)).toBe(true);
    expect(m.captureBtn.hidden).toBe(true); // 入口已换成「重新截图」
    expect(m.root.activeElement).toBe(m.textarea); // 焦点回到面板里，而不是 body
  });

  it('焦点卡在已隐藏的按钮上（引擎不主动失焦）时也要还回面板', async () => {
    const m = mount();
    // 不模拟 blur：happy-dom 不会因为元素变 hidden 而移走焦点，正好覆盖「卡在隐藏控件」分支
    m.widget.captureProvider = vi.fn(
      async (): Promise<Shot> => ({ blob: PNG('stuck'), width: 800, height: 600 }),
    );

    m.fab.click();
    m.captureBtn.focus();
    m.captureBtn.click();
    await tick();

    expect(m.captureBtn.hidden).toBe(true);
    expect(m.root.activeElement).not.toBe(m.captureBtn); // 绝不留在隐藏按钮上
    expect(m.root.activeElement).toBe(m.textarea);
  });

  it('用户已主动聚焦别处时不抢焦点', async () => {
    const m = mount();
    const closeBtn = m.panel.querySelector<HTMLButtonElement>('.fb-close') as HTMLButtonElement;
    m.widget.captureProvider = vi.fn(async (): Promise<Shot> => {
      closeBtn.focus(); // 捕获期间用户/脚本已把焦点放到别的控件上
      return { blob: PNG('focus2'), width: 800, height: 600 };
    });

    m.fab.click();
    m.captureBtn.focus();
    m.captureBtn.click();
    await tick();

    expect(m.root.activeElement).toBe(closeBtn);
  });

  it('提交期间禁止截图与移除：按钮禁用，程序化触发也不生效', async () => {
    const m = mount();
    const provider = vi.fn(async (): Promise<Shot> => ({ blob: PNG('shot!'), width: 800, height: 600 }));
    m.widget.captureProvider = provider;
    m.fab.click();
    m.captureBtn.click();
    await tick();
    completeLogin(m);
    setTextarea(m, '提交中的反馈');

    // 提交挂起：fetch 永不自动 resolve（用对象承载 release，避免 TS 把变量收窄成 never）
    const pending: { release: (() => void) | null } = { release: null };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            pending.release = () =>
              resolve(httpResponse(201, { feedbackId: 'fb-s3', status: 'received' }));
          }),
      ),
    );
    m.submitBtn.click();
    await tick();

    expect(m.retakeBtn.disabled).toBe(true);
    expect(m.removeBtn.disabled).toBe(true);
    expect(m.captureBtn.disabled).toBe(true);

    forceClick(m.retakeBtn);
    forceClick(m.removeBtn);
    forceClick(m.captureBtn);
    expect(provider).toHaveBeenCalledTimes(1); // 提交中的截图不被替换
    expect(shown(m.screenshotWrap)).toBe(true); // 也不被移除

    expect(pending.release).not.toBeNull();
    pending.release?.();
    await tick();
  });

  it('轮询期间截图入口同样禁用（禁用态与 polling 同帧，守卫拦下程序化触发）', async () => {
    const m = mount();
    const provider = vi.fn(
      async (): Promise<Shot> => ({ blob: PNG('shot!'), width: 800, height: 600 }),
    );
    m.widget.captureProvider = provider;
    m.fab.click();
    m.captureBtn.click();
    await tick();
    completeLogin(m);
    setTextarea(m, '提交后的反馈');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => httpResponse(201, { feedbackId: 'fb-poll', status: 'received' })),
    );
    m.submitBtn.click();
    await tick(30); // 201 → 进入轮询（phase=tracking, polling=true）

    expect(m.captureBtn.disabled).toBe(true);
    expect(m.removeBtn.disabled).toBe(true);

    forceClick(m.captureBtn);
    forceClick(m.removeBtn);
    expect(provider).toHaveBeenCalledTimes(1); // 轮询期间不发起新截图
    expect(m.screenshotWrap.hidden).toBe(true); // 已随草稿清空

    m.widget.close();
    await tick();
  });
});
