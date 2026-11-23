/**
 * 输入能力探测：决定默认入口形态与桌面唤醒方式。
 *
 * 不读 UA 判断「手机还是桌面」——一台设备接上鼠标和直接用触屏，应当得到两种体验。
 * 探测结果只用于选择默认值与提示文案；显式的 launcher-mode / wake-shortcut 永远优先。
 */
export interface InputProfile {
  /** 主指针是精细指针（鼠标 / 触控板）。 */
  fine: boolean;
  /** 存在触摸输入（触屏笔记本可能 fine 与 touch 同时为真）。 */
  touch: boolean;
}

const NO_INPUT: InputProfile = { fine: false, touch: false };

/** 连接期探测一次；无 matchMedia 的环境返回「不可判定」，调用方据此保持已发布默认。 */
export function detectInputProfile(win?: Window | null): InputProfile {
  const target = win ?? (typeof window === 'undefined' ? null : window);
  if (!target) return NO_INPUT;
  const media = (query: string): boolean => {
    try {
      return typeof target.matchMedia === 'function' && target.matchMedia(query).matches;
    } catch {
      return false;
    }
  };
  const nav = target.navigator as (Navigator & { maxTouchPoints?: number }) | undefined;
  const touch =
    (typeof nav?.maxTouchPoints === 'number' && nav.maxTouchPoints > 0) ||
    'ontouchstart' in target ||
    media('(any-pointer: coarse)');
  return { fine: media('(pointer: fine)'), touch };
}

/**
 * auto 模式下的默认入口：精细指针给可发现的贴边标签，触屏/不可判定时沿用光束手势。
 * 无 matchMedia 的环境探测结果为 { fine:false }，因此保持 0.10–0.12 的 beam 默认。
 */
export function autoLauncherMode(profile: InputProfile): 'tab' | 'beam' {
  return profile.fine ? 'tab' : 'beam';
}

/** 仅用于提示文案（⌘ / Ctrl 的写法差异），不参与行为判断。 */
export function primaryModifierLabel(win?: Window | null): string {
  const target = win ?? (typeof window === 'undefined' ? null : window);
  const nav = target?.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  const platform = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘' : 'Ctrl';
}

/**
 * 把 wake-shortcut 语法（primary+shift+f）渲染成可读组合（⌘+Shift+F / Ctrl+Shift+F）。
 * 语法非法或为 off 时返回 null——调用方据此不显示快捷键提示。
 */
export function formatWakeShortcut(spec: string, win?: Window | null): string | null {
  const raw = spec.trim().toLowerCase();
  if (raw === 'off') return null;
  // 缺省与 WakeGestures 的匹配规则一致：未配置时就是 primary+shift+f。
  const effective = raw || 'primary+shift+f';
  const parts = effective.split('+').map(part => part.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key || !/^[a-z0-9]$|^f([1-9]|1[0-2])$/.test(key)) return null;
  const labels: string[] = [];
  for (const part of parts) {
    if (part === 'primary') labels.push(primaryModifierLabel(win));
    else if (part === 'meta') labels.push('⌘');
    else if (part === 'ctrl') labels.push('Ctrl');
    else if (part === 'alt') labels.push('Alt');
    else if (part === 'shift') labels.push('Shift');
    else return null;
  }
  labels.push(key.toUpperCase());
  return labels.join('+');
}
