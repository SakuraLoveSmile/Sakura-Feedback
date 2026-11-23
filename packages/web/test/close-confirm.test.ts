/**
 * 关闭前确认：0.14.0 起「关闭面板 = 放弃本次未提交的反馈」，
 * 所以用户主动关闭入口（关闭按钮 / Esc / 返回键）在有亲手内容时先确认，
 * 避免误触丢内容；宿主 widget.close() 与内部流程保持立即关闭、不弹窗。
 *
 * 触发条件只看用户亲手写/加的内容：正文去空白非空、手动图片（origin≠capture，
 * 含编辑过的截图）、手动日志（source=manual）。自动截图与自动采集日志不算。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/index';
import { cleanup, mount, setTextarea, type Mounted } from './helpers';
import { FakeCanvas, blobToPng, createState, encodePng, stubCreateElementCanvas } from './pixel-fixture';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick(5);
}

const PNG = (tag: string) => new Blob([tag], { type: 'image/png' });

/** 真实 PNG 字节（解码桩需要可解析的 IHDR 才能给出尺寸）。 */
function pngFile(name = 'a.png'): File {
  const px = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < px.length; i++) px[i] = [10, 120, 220, 255][i % 4]!;
  return new File([encodePng(4, 4, px)], name, { type: 'image/png' });
}

/** 跨 shadow 边界的键盘事件（真实浏览器 keydown 的 composed=true）。 */
function key(target: EventTarget, k: string, shiftKey = false): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true, composed: true });
  target.dispatchEvent(ev);
  return ev;
}

function confirmEl(m: Mounted): HTMLDivElement {
  return m.root.querySelector<HTMLDivElement>('.fb-close-confirm')!;
}

function panelCloseBtn(m: Mounted): HTMLButtonElement {
  return m.panel.querySelector<HTMLButtonElement>('.fb-close') as HTMLButtonElement;
}

function dlgBtn(m: Mounted, kind: 'cancel' | 'discard'): HTMLButtonElement {
  return m.root.querySelector<HTMLButtonElement>(`.fb-close-confirm-${kind}`)!;
}

/** 元素是否真的可见：自身 hidden 或落在 hidden 祖先里都算不可见。 */
function shown(el: HTMLElement): boolean {
  return !el.hidden && el.closest('[hidden]') === null;
}

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => `blob:mock-${(b as Blob).size ?? 0}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  stubCreateElementCanvas(createState());
  // 截图字节在 happy-dom 里不是可解码 PNG：解码桩退化为 4x4 画布（编辑流程够用）
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    const png = await blobToPng(blob).catch(() => null);
    const c = new FakeCanvas(createState());
    c.width = png?.width ?? 4;
    c.height = png?.height ?? 4;
    if (png) c.data.set(png.data);
    return c;
  });
});

afterEach(cleanup);

describe('关闭前确认：有正文时点关闭按钮', () => {
  it('弹出「放弃这次反馈？」确认层；选「继续编辑」留在面板且正文仍在（不丢弃）', () => {
    const m = mount();
    m.fab.click();
    setTextarea(m, '写了一半的反馈');

    panelCloseBtn(m).click();

    const dlg = confirmEl(m);
    expect(dlg.hidden).toBe(false);
    // 语义：模态对话框 + 标题/正文关联（读屏先读标题与丢弃后果）
    expect(dlg.getAttribute('role')).toBe('dialog');
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    const titleId = dlg.getAttribute('aria-labelledby')!;
    const textId = dlg.getAttribute('aria-describedby')!;
    expect(m.root.querySelector(`#${titleId}`)?.textContent).toBe('放弃这次反馈？');
    expect(m.root.querySelector(`#${textId}`)?.textContent).toBe(
      '关闭后，已写的文字、手加图片和日志会被丢弃，下次打开是新的反馈。',
    );
    expect(dlgBtn(m, 'cancel').textContent).toBe('继续编辑');
    expect(dlgBtn(m, 'discard').textContent).toBe('放弃');
    // 初始焦点在「继续编辑」：误触 Enter 只会回到编辑，不会丢内容
    expect(m.root.activeElement).toBe(dlgBtn(m, 'cancel'));
    expect(m.panel.classList.contains('is-open')).toBe(true);

    dlgBtn(m, 'cancel').click();

    expect(confirmEl(m).hidden).toBe(true);
    expect(m.panel.classList.contains('is-open')).toBe(true);
    expect(m.widget.isOpen).toBe(true);
    expect(m.textarea.value).toBe('写了一半的反馈');
    // 焦点还给打开确认层前的控件（正文输入框）
    expect(m.root.activeElement).toBe(m.textarea);
  });

  it('确认「放弃」后关闭面板；重开后正文/截图/日志都是空的（0.14.0 语义）', async () => {
    const m = mount();
    m.widget.captureProvider = vi.fn(async () => ({ blob: PNG('shot'), width: 800, height: 600 }));
    m.fab.click();
    m.captureBtn.click();
    await tick();
    const logInput = m.root.querySelector<HTMLInputElement>('.fb-log-input')!;
    Object.defineProperty(logInput, 'files', {
      value: [new File(['line 1'], 'manual.log', { type: 'text/plain' })],
      configurable: true,
    });
    logInput.dispatchEvent(new Event('change'));
    await settle();
    setTextarea(m, '要放弃的正文');
    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(1);
    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(1);

    panelCloseBtn(m).click();
    expect(confirmEl(m).hidden).toBe(false);
    dlgBtn(m, 'discard').click();

    expect(m.widget.isOpen).toBe(false);
    expect(m.panel.classList.contains('is-open')).toBe(false);

    m.widget.open();
    await settle();
    expect(m.textarea.value).toBe('');
    // 图片区回到空白：整块隐藏、缩略图没有 src（静态单元格仍在 DOM 里）
    expect(shown(m.screenshotWrap)).toBe(false);
    expect(m.screenshotThumb.getAttribute('src')).toBeNull();
    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(0);
  });
});

