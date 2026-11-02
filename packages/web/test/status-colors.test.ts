/**
 * v0.8.2「我的反馈」状态配色：四种 issueStatus 用四个独立令牌家族，
 * chip 与行左边框同源，深浅主题都有值，文字对**合成后**背景满足 WCAG AA（≥ 4.5:1）。
 *
 * 这里同时锁住三件事：
 * 1. 类名映射：`.fb-tag.{open,waiting-user,waiting-admin,resolved}` 与
 *    `.fb-issue-row.fb-issue--{open,waiting_user,waiting_admin,resolved}`；
 * 2. 令牌家族：open→warn（琥珀）、waiting_user→info（蓝）、waiting_admin→accent（紫）、
 *    resolved→success（绿）；resolved 不得再退回灰色（`--fb-text-secondary` 等）；
 * 3. 对比度：从 STYLES 解析八组（四状态 × 浅深）文字/背景值，按真实叠加方式合成背景后
 *    计算 WCAG 对比度，全部 ≥ 4.5:1。对话页状态徽标复用同一 `.fb-tag` 规则，自动继承。
 */
import { describe, it, expect } from 'vitest';
import { STYLES } from '../src/styles';

/** 从 STYLES 抽取所有匹配块的第一捕获组（声明段）。 */
function blocks(re: RegExp): string[] {
  return [...STYLES.matchAll(re)].map((m) => m[1] ?? '');
}

/** 浅色令牌：多处 `:host { ... }`（主令牌区 + v13 info 令牌区），后出现的覆盖先出现的。 */
function tokenMap(sources: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const body of sources) {
    for (const match of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      map.set(`--${match[1]!}`, match[2]!.trim());
    }
  }
  return map;
}

const light = tokenMap(blocks(/:host\s*\{([\s\S]*?)\n\}/g));
const dark = tokenMap(blocks(/:host\(\[theme="dark"\]\)\s*\{([\s\S]*?)\n\}/g));
const prefersDark = tokenMap(
  blocks(/:host\(:not\(\[theme="light"\]\):not\(\[theme="dark"\]\)\)\s*\{([\s\S]*?)\n\s*\}/g),
);

interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(value: string): Color {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff, a: 1 };
  }
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(value.trim());
  if (rgba) {
    const parts = rgba[1]!.split(',').map((p) => Number(p.trim()));
    if (parts.length >= 3 && parts.slice(0, 3).every((p) => Number.isFinite(p))) {
      return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 };
    }
  }
  throw new Error(`无法解析颜色：${value}`);
}

function composite(fg: Color, backdrop: Color): Color {
  return {
    r: fg.r * fg.a + backdrop.r * (1 - fg.a),
    g: fg.g * fg.a + backdrop.g * (1 - fg.a),
    b: fg.b * fg.a + backdrop.b * (1 - fg.a),
    a: 1,
  };
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(color: Color): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG 2.x 相对对比度；fg 允许半透明，按给定背景合成后计算。 */
function contrastWith(token: Map<string, string>, fgName: string, bgName: string): number {
  const backdropToken = token.get('--fb-bg');
  expect(backdropToken, '主题块缺少 --fb-bg（对比度背景基准）').toBeDefined();
  const backdrop = parseColor(backdropToken!);
  const fg = parseColor(required(token, fgName));
  const bg = composite(parseColor(required(token, bgName)), backdrop);
  const hi = Math.max(luminance(fg), luminance(bg));
  const lo = Math.min(luminance(fg), luminance(bg));
  return (hi + 0.05) / (lo + 0.05);
}

function required(token: Map<string, string>, name: string): string {
  const value = token.get(name.startsWith('--') ? name : `--${name}`);
  expect(value, `缺少令牌 --${name}`).toBeDefined();
  return value!;
}

/** 四状态 -> 令牌家族（chip class / 行修饰 class / 令牌前缀 / 中文语义）。 */
const STATUS_FAMILIES = [
  { key: 'open', chip: 'open', row: 'fb-issue--open', family: 'warn', label: '待处理' },
  { key: 'waiting_user', chip: 'waiting-user', row: 'fb-issue--waiting_user', family: 'info', label: '待补充' },
  { key: 'waiting_admin', chip: 'waiting-admin', row: 'fb-issue--waiting_admin', family: 'accent', label: '等待回复' },
  { key: 'resolved', chip: 'resolved', row: 'fb-issue--resolved', family: 'success', label: '已解决' },
] as const;

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's').exec(STYLES);
  expect(match, `STYLES 缺少规则 ${selector}`).not.toBeNull();
  return match![1] ?? '';
}

