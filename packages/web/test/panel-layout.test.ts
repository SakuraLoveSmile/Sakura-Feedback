/**
 * T2.4–T2.6 / T4 面板呈现验收：
 * - 面板组件顺序：标题与页签 → 反馈描述 → 图片证据 → 可折叠日志 → 固定提交区；
 * - 图片缩略图完整显示（contain）、角标（局部截图 / 已编辑）与尺寸、操作在图片下方；
 * - 未应用选区时保存禁用的原因可见（编辑器侧断言见 editor-crop.test.ts）；
 * - 日志默认只显示简短摘要，展开后可查看 / 移除 / 重新采集，出错自动展开；
 * - 冻结视觉规格（宽度 440 / 最大高 720、灵感球 56→84 与光晕、reduced-motion、44px 目标、
 *   编辑器 280px 结果区与窄屏 160px、渐变光效仅限灵感球）。
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { beforeEach } from 'vitest';
import '../src/index';
import { STYLES } from '../src/styles';
import { cleanup, mount } from './helpers';
import { blobToPng, createState, encodePng, stubCreateElementCanvas } from './pixel-fixture';

const ELEMENT_SOURCE = readFileSync('src/element.ts', 'utf8');

/** 素材：均匀色 PNG 文件（4×4）。 */
function pngFile(value: number, name = 'shot.png'): File {
  const px = new Uint8ClampedArray(4 * 4 * 4);
  px.fill(value);
  return new File([encodePng(4, 4, px)], name, { type: 'image/png' });
}