describe('关闭前确认：什么算用户内容', () => {
  it('只有自动截图（无正文、无手加图片/日志）时关闭不弹窗', async () => {
    const m = mount();
    m.widget.captureProvider = vi.fn(async () => ({ blob: PNG('auto'), width: 800, height: 600 }));
    await m.widget.captureAndOpen();
    await tick();
    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(1);

    panelCloseBtn(m).click();

    expect(confirmEl(m).hidden).toBe(true);
    expect(m.panel.classList.contains('is-open')).toBe(false);
  });

  it('自动采集的日志（source=auto）不弹窗；手动添加的日志才弹窗', async () => {
    // 自动采集：打开面板时 logProvider 自动附加，来源是「自动」
    const auto = mount();
    auto.widget.logProvider = async () => [
      { filename: 'auto.log', blob: new Blob(['auto line'], { type: 'text/plain' }) },
    ];
    auto.widget.open();
    await settle();
    expect(auto.root.querySelectorAll('.fb-log-item').length).toBe(1);
    expect(auto.root.querySelector('.fb-log-badge')?.textContent).toBe('自动');
    panelCloseBtn(auto).click();
    expect(confirmEl(auto).hidden).toBe(true);
    expect(auto.panel.classList.contains('is-open')).toBe(false);

    // 手动添加：用户亲手选的文件，属于会被丢弃的内容
    const manual = mount();
    manual.fab.click();
    const logInput = manual.root.querySelector<HTMLInputElement>('.fb-log-input')!;
    Object.defineProperty(logInput, 'files', {
      value: [new File(['manual line'], 'mine.log', { type: 'text/plain' })],
      configurable: true,
    });
    logInput.dispatchEvent(new Event('change'));
    await settle();
    expect(manual.root.querySelector('.fb-log-badge')?.textContent).toBe('手动');
    panelCloseBtn(manual).click();
    expect(confirmEl(manual).hidden).toBe(false);
    dlgBtn(manual, 'cancel').click();
    expect(manual.panel.classList.contains('is-open')).toBe(true);
    expect(manual.root.querySelectorAll('.fb-log-item').length).toBe(1);
  });

  it('手动添加的图片触发确认；点遮罩取消后图片仍在', async () => {
    const m = mount();
    m.widget.open();
    const input = m.root.querySelector<HTMLInputElement>('.fb-image-input')!;
    Object.defineProperty(input, 'files', { value: [pngFile('mine.png')], configurable: true });
    input.dispatchEvent(new Event('change'));
    await settle();
    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(1);

    panelCloseBtn(m).click();
    expect(confirmEl(m).hidden).toBe(false);

    // 点遮罩 = 取消（留在面板，内容原样保留）
    confirmEl(m).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(confirmEl(m).hidden).toBe(true);
    expect(m.panel.classList.contains('is-open')).toBe(true);
    await settle();
    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(1);
  });

  it('编辑过的截图（origin 仍是 capture）也算用户内容', async () => {
    const m = mount();
    m.widget.captureProvider = vi.fn(async () => ({ blob: PNG('auto'), width: 800, height: 600 }));
    await m.widget.captureAndOpen();
    await tick();

    m.root.querySelector<HTMLButtonElement>('.fb-thumb-edit')!.click();
    await settle();
    expect(m.root.querySelector('.fb-editor')).not.toBeNull();
    m.root.querySelector<HTMLButtonElement>('.fb-editor-btn.is-primary')!.click();
    await settle();
    expect(m.root.querySelector('.fb-screenshot-badge')?.textContent).toContain('已编辑');

    panelCloseBtn(m).click();
    expect(confirmEl(m).hidden).toBe(false);
  });
});

