/**
 * v13：项目色板（appId -> 稳定颜色）纯函数单元测试。
 *
 * 覆盖三件事：
 * 1. 确定性 —— 同输入同输出、与调用顺序无关（色板不能随渲染次数漂移）；
 * 2. 对比度 —— 先验证本文件的 WCAG 算子本身（金丝雀用例），再验证 10 个色值在
 *    浅色行背景 #f5f5f7 / 深色行背景 #2c2c2e、以及**分组头背景** #ffffff / #1c1c1e
 *    上都满足非文本元素 ≥3:1（色点/左边框），且 16% 叠加作 chip 背景后与主题令牌前景
 *    （#1d1d1f / #f5f5f7）仍 ≥4.5:1（11px 正文级文案）；
 * 3. 兜底 —— 空串 / 空白 / 非字符串 / 非法十六进制都不抛异常、不产出非法 CSS。
 */
import { describe, it, expect } from 'vitest';
import {
  NEUTRAL_PROJECT_COLOR,
  PROJECT_CHIP_ALPHA,
  PROJECT_PALETTE,
  hexToRgb,
  hashCode,
  normalizeAppId,
  projectChipBackground,
  projectColor,
  projectColorIndex,
  projectDisplayName,
  projectFallbackName,
  projectStyleVars,
  withAlpha,
} from '../src/project_color';

type Rgb = [number, number, number];

/** WCAG 相对亮度（与 src/project_color.ts 注释里的口径一致）。 */
function luminance(rgb: Rgb): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function contrast(a: Rgb, b: Rgb): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** alpha 叠加到背景上后的实际颜色（chip 背景就是这么算出来的）。 */
function over(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(fg[i]! * alpha + bg[i]! * (1 - alpha))) as Rgb;
}

const LIGHT_ROW = hexToRgb('#f5f5f7') as Rgb; // :host --fb-bg-subtle
const DARK_ROW = hexToRgb('#2c2c2e') as Rgb; // 深色主题 --fb-bg-subtle
const LIGHT_HEAD = hexToRgb('#ffffff') as Rgb; // :host --fb-bg（分组头背景）
const DARK_HEAD = hexToRgb('#1c1c1e') as Rgb; // 深色主题 --fb-bg（分组头背景）
const LIGHT_TEXT = hexToRgb('#1d1d1f') as Rgb; // :host --fb-text
const DARK_TEXT = hexToRgb('#f5f5f7') as Rgb; // 深色主题 --fb-text

function rgbDistance(a: Rgb, b: Rgb): number {
  return Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]!) ** 2, 0));
}

describe('项目色板：确定性与分布', () => {
  it('色板规模落在 8~12、全部为合法且互不重复的 #rrggbb', () => {
    expect(PROJECT_PALETTE.length).toBeGreaterThanOrEqual(8);
    expect(PROJECT_PALETTE.length).toBeLessThanOrEqual(12);
    for (const color of PROJECT_PALETTE) {
      expect(hexToRgb(color)).not.toBeNull();
    }
    expect(new Set(PROJECT_PALETTE).size).toBe(PROJECT_PALETTE.length);
  });

  it('同一 appId 多次调用得到同一颜色（纯函数，无随机/无时间）', () => {
    const first = projectColor('com.example.app');
    expect(projectColor('com.example.app')).toBe(first);
    expect(projectColor('com.example.app')).toBe(first);
    expect(hashCode('abc')).toBe(2319914504);
  });

  it('结果与调用顺序无关（先算 A 再算 B 不改变各自颜色）', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `com.acme.app${i}`);
    const forward = ids.map((id) => projectColor(id));
    const shuffled = [...ids].reverse().map((id) => projectColor(id));
    const reversed = new Map(ids.map((id, i) => [id, forward[i]]));
    for (const [i, id] of [...ids].reverse().entries()) {
      expect(shuffled[i]).toBe(reversed.get(id));
    }
  });

  it('金样：已知 appId 落在已知色值（改色板/哈希必然打破本用例，属有意约束）', () => {
    expect(projectColor('com.example.app')).toBe('#c14adf');
    expect(projectColor('com.other.app')).toBe('#728818');
    expect(projectColor('移动端App')).toBe('#407fdd');
    expect(projectColorIndex('com.example.app')).toBe(8);
  });

  it('相似 appId 与批量 appId 不塌缩到少数槽位', () => {
    const related = ['com.feedback.web', 'com.feedback.admin', 'com.feedback.widget'].map(
      (id) => projectColorIndex(id),
    );
    expect(new Set(related).size).toBe(3);

    const ids: string[] = [];
    for (const a of ['com', 'io', 'org']) {
      for (const b of ['x', 'y', 'z', 'w']) {
        for (const c of ['p', 'q', 'r', 's', 't']) ids.push(`${a}.${b}.${c}`);
      }
    }
    expect(new Set(ids.map((id) => projectColorIndex(id))).size).toBe(PROJECT_PALETTE.length);
  });

  it('任意两色的 RGB 距离 ≥40，命中同槽位之外的颜色肉眼可辨', () => {
    const rgbs = PROJECT_PALETTE.map((c) => hexToRgb(c) as Rgb);
    let min = Infinity;
    for (let i = 0; i < rgbs.length; i++) {
      for (let j = i + 1; j < rgbs.length; j++) {
        min = Math.min(min, rgbDistance(rgbs[i] as Rgb, rgbs[j] as Rgb));
      }
    }
    expect(min).toBeGreaterThanOrEqual(40);
  });
});