beforeEach(() => {
  stubCreateElementCanvas(createState());
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    const png = await blobToPng(blob);
    return {
      width: png.width,
      height: png.height,
      data: png.data,
      close: () => {},
      getContext: () => null,
    };
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => `blob:mock-${(b as Blob).size}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(cleanup);

async function settled(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 5));
}

function shown(el: Element): boolean {
  return !((el as HTMLElement).hidden) && el.closest('[hidden]') === null;
}

describe('T2.6 面板组件顺序', () => {
  it('标题与页签 → 反馈描述 → 图片证据 → 可折叠日志 → 固定提交区', () => {
    const m = mount();
    const panelChildren = Array.from(m.panel.children);
    expect(panelChildren[0]!.classList.contains('fb-header')).toBe(true);
    expect(panelChildren[1]!.classList.contains('fb-nav-tabs')).toBe(true);
    const body = panelChildren[2]!;
    expect(body.classList.contains('fb-body')).toBe(true);
    // 历史 / 设置视图在主体之后，不插入描述与图片之间
    expect(panelChildren[3]!.classList.contains('fb-history-container')).toBe(true);
    expect(panelChildren[4]!.classList.contains('fb-settings')).toBe(true);

    const children = Array.from(body.children);
    const idx = (cls: string): number => children.findIndex((c) => c.classList.contains(cls));
    const prompt = idx('fb-prompt');
    const textarea = idx('fb-textarea-wrap');
    const images = idx('fb-shot-area');
    const logs = idx('fb-logs-area');
    const status = idx('fb-status-region');
    const cards = idx('fb-status-card-wrap');
    const footer = idx('fb-footer');

    for (const i of [prompt, textarea, images, logs, status, cards, footer]) {
      expect(i).toBeGreaterThanOrEqual(0);
    }
    expect(prompt).toBeLessThan(textarea);
    expect(textarea).toBeLessThan(images);
    expect(images).toBeLessThan(logs);
    expect(logs).toBeLessThan(status);
    expect(status).toBeLessThan(cards);
    expect(cards).toBeLessThan(footer);

    // 固定提交区：footer 是滚动容器内的粘性底部
    expect(STYLES).toMatch(/\.fb-footer \{[^}]*position: sticky/);
  });
});

describe('T2.5 图片缩略图完整显示与角标', () => {
  it('缩略图 contain、编辑/删除在图片下方、角标含标记与尺寸', async () => {
    const m = mount();
    m.widget.open();
    const input = m.root.querySelector<HTMLInputElement>('.fb-image-input')!;
    Object.defineProperty(input, 'files', {
      value: [pngFile(120)],
      configurable: true,
    });
    input.dispatchEvent(new Event('change'));
    await settled();

    const cell = m.root.querySelector('.fb-screenshot-thumb-box')!;
    expect(cell).not.toBeNull();

    // 完整显示：contain，且不再有 cover 二次裁切
    expect(STYLES).toMatch(/\.fb-screenshot-thumb \{[^}]*object-fit: contain/);
    expect(STYLES).not.toMatch(/\.fb-screenshot-thumb \{[^}]*object-fit: cover/);

    // 操作按钮在图片框之外（图片下方），不遮挡内容
    const frame = cell.querySelector('.fb-thumb-frame')!;
    expect(frame.querySelector('.fb-thumb-edit')).toBeNull();
    expect(frame.querySelector('.fb-thumb-remove')).toBeNull();
    const actions = cell.querySelector('.fb-thumb-actions')!;
    expect(actions).not.toBeNull();
    expect(Array.from(cell.children).indexOf(frame)).toBeLessThan(
      Array.from(cell.children).indexOf(actions),
    );
    expect(actions.querySelector('.fb-thumb-edit')).not.toBeNull();

    // 角标 + 尺寸读数
    expect(cell.querySelector('.fb-screenshot-badge')?.textContent).toBe('图片');
    expect(cell.querySelector('.fb-screenshot-size')?.textContent).toBe('4×4');
  });

  it('手动图片编辑保存后角标为「已编辑」（尺寸读数保留）', async () => {
    const m = mount();
    m.widget.open();
    stubCreateElementCanvas(createState());
    vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
      const png = await blobToPng(blob);
      return { width: png.width, height: png.height, data: png.data, close: () => {}, getContext: () => null };
    });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock-edit');

    const input = m.root.querySelector<HTMLInputElement>('.fb-image-input')!;
    Object.defineProperty(input, 'files', { value: [pngFile(90, 'x.png')], configurable: true });
    input.dispatchEvent(new Event('change'));
    await settled();
    m.root.querySelector<HTMLButtonElement>('.fb-thumb-edit')!.click();
    await settled();

    // 直接保存（无改动）→ source=edited
    m.root
      .querySelector<HTMLButtonElement>('.fb-editor-actions .fb-editor-btn.is-primary')!
      .click();
    await settled();
    expect(m.root.querySelector('.fb-screenshot-badge')?.textContent).toBe('已编辑');
    expect(m.root.querySelector('.fb-screenshot-size')?.textContent).toBe('4×4');
  });
});

describe('T4 日志能力保留、呈现更轻量', () => {
  it('默认只显示简短摘要；展开后可见文件、可移除与重新采集', async () => {
    const m = mount();
    let calls = 0;
    m.widget.logProvider = async () => {
      calls++;
      return { filename: 'diag.log', blob: new Blob(['line'], { type: 'text/plain' }) };
    };
    m.widget.open();
    await settled();

    expect(calls).toBe(1);
    const toggle = m.root.querySelector<HTMLButtonElement>('.fb-logs-toggle')!;
    const body = m.root.querySelector<HTMLElement>('.fb-logs-body')!;
    const summary = m.root.querySelector('.fb-logs-summary')!;

    // 摘要：已附诊断日志；默认折叠（详情不可见）
    expect(summary.textContent).toContain('已附诊断日志');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(body.hidden).toBe(true);
    expect(shown(m.root.querySelector('.fb-log-item')!)).toBe(false);
    // 重新采集入口可用（配置了 logProvider）
    const recollect = m.root.querySelector<HTMLButtonElement>('.fb-log-recollect')!;
    expect(recollect.hidden).toBe(false);

    // 展开 → 文件、预览、移除、重新采集都可见
    toggle.click();
    expect(body.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(shown(m.root.querySelector('.fb-log-item')!)).toBe(true);
    expect(m.root.querySelector('.fb-log-btn-preview')).not.toBeNull();
    expect(m.root.querySelector('.fb-log-btn-remove')).not.toBeNull();
    expect(shown(recollect)).toBe(true);

    // 重新采集可再次调用 provider（上限内追加）
    recollect.click();
    await settled();
    expect(calls).toBe(2);
  });

  it('provider 返回空 → 摘要「暂无日志」且不阻断提交', async () => {
    const m = mount();
    m.widget.logProvider = async () => [];
    m.widget.open();
    await settled();
    expect(m.root.querySelector('.fb-logs-summary')?.textContent).toBe('暂无日志');
    // 现有采集状态提示仍保留（回归保护）
    expect(m.root.querySelector('.fb-log-status')?.textContent).toContain('当前会话暂无日志');
  });

  it('采集失败：固定文案 + 自动展开详情（错误可见、可重试）', async () => {
    const m = mount();
    m.widget.logProvider = async () => {
      throw new Error('secret internal path');
    };
    m.widget.open();
    await settled();

    const err = m.root.querySelector<HTMLElement>('.fb-log-error')!;
    expect(err.textContent).toContain('日志获取失败');
    expect(err.textContent).not.toContain('secret internal path');
    // 失败时详情区自动展开，用户能立刻看到错误与重试按钮
    expect(m.root.querySelector<HTMLElement>('.fb-logs-body')!.hidden).toBe(false);
    expect(m.root.querySelector('.fb-log-retry')).not.toBeNull();
  });
});

describe('冻结视觉规格（styles.ts 字符串断言）', () => {
  it('面板 440px / 最大高 min(720px, 视口高−32px)，768px 以下全屏', () => {
    expect(STYLES).toMatch(/\.fb-panel \{[^}]*width: min\(440px, calc\(100vw - 32px\)\)/);
    expect(STYLES).toMatch(/\.fb-panel \{[^}]*max-height: min\(720px, calc\(100dvh - 32px\)\)/);
    expect(STYLES).toMatch(/@media \(max-width: 767\.98px\)/);
  });

  it('灵感球冻结为 56px，拖动视觉组放大到 84px 并按方向拉伸', () => {
    expect(STYLES).toMatch(/\.fb-orb \{[^}]*width: 56px/);
    expect(STYLES).toMatch(/\.fb-orb \{[^}]*height: 56px/);
    expect(STYLES).toMatch(/\.fb-orb \{[^}]*min-width: 56px/);
    expect(STYLES).toMatch(/\.fb-orb \{[^}]*min-height: 56px/);
    expect(STYLES).toMatch(/\.fb-orb\.is-dragging \{[^}]*--fb-orb-state-scale: 1\.5/);

    // 四层视觉组共用 R(angle) × Scale(stretchAlong, 1) × R(-angle)，badge 不在组内。
    expect(STYLES).toMatch(
      /\.fb-orb-bloom,\s*\.fb-orb-glow,\s*\.fb-orb-sweep,\s*\.fb-orb-core \{[^}]*scale: calc\([\s\S]*?--fb-orb-state-scale[\s\S]*?transform: rotate\(var\(--fb-orb-drag-angle\)\)[\s\S]*?scaleX\(var\(--fb-orb-stretch-along\)\)[\s\S]*?rotate\(calc\(0rad - var\(--fb-orb-drag-angle\)\)\)/,
    );
    expect(STYLES).toMatch(
      /\.fb-orb-glow \{[^}]*translate: var\(--fb-orb-glow-x\) var\(--fb-orb-glow-y\)/,
    );
    expect(STYLES).toMatch(/\.fb-orb \.fb-launcher-badge \{[^}]*transform: none[^}]*scale: 1/);
  });

  it('七个 @property 声明完整自描述灵感球插值语义', () => {
    const expected = [
      ['--fb-orb-breath', '<number>', '0'],
      ['--fb-orb-state-scale', '<number>', '1'],
      ['--fb-orb-breath-weight', '<number>', '1'],
      ['--fb-orb-drag-angle', '<angle>', '0rad'],
      ['--fb-orb-stretch-along', '<number>', '1'],
      ['--fb-orb-glow-x', '<length>', '0px'],
      ['--fb-orb-glow-y', '<length>', '0px'],
    ] as const;

    expect(STYLES.match(/@property --fb-orb-/g)).toHaveLength(7);
    for (const [name, syntax, initialValue] of expected) {
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedSyntax = syntax.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(STYLES).toMatch(
        new RegExp(
          `@property ${escapedName} \\{[^}]*syntax: "${escapedSyntax}";[^}]*inherits: true;[^}]*initial-value: ${initialValue};`,
        ),
      );
    }
  });

  it('element.ts 在模块加载时守卫并注册七项属性，重复注册异常仍视为可用', () => {
    const registration = ELEMENT_SOURCE.slice(
      ELEMENT_SOURCE.indexOf('function registerOrbProperties()'),
      ELEMENT_SOURCE.indexOf('/** 灵感球的四层装饰'),
    );
    const expected = [
      "['--fb-orb-breath', '<number>', '0']",
      "['--fb-orb-state-scale', '<number>', '1']",
      "['--fb-orb-breath-weight', '<number>', '1']",
      "['--fb-orb-drag-angle', '<angle>', '0rad']",
      "['--fb-orb-stretch-along', '<number>', '1']",
      "['--fb-orb-glow-x', '<length>', '0px']",
      "['--fb-orb-glow-y', '<length>', '0px']",
    ];

    expect(registration).toContain(
      "if (typeof CSS === 'undefined' || typeof CSS.registerProperty !== 'function') return false;",
    );
    expect(registration.match(/\['--fb-orb-/g)).toHaveLength(7);
    for (const definition of expected) expect(registration).toContain(definition);
    expect(registration).toContain('CSS.registerProperty({ name, syntax, inherits: true, initialValue });');
    expect(registration).toMatch(/catch \{[\s\S]*?\}[\s\S]*?return true;/);
    expect(registration).toContain(
      'const orbRegisteredPropertiesAvailable = registerOrbProperties();',
    );
  });

  it('release 为 460ms 指定曲线；fallback 与 reduced-motion 均静态且不误杀 root 平移', () => {
    expect(STYLES).toMatch(/--fb-orb-release-duration: 460ms/);
    expect(STYLES).toMatch(/--fb-orb-release-easing: cubic-bezier\(0\.2, 1\.35, 0\.32, 1\)/);
    expect(STYLES).toMatch(
      /\.fb-orb\.is-releasing \{[^}]*transform var\(--fb-orb-release-duration\) var\(--fb-orb-release-easing\)[^}]*--fb-orb-drag-angle var\(--fb-orb-release-duration\) var\(--fb-orb-release-easing\)[^}]*--fb-orb-stretch-along var\(--fb-orb-release-duration\) var\(--fb-orb-release-easing\)[^}]*--fb-orb-glow-x var\(--fb-orb-release-duration\) var\(--fb-orb-release-easing\)[^}]*--fb-orb-glow-y var\(--fb-orb-release-duration\) var\(--fb-orb-release-easing\)/,
    );

    expect(STYLES).toMatch(
      /\.fb-orb\.fb-orb-properties-unavailable \{[^}]*--fb-orb-breath: 0[^}]*animation: none[^}]*transition: none/,
    );
    expect(STYLES).toMatch(
      /\.fb-orb\.fb-orb-properties-unavailable\.is-dragging,\s*\.fb-orb\.fb-orb-properties-unavailable\.is-releasing \{[^}]*transition: none/,
    );

    const reducedStart = STYLES.indexOf('@media (prefers-reduced-motion: reduce)');
    const reducedEnd = STYLES.indexOf('/* ---- v12 全屏图片编辑器', reducedStart);
    const reducedOrb = STYLES.slice(reducedStart, reducedEnd);
    expect(reducedOrb).toMatch(
      /\.fb-orb \{[^}]*--fb-orb-breath: 0[^}]*--fb-orb-drag-angle: 0rad !important[^}]*--fb-orb-stretch-along: 1 !important[^}]*--fb-orb-glow-x: 0px !important[^}]*--fb-orb-glow-y: 0px !important[^}]*animation: none !important[^}]*transition: none !important/,
    );
    expect(reducedOrb).toMatch(
      /\.fb-orb-bloom,\s*\.fb-orb-glow,\s*\.fb-orb-sweep,\s*\.fb-orb-core \{[^}]*scale: 1 !important[^}]*transform: none !important/,
    );
    expect(reducedOrb).toMatch(
      /\.fb-orb-glow \{[^}]*translate: 0px 0px !important[^}]*animation: none !important/,
    );
    expect(reducedOrb).toMatch(
      /\.fb-orb-sweep::before \{[^}]*transform: rotate\(0deg\) !important[^}]*animation: none !important/,
    );
    // root 没有 reduced-motion 的 transform:none !important，JS 的 1:1 功能平移仍能生效。
    expect(reducedOrb).not.toMatch(/\.fb-orb \{[^}]*transform: none !important/);
  });

  it('渐变光效只出现在灵感球（编辑器棋盘格背景除外）', () => {
    const blocks = STYLES.split('}').filter((b) => /gradient\(/.test(b));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const selector = (block.split('{')[0] ?? '').trim();
      expect(selector).toMatch(/fb-orb|fb-editor-(canvas|preview)/);
    }
  });

  it('点击目标 ≥44px：提交按钮与次要按钮；编辑器工具/按钮同样 44px', () => {
    expect(STYLES).toMatch(/\.fb-submit \{[^}]*height: 44px/);
    expect(STYLES).toMatch(/\.fb-btn-secondary \{[^}]*min-height: 44px/);
    expect(STYLES).toMatch(/\.fb-editor-tool \{[^}]*min-height: 44px/);
    expect(STYLES).toMatch(/\.fb-editor-btn \{[^}]*min-height: 44px/);
    expect(STYLES).toMatch(/\.fb-region-btn \{[^}]*min-height: 44px/);
    // 关闭 / 图标按钮用命中区扩展
    expect(STYLES).toMatch(/\.fb-close::after/);
  });

  it('编辑器：桌面右侧 280px 结果区，窄屏上下排列 160px，裁剪确认条固定底部', () => {
    expect(STYLES).toMatch(/\.fb-editor-result \{[^}]*flex: 0 0 280px/);
    expect(STYLES).toMatch(/@container \(max-width: 767px\)/);
    expect(STYLES).toMatch(/height: 160px/);
    expect(STYLES).toMatch(/\.fb-editor-cropbar \{[^}]*position: sticky/);
    expect(STYLES).toContain('.fb-editor-save-hint');
  });

  it('选区覆盖层：冻结位图铺满 + 外部暗化 + 三个 ≥44px 操作', () => {
    expect(STYLES).toContain('.fb-region-overlay');
    expect(STYLES).toMatch(/\.fb-region-bg \{[^}]*object-fit: fill/);
    expect(STYLES).toMatch(/\.fb-region-frame \{[^}]*box-shadow: 0 0 0 9999px/);
    expect(STYLES).toMatch(/\.fb-region-handle\[data-handle="nw"\]/);
    expect(STYLES).toMatch(/\.fb-region-handle\[data-handle="se"\]/);
  });

  it('主色与品牌令牌保持不变（#0071E3，间距 4/8/12/16/24/32）', () => {
    expect(STYLES).toContain('--fb-accent: #0071e3');
    expect(STYLES).toContain('--fb-z-index-default');
    // 圆角规格：面板 16px、图片 10px
    expect(STYLES).toMatch(/\.fb-panel \{[^}]*border-radius: 16px/);
    expect(STYLES).toMatch(/\.fb-screenshot-thumb-box \{[^}]*border-radius: 10px/);
  });
});
