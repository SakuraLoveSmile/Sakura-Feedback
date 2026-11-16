/**
 * 宿主未接入 logProvider 时的可见提示与一次性 console 提示（T5）。
 *
 * 缺口：`logProvider` 未接入时，「重新采集」按钮会因 `recollectLogBtn.hidden =
 * !this._logProvider` 静默消失，用户与接入者都看不出「这台宿主根本没接自动采集」。
 * Flutter 面板早已有 `Key('feedback-logs-no-provider')` 的说明文本，Web 侧缺失。
 *
 * 本次行为：
 *  1. 展开的日志区出现固定说明 `.fb-logs-no-provider`，接入 provider 后隐藏；
 *  2. 每次面板打开若仍无 provider，则向宿主 console 提示**一次**（同一实例不重复刷屏）；
 *  3. 提示只说明事实：手动添加日志、提交反馈均不受影响。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import '../src/index';
import {
  cleanup,
  completeLogin,
  httpResponse,
  mount,
  recordFetch,
  setTextarea,
  type Mounted,
} from './helpers';

afterEach(cleanup);

async function settled(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** 元素是否真的可见：自身 hidden 或落在 hidden 祖先里都算不可见。 */
function shown(el: HTMLElement): boolean {
  return !el.hidden && el.closest('[hidden]') === null;
}

/** 展开 / 收起诊断日志区（默认折叠，展开后才看得到提示）。 */
function toggleLogs(m: Mounted): void {
  m.root.querySelector<HTMLButtonElement>('.fb-logs-toggle')?.click();
}

function noProviderHint(m: Mounted): HTMLParagraphElement {
  const hint = m.root.querySelector<HTMLParagraphElement>('.fb-logs-no-provider');
  if (!hint) throw new Error('未渲染 .fb-logs-no-provider');
  return hint;
}

describe('日志采集未接入提示（T5）', () => {
  it('未接入 logProvider：打开面板给出一次 console 提示，重复打开与 syncUi 不再提示', async () => {
    const m = mount();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    m.fab.click();
    await settled();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('logProvider');

    // 重复打开（关闭 → 再呼出）不重复提示
    m.widget.close();
    m.fab.click();
    await settled();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // 组件自身的 UI 同步（输入、展开日志区等）也不重复提示
    setTextarea(m, '输入触发 syncUi');
    toggleLogs(m);
    await settled();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // 显式再调 open()（已打开状态下的幂等调用）同样不提示
    m.widget.open();
    await settled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(m.panel.classList.contains('is-open')).toBe(true);
  });

  it('未接入 logProvider：展开日志区后提示可见，折叠时随日志区一起收起', async () => {
    const m = mount();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    m.fab.click();
    await settled();

    const hint = noProviderHint(m);
    expect(hint.hidden).toBe(false); // 折叠态下自身不 hidden，由父级日志区隐藏
    expect(shown(hint)).toBe(false);
    expect(hint.textContent).toContain('可手动添加日志文件');
    expect(hint.textContent).toContain('logProvider');

    toggleLogs(m);
    expect(m.root.querySelector<HTMLDivElement>('.fb-logs-body')?.hidden).toBe(false);
    expect(shown(hint)).toBe(true);

    toggleLogs(m);
    expect(m.root.querySelector<HTMLDivElement>('.fb-logs-body')?.hidden).toBe(true);
    expect(shown(hint)).toBe(false);
    warnSpy.mockRestore();
  });

  it('未接入 logProvider：手动添加日志与提交均不受影响', async () => {
    const m = mount();
    const { calls } = recordFetch(async () => httpResponse(201, { feedbackId: 'fb-t5-1', status: 'received' }));
    await completeLogin(m);

    m.fab.click();
    await settled();

    const hint = noProviderHint(m);
    expect(hint.hidden).toBe(false);
    expect(m.root.querySelector<HTMLButtonElement>('.fb-log-recollect')?.hidden).toBe(true);

    // 手动添加日志：绕过 provider，走文件选择
    const input = m.root.querySelector<HTMLInputElement>('.fb-log-input')!;
    Object.defineProperty(input, 'files', {
      value: [new File(['manual line'], 'manual.log', { type: 'text/plain' })],
      configurable: true,
    });
    input.dispatchEvent(new Event('change'));
    await settled();

    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(1);
    expect(m.root.querySelector('.fb-log-name')?.textContent).toBe('manual.log');
    expect(m.root.querySelector('.fb-log-badge')?.textContent).toBe('手动');
    expect(m.root.querySelector('.fb-logs-count')?.textContent).toBe(' (1/3)');
    expect(hint.hidden).toBe(false); // 手动添加不改变「未接入」的事实

    // 提交照常发出，且带上手动日志
    setTextarea(m, '未接入采集也能提交');
    m.submitBtn.click();
    await settled();

    expect(calls.length).toBe(1);
    expect(calls[0]?.body?.text).toBe('未接入采集也能提交');
    const raw = calls[0]?.rawBody as FormData | undefined;
    expect(Array.from(raw?.keys() ?? [])).toContain('logs');
  });

  it('接入 logProvider：提示隐藏、不产生 console 提示，自动采集照常工作', async () => {
    const m = mount();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.widget.logProvider = async () => [
      { filename: 'app.log', blob: new Blob(['auto line'], { type: 'text/plain' }) },
    ];

    m.fab.click();
    await settled(10);

    expect(warnSpy).not.toHaveBeenCalled();
    const hint = noProviderHint(m);
    expect(hint.hidden).toBe(true);
    expect(shown(hint)).toBe(false);

    toggleLogs(m);
    expect(shown(hint)).toBe(false); // 展开也不会露出「未接入」说明
    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(1);
    expect(m.root.querySelector('.fb-log-badge')?.textContent).toBe('自动');
    expect(m.root.querySelector<HTMLButtonElement>('.fb-log-recollect')?.hidden).toBe(false);
    warnSpy.mockRestore();
  });

  it('挂载后才接入 logProvider：下一次 UI 同步即隐藏提示，且不再提示', async () => {
    const m = mount();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    m.fab.click(); // 首次打开：无 provider，提示一次
    await settled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(noProviderHint(m).hidden).toBe(false);

    m.widget.logProvider = async () => []; // 迟到的接入
    toggleLogs(m); // 展开日志区会走 syncLogsUi
    await settled();

    expect(noProviderHint(m).hidden).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // 关闭再打开：provider 已接入，不重新提示
    m.widget.close();
    m.fab.click();
    await settled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(noProviderHint(m).hidden).toBe(true);
  });
});