describe('关闭前确认：程序化关闭与键盘', () => {
  it('宿主 widget.close() 有内容也立即关闭、不弹确认', () => {
    const m = mount();
    m.fab.click();
    setTextarea(m, '宿主主动关闭时的正文');

    m.widget.close();

    expect(confirmEl(m).hidden).toBe(true);
    expect(m.widget.isOpen).toBe(false);
    expect(m.panel.classList.contains('is-open')).toBe(false);
  });

  it('Esc 触发同一确认；对话框内 Esc 只取消（不关面板），再确认才关闭', () => {
    const m = mount();
    m.fab.click();
    setTextarea(m, 'Esc 场景的正文');

    const ev = key(m.textarea, 'Escape');
    expect(ev.defaultPrevented).toBe(true);
    expect(confirmEl(m).hidden).toBe(false);
    expect(m.panel.classList.contains('is-open')).toBe(true);

    // 对话框内 Esc = 回到编辑（不关闭面板、不丢弃内容）
    key(dlgBtn(m, 'cancel'), 'Escape');
    expect(confirmEl(m).hidden).toBe(true);
    expect(m.panel.classList.contains('is-open')).toBe(true);
    expect(m.textarea.value).toBe('Esc 场景的正文');

    // 再次 Esc：重新确认；「放弃」才真正关闭
    key(m.textarea, 'Escape');
    expect(confirmEl(m).hidden).toBe(false);
    dlgBtn(m, 'discard').click();
    expect(m.widget.isOpen).toBe(false);
  });

  it('Tab 在对话框内循环、Enter 触发当前聚焦按钮', () => {
    const m = mount();
    m.fab.click();
    setTextarea(m, '键盘导航');
    panelCloseBtn(m).click();
    expect(m.root.activeElement).toBe(dlgBtn(m, 'cancel'));

    // Tab：继续编辑 → 放弃 → 继续编辑；Shift+Tab 反向
    key(dlgBtn(m, 'cancel'), 'Tab');
    expect(m.root.activeElement).toBe(dlgBtn(m, 'discard'));
    key(dlgBtn(m, 'discard'), 'Tab');
    expect(m.root.activeElement).toBe(dlgBtn(m, 'cancel'));
    key(dlgBtn(m, 'cancel'), 'Tab', true);
    expect(m.root.activeElement).toBe(dlgBtn(m, 'discard'));

    // Enter 触发当前焦点按钮：焦点在「继续编辑」时只回到编辑
    dlgBtn(m, 'cancel').focus();
    key(dlgBtn(m, 'cancel'), 'Enter');
    expect(confirmEl(m).hidden).toBe(true);
    expect(m.panel.classList.contains('is-open')).toBe(true);
    expect(m.textarea.value).toBe('键盘导航');

    // 再次打开，焦点移到「放弃」后 Enter 才关闭并丢弃
    panelCloseBtn(m).click();
    key(dlgBtn(m, 'cancel'), 'Tab');
    expect(m.root.activeElement).toBe(dlgBtn(m, 'discard'));
    key(dlgBtn(m, 'discard'), 'Enter');
    expect(m.widget.isOpen).toBe(false);
  });
});