describe('四状态 chip / 行左边框映射到不同令牌家族', () => {
  it.each(STATUS_FAMILIES)('$key（$label）chip 使用 $family 家族，并带 1px 同色边框', ({ chip, family }) => {
    const body = ruleBody(`.fb-tag.${chip}`);
    expect(body).toContain(`background: var(--fb-status-${family}-bg);`);
    expect(body).toContain(`color: var(--fb-status-${family}-text);`);
    expect(body).toContain(`border: 1px solid var(--fb-status-${family}-border);`);
  });

  it.each(STATUS_FAMILIES)('$key 行左边框与 chip 同色（$family-text）', ({ row, family }) => {
    const body = ruleBody(`.fb-history-item.fb-issue-row.${row}`);
    expect(body).toContain(`border-left-color: var(--fb-status-${family}-text);`);
  });

  it('四个修饰类分别命中四组不同令牌：不会再出现「resolved 灰色、waiting_user 绿色」的旧语义', () => {
    const families = new Set(
      STATUS_FAMILIES.map(({ chip }) => /var\(--fb-status-([a-z]+)-text\)/.exec(ruleBody(`.fb-tag.${chip}`))![1]),
    );
    expect(families.size).toBe(4);
    expect([...families].sort()).toEqual(['accent', 'info', 'success', 'warn']);

    const resolved = ruleBody('.fb-tag.resolved');
    expect(resolved).toContain('var(--fb-status-success-');
    expect(resolved).not.toContain('--fb-bg-subtle-hover');
    expect(resolved).not.toContain('--fb-text-secondary');
    // 行左边框的 resolved 也不再是 --fb-text-tertiary（旧灰色实现）
    expect(ruleBody('.fb-history-item.fb-issue-row.fb-issue--resolved')).toContain('--fb-status-success-text');
  });

  it('对话页状态徽标复用同一 .fb-tag 规则（无对话区专属覆盖色规则）', () => {
    // 规则选择器是通用的 `.fb-tag.waiting-admin`，没有按对话/历史容器再覆盖颜色。
    expect(ruleBody('.fb-tag.waiting-admin')).toBeTruthy();
    expect(STYLES).not.toMatch(/\.fb-dialogue[^{}]*\.fb-tag[^{}]*\{[^}]*color:/);
  });
});

describe('深浅主题令牌完备', () => {
  it('accent（紫）与 info 边框在 :host / :host([theme="dark"]) / prefers-color-scheme 三处都有值', () => {
    const names = [
      '--fb-status-accent-bg',
      '--fb-status-accent-border',
      '--fb-status-accent-text',
      '--fb-status-info-bg',
      '--fb-status-info-border',
      '--fb-status-info-text',
      '--fb-status-warn-bg',
      '--fb-status-warn-border',
      '--fb-status-warn-text',
      '--fb-status-success-bg',
      '--fb-status-success-border',
      '--fb-status-success-text',
      '--fb-status-error-bg',
      '--fb-status-error-border',
      '--fb-status-error-text',
    ];
    for (const name of names) {
      expect(required(light, name.slice(2)), `浅色缺少 ${name}`).not.toBe('');
      expect(required(dark, name.slice(2)), `深色缺少 ${name}`).not.toBe('');
      expect(required(prefersDark, name.slice(2)), `系统深色缺少 ${name}`).not.toBe('');
    }
    // 浅色 resolved 必须是绿色系十六进制（#15803d），不是灰
    expect(required(light, 'fb-status-success-text')).toBe('#15803d');
    // 浅色 waiting_admin 紫色令牌（紫罗兰 700 一档）
    expect(required(light, 'fb-status-accent-text')).toBe('#6d28d9');
    expect(prefersDark.get('--fb-status-accent-text')).toBe(dark.get('--fb-status-accent-text'));
    expect(prefersDark.get('--fb-status-info-border')).toBe(dark.get('--fb-status-info-border'));
  });
});

describe('chip 文字对合成背景的对比度 ≥ 4.5:1（WCAG AA）', () => {
  it.each(STATUS_FAMILIES)('浅色 $key 对比度', ({ family }) => {
    const ratio = contrastWith(light, `fb-status-${family}-text`, `fb-status-${family}-bg`);
    expect(ratio, `浅色 ${family} 对比度 ${ratio.toFixed(3)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(STATUS_FAMILIES)('深色 $key 对比度', ({ family }) => {
    const ratio = contrastWith(dark, `fb-status-${family}-text`, `fb-status-${family}-bg`);
    expect(ratio, `深色 ${family} 对比度 ${ratio.toFixed(3)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it('已解决（resolved）在深浅两套主题下都是绿色系且对比度达标', () => {
    for (const token of [light, dark]) {
      const fg = parseColor(required(token, 'fb-status-success-text'));
      expect(fg.g, `success 前景需为绿色系，实际 rgb(${fg.r},${fg.g},${fg.b})`).toBeGreaterThan(fg.r);
      expect(fg.g).toBeGreaterThan(fg.b);
      expect(contrastWith(token, 'fb-status-success-text', 'fb-status-success-bg')).toBeGreaterThanOrEqual(4.5);
    }
  });
});
