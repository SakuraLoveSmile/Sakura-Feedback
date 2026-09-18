/**
 * T6：自定义 Feedback 服务器地址——规范化、校验与本机偏好存储。
 *
 * 覆盖偏好按「宿主存储空间（localStorage 源）+ appId + 规范化默认地址」隔离：
 * 换默认地址或换 appId 时读到的是不同槽位，绝不把 A 服务的覆盖带到 B。
 * 偏好只存服务器地址——绝不持久化草稿、密码或令牌。
 */

export type NormalizeServerBaseResult = { ok: true; base: string } | { ok: false; reason: string };

/**
 * 规范化用户输入的服务器地址。
 *
 * 规则：去空白 → 必须 http(s) → 主机非空 → 拒绝内嵌凭据 / 查询参数 / # 片段；
 * 输出为「协议小写 + host（URL 解析已小写主机名并省略默认端口）+ 路径前缀
 * （只去末尾斜杠，支持部署路径前缀）」。
 *
 * [opts.pageIsHttps] 为 true 时拒绝 http 覆盖：HTTPS 页面发起 HTTP 请求会被
 * 浏览器按混合内容拦截，提前在校验层给出可读原因。
 */
export function normalizeServerBase(
  raw: string,
  opts: { pageIsHttps?: boolean } = {},
): NormalizeServerBaseResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: '请输入服务器地址' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      reason: '地址格式无效（示例：https://fb.example.com 或 http://127.0.0.1:8787）',
    };
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') {
    return { ok: false, reason: '仅支持 http(s) 地址（示例：https://fb.example.com）' };
  }
  if (!url.hostname) return { ok: false, reason: '地址缺少主机名' };
  if (url.username || url.password) {
    return { ok: false, reason: '地址不能包含用户名或密码' };
  }
  if (url.search) return { ok: false, reason: '地址不能包含查询参数' };
  if (url.hash) return { ok: false, reason: '地址不能包含 # 片段' };
  if (opts.pageIsHttps && scheme === 'http:') {
    return { ok: false, reason: 'HTTPS 页面无法使用 HTTP 服务地址（浏览器会拦截混合内容）' };
  }
  const path = url.pathname.replace(/\/+$/, '');
  return { ok: true, base: `${scheme}//${url.host}${path}` };
}

function base64UrlEncodeUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * 覆盖偏好存储键：`feedback-widget.server-override.<base64url(规范化默认地址 + NUL + appId)>`。
 * 默认地址规范化失败时按其去空白原值派生——仍保证逐槽位隔离，不会串到其他身份的偏好。
 */
export function serverOverrideStorageKey(appId: string, defaultApiBase: string): string {
  const def = normalizeServerBase(defaultApiBase);
  const base = def.ok ? def.base : defaultApiBase.trim();
  const identity = `${base}\u0000${appId}`;
  return `feedback-widget.server-override.${base64UrlEncodeUtf8(identity)}`;
}

/** 读取已保存的覆盖地址（只读工具，测试与宿主调试可用）；
 * 存储不可用或所存值非法时返回 null（视为无覆盖）。 */
export function readServerOverride(appId: string, defaultApiBase: string): string | null {
  try {
    const raw = window.localStorage.getItem(serverOverrideStorageKey(appId, defaultApiBase));
    if (raw === null) return null;
    const normalized = normalizeServerBase(raw);
    return normalized.ok ? normalized.base : null;
  } catch {
    return null;
  }
}

/** 写入 / 清除覆盖偏好。返回是否成功落盘（失败时调用方提示「仅本次生效」）。 */
export function writeServerOverride(
  appId: string,
  defaultApiBase: string,
  value: string | null,
): boolean {
  try {
    const key = serverOverrideStorageKey(appId, defaultApiBase);
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
