/**
 * 「我的反馈」列表的项目身份：稳定配色 + 展示名回退。
 *
 * 全部为纯函数（无 DOM、无随机、无时间、无模块级可变状态）：同一输入在任何进程、
 * 任何调用顺序下得到同一输出，因此可以在单元测试里直接断言色值。
 *
 * 对比度设计（不靠「单一饱和色直接当文字色」）：
 * - 色值本身只用于 **色点 / 行左边框 / chip 背景**，chip 与行内文字一律用主题令牌前景
 *   （`--fb-text` / `--fb-text-secondary`），因此深浅两套主题自动同时成立；
 * - 色板 10 色由 HSL 等间隔色相（每 36°）+ 固定饱和度 0.7 + **相对亮度统一解算到 0.215** 生成，
 *   于是每个色值对浅色行背景 `#f5f5f7` 与深色行背景 `#2c2c2e` 的对比度都落在 3.48~3.67
 *   ——满足非文本图形元素 WCAG 1.4.11 的 3:1；
 * - chip 背景是同色的 16% alpha 叠加（`rgba(...)`），叠加后与 `--fb-text` 的组合对比度
 *   仍为浅色 ≥12.6、深色 ≥10.5（10 个色板色；中性兜底色最低，为浅色 13.26 / 深色 10.25），
 *   远高于正文级别 4.5:1；
 * - 任意两色的 RGB 欧氏距离 ≥53（最近的是两个相邻绿色），即使命中同色板槽位也不会「撞色到不可辨」。
 *
 * 以上数值可由 `test/project-color.test.ts` 里的对照表复算，改动色板请同步更新该用例。
 */

/** 10 色色板（等间隔色相、统一亮度，深浅主题下均可作色点/边框）。 */
export const PROJECT_PALETTE: readonly string[] = [
  '#df4c4c', // 红
  '#ae741f', // 橙
  '#728818', // 黄绿
  '#32931a', // 绿
  '#1a934a', // 春绿
  '#198e8e', // 青
  '#407fdd', // 蓝
  '#856ce5', // 紫
  '#c14adf', // 品红
  '#dd3f9e', // 玫红
];

/** 无法定位项目（appId 缺失/为空/类型异常）时的中性兜底色。 */
export const NEUTRAL_PROJECT_COLOR = '#8a8a90';

/** chip 背景的叠加比例（低 alpha，保证前景仍取主题令牌色）。 */
export const PROJECT_CHIP_ALPHA = 0.16;

/** 展示名回退长度上限（超过则截断，440px 面板内不撑破行）。 */
export const PROJECT_NAME_MAX = 24;

/**
 * FNV-1a（32 位）+ 溢出 avalanche 终结。逐 **码点** 而非逐 UTF-16 码元遍历，
 * 使中文/emoji appId 在不同引擎下得到同一结果。
 *
 * 终结混入是必要的：反向域名类 appId 高度相似（`com.feedback.web` 与
 * `com.feedback.admin` 只差后缀），纯 FNV-1a 直接取模时相邻字符串容易落到同一槽位。
 * 具体分布以 `test/project-color.test.ts`「相似 appId 与批量 appId 不塌缩到少数槽位」为准则
 * 锁定（3×4×5 = 60 个 `a.b.c` 样本，取模 10 后 10 个槽位全部命中）。
 */
export function hashCode(input: string): number {
  let hash = 0x811c9dc5;
  for (const ch of input) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** 把任意来源的 appId 收敛为可比较字符串（非字符串/空白一律视为空串）。 */
export function normalizeAppId(appId: unknown): string {
  return typeof appId === 'string' ? appId.trim() : '';
}

/**
 * appId -> 色板下标。空/异常返回 `-1`（调用方据此走中性兜底）。
 */
export function projectColorIndex(appId: unknown): number {
  const id = normalizeAppId(appId);
  if (!id) return -1;
  return hashCode(id) % PROJECT_PALETTE.length;
}

/** appId -> 稳定色值（十六进制）。缺失时返回中性灰。 */
export function projectColor(appId: unknown): string {
  const index = projectColorIndex(appId);
  return index >= 0 ? (PROJECT_PALETTE[index] ?? NEUTRAL_PROJECT_COLOR) : NEUTRAL_PROJECT_COLOR;
}

/** `#rrggbb` -> `[r, g, b]`；非法输入返回 null（不抛异常，UI 侧可直接忽略）。 */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const value = m[1]!;
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

/** 十六进制色 -> `rgba(r, g, b, a)` 字符串（避免依赖 color-mix 的浏览器支持面）。 */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return 'transparent';
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Number(a.toFixed(3))})`;
}

/** chip 背景色（同色 16% 叠加，前景仍由 `--fb-text` 提供）。 */
export function projectChipBackground(appId: unknown): string {
  return withAlpha(projectColor(appId), PROJECT_CHIP_ALPHA);
}

/**
 * 行/分组头可直接写入 `style` 属性的自定义属性串：
 * `--fb-project-color`（色点、左边框）与 `--fb-project-chip-bg`（chip 背景）。
 */
export function projectStyleVars(appId: unknown): string {
  return `--fb-project-color:${projectColor(appId)};--fb-project-chip-bg:${projectChipBackground(appId)};`;
}

/**
 * `appName` 缺失时的回退展示名：直接用 appId；
 * 过长则优先保留反向域名最后一段（最能区分项目），仍超长再硬截断。
 */
export function projectFallbackName(appId: unknown): string {
  const id = normalizeAppId(appId);
  if (!id) return '未知项目';
  if (id.length <= PROJECT_NAME_MAX) return id;
  const segments = id.split('.').map((s) => s.trim()).filter((s) => s.length > 0);
  const last = segments.length > 1 ? segments[segments.length - 1] : undefined;
  if (last && last.length <= PROJECT_NAME_MAX) return last;
  return `${id.slice(0, PROJECT_NAME_MAX - 1)}…`;
}

/**
 * 项目展示名：服务端 `appName` 优先，缺失/空白回退 appId 短形式。
 * 返回空串以外的必有值，调用方可直接作为 textContent。
 */
export function projectDisplayName(appName: unknown, appId: unknown): string {
  const name = typeof appName === 'string' ? appName.trim() : '';
  if (name) return name;
  return projectFallbackName(appId);
}