describe('项目色板：深浅两套主题对比度', () => {
  // 本文件所有对比度结论都建立在上面 luminance/contrast/over 三个函数上：
  // 函数写错的话断言会「全绿但结论是假的」。这里用 WCAG 已知值做金丝雀，
  // 系数写反（0.2126/0.7152/0.0722）、gamma 写成 2.2、或 (L+0.05) 漏加都会被抓住。
  it('对比度工具函数对齐 WCAG 已知值（本文件其余断言的前提）', () => {
    const BLACK = hexToRgb('#000000') as Rgb;
    const WHITE = hexToRgb('#ffffff') as Rgb;
    expect(luminance(WHITE)).toBeCloseTo(1, 6);
    expect(luminance(BLACK)).toBeCloseTo(0, 6);
    // 三通道系数逐一可验：纯色亮度就等于对应权重
    expect(luminance(hexToRgb('#ff0000') as Rgb)).toBeCloseTo(0.2126, 6);
    expect(luminance(hexToRgb('#00ff00') as Rgb)).toBeCloseTo(0.7152, 6);
    expect(luminance(hexToRgb('#0000ff') as Rgb)).toBeCloseTo(0.0722, 6);
    expect(contrast(BLACK, WHITE)).toBeCloseTo(21, 6);
    expect(contrast(WHITE, BLACK)).toBeCloseTo(21, 6); // 顺序无关
    expect(contrast(LIGHT_ROW, LIGHT_ROW)).toBeCloseTo(1, 6);
    // #767676 是白底上刚好过 AA(4.5) 的公认临界色，#777777 则刚好不过
    expect(contrast(hexToRgb('#767676') as Rgb, WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hexToRgb('#777777') as Rgb, WHITE)).toBeLessThan(4.5);
    // alpha 叠加的两个端点必须退化为纯色
    expect(over(hexToRgb('#df4c4c') as Rgb, WHITE, 1)).toEqual(hexToRgb('#df4c4c'));
    expect(over(hexToRgb('#df4c4c') as Rgb, WHITE, 0)).toEqual(WHITE);
  });

  it('每个色值作色点/左边框时，对浅色与深色行背景都 ≥3:1', () => {
    for (const color of [...PROJECT_PALETTE, NEUTRAL_PROJECT_COLOR]) {
      const rgb = hexToRgb(color) as Rgb;
      expect(contrast(rgb, LIGHT_ROW), `${color} 浅色`).toBeGreaterThanOrEqual(3);
      expect(contrast(rgb, DARK_ROW), `${color} 深色`).toBeGreaterThanOrEqual(3);
    }
  });

  // 色点除了落在行背景（--fb-bg-subtle）上，还落在**分组头背景**（--fb-bg）上；
  // 这两个令牌不是同一个值，只测前者等于把分组头的对比度留在断言之外。
  it('色点同样要对分组头背景 --fb-bg（#ffffff / #1c1c1e）满足 ≥3:1', () => {
    for (const color of [...PROJECT_PALETTE, NEUTRAL_PROJECT_COLOR]) {
      const rgb = hexToRgb(color) as Rgb;
      expect(contrast(rgb, LIGHT_HEAD), `${color} 浅色分组头`).toBeGreaterThanOrEqual(3);
      expect(contrast(rgb, DARK_HEAD), `${color} 深色分组头`).toBeGreaterThanOrEqual(3);
    }
    // 兜底中性灰是全场最紧的一对，写下具体下限防止日后调色板把它挪进不可辨区间
    expect(contrast(hexToRgb(NEUTRAL_PROJECT_COLOR) as Rgb, LIGHT_HEAD)).toBeGreaterThanOrEqual(3.4);
  });

  it('chip 背景只是同色低透明度叠加，前景取 --fb-text 时两套主题都 ≥4.5:1', () => {
    expect(PROJECT_CHIP_ALPHA).toBeLessThanOrEqual(0.2);
    for (const color of [...PROJECT_PALETTE, NEUTRAL_PROJECT_COLOR]) {
      const rgb = hexToRgb(color) as Rgb;
      expect(contrast(LIGHT_TEXT, over(rgb, LIGHT_ROW, PROJECT_CHIP_ALPHA)), `${color} 浅色 chip`)
        .toBeGreaterThanOrEqual(4.5);
      expect(contrast(DARK_TEXT, over(rgb, DARK_ROW, PROJECT_CHIP_ALPHA)), `${color} 深色 chip`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('项目色板：兜底与 CSS 串', () => {
  it('空/空白/非字符串 appId 一律走中性色，索引为 -1', () => {
    for (const bad of ['', '   ', '\t\n', null, undefined, 123, {}, []]) {
      expect(projectColorIndex(bad)).toBe(-1);
      expect(projectColor(bad)).toBe(NEUTRAL_PROJECT_COLOR);
      expect(normalizeAppId(bad)).toBe('');
    }
  });

  it('前后空白不影响取色（同项目同色）', () => {
    expect(projectColor('  com.example.app ')).toBe(projectColor('com.example.app'));
  });

  it('withAlpha/hexToRgb 对非法输入返回可安全写入 CSS 的值', () => {
    expect(withAlpha('#df4c4c', 0.16)).toBe('rgba(223, 76, 76, 0.16)');
    expect(withAlpha('#nope', 0.16)).toBe('transparent');
    expect(withAlpha('#df4c4c', 5)).toBe('rgba(223, 76, 76, 1)');
    expect(hexToRgb('#GGGGGG')).toBeNull();
    expect(hexToRgb('#fff')).toBeNull();
  });

  it('projectStyleVars 产出可写入 style 属性的两个自定义属性', () => {
    const vars = projectStyleVars('com.example.app');
    expect(vars).toBe('--fb-project-color:#c14adf;--fb-project-chip-bg:rgba(193, 74, 223, 0.16);');
    expect(vars.split(';')).toHaveLength(3); // 两项 + 结尾空段
    expect(projectChipBackground('')).toBe(withAlpha(NEUTRAL_PROJECT_COLOR, PROJECT_CHIP_ALPHA));
  });
});

describe('项目展示名回退', () => {
  it('appName 优先，null/空白回退 appId', () => {
    expect(projectDisplayName('我的应用', 'com.example.app')).toBe('我的应用');
    expect(projectDisplayName(null, 'com.example.app')).toBe('com.example.app');
    expect(projectDisplayName('   ', 'com.example.app')).toBe('com.example.app');
    expect(projectDisplayName(undefined, undefined)).toBe('未知项目');
  });

  it('超长 appId 先取反向域名末段，仍超长则截断加省略号', () => {
    expect(projectFallbackName('io.github.longorganization.projectname.console')).toBe('console');
    expect(projectFallbackName('a.b.c.veryveryverylongsegmentname-example')).toBe(
      'a.b.c.veryveryverylongs…',
    );
    expect(projectFallbackName('a'.repeat(40))).toBe(`${'a'.repeat(23)}…`);
    expect(projectFallbackName('')).toBe('未知项目');
  });
});
