/**
 * Freeze already-loaded linked CSS before html2canvas creates its iframe. The
 * iframe otherwise fetches the links again and can render an unstyled document
 * even though the host still has a perfectly usable stylesheet in memory.
 */
interface LinkedStyleSnapshot {
  href: string;
  media: string;
  nonce: string;
  disabled: boolean;
  selectionManaged: boolean;
  required: boolean;
  css: string | null;
  unrestorable: boolean;
}

const STYLE_LOAD_TIMEOUT_MS = 3000;

function linkedStyles(root: Document, ignore?: (el: Element) => boolean): HTMLLinkElement[] {
  const links: HTMLLinkElement[] = [];
  const visit = (parent: ParentNode): void => {
    for (const element of Array.from(parent.children)) {
      if (element.hasAttribute('data-html2canvas-ignore') || ignore?.(element)) continue;
      if (element.tagName === 'LINK' && (element as HTMLLinkElement).relList.contains('stylesheet')) {
        links.push(element as HTMLLinkElement);
      }
      if (element.shadowRoot) visit(element.shadowRoot);
      visit(element);
    }
  };
  visit(root);
  return links;
}

/** CSSOM strings retain CSS escapes; URL() expects the decoded URL instead. */
function decodeCssString(value: string): string {
  return value.replace(/\\(?:([\da-f]{1,6})(?:\r\n|[\t\n\f\r ])?|(\r\n|[\n\f\r])|(.))/gi,
    (_match, hex: string | undefined, newline: string | undefined, escaped: string | undefined) => {
      if (hex) {
        const point = Number.parseInt(hex, 16);
        return point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)
          ? '\ufffd' : String.fromCodePoint(point);
      }
      return newline ? '' : escaped ?? '';
    });
}

function stringEnd(css: string, start: number): number {
  const quote = css[start];
  let end = start + 1;
  for (; end < css.length; end++) {
    if (css[end] === '\\') end++;
    else if (css[end] === quote) return end + 1;
  }
  return end;
}

function resolvedUrl(value: string, base: string): string {
  const decoded = decodeCssString(value);
  // Empty URLs and local SVG fragments have special same-document semantics.
  return decoded === '' || decoded.startsWith('#') ? decoded : new URL(decoded, base).href;
}

/** Rebase resource tokens without rewriting quoted content or CSS comments. */
function rebaseUrls(css: string, base: string): string {
  let result = '';
  let i = 0;
  const functions: string[] = [];
  while (i < css.length) {
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      const next = end < 0 ? css.length : end + 2;
      result += css.slice(i, next);
      i = next;
      continue;
    }
    const char = css[i]!;
    if (char === '"' || char === "'") {
      const end = stringEnd(css, i);
      const fn = functions[functions.length - 1];
      result += fn === 'image-set' || fn === '-webkit-image-set'
        ? JSON.stringify(resolvedUrl(css.slice(i + 1, end - 1), base)) : css.slice(i, end);
      i = end;
      continue;
    }
    const fn = /^[a-z_-][\w-]*\(/i.exec(css.slice(i));
    if (fn && (i === 0 || !/[\w-]/.test(css[i - 1]!))) {
      const name = fn[0].slice(0, -1).toLowerCase();
      if (name === 'url') {
        let start = i + fn[0].length;
        while (/\s/.test(css[start] ?? '')) start++;
        let end = start;
        let value: string;
        if (css[start] === '"' || css[start] === "'") {
          end = stringEnd(css, start);
          value = css.slice(start + 1, end - 1);
          while (/\s/.test(css[end] ?? '')) end++;
        } else {
          while (end < css.length && css[end] !== ')') {
            if (css[end] === '\\') end++;
            end++;
          }
          value = css.slice(start, end).trim();
        }
        if (css[end] !== ')') throw new Error('无法保存样式中的资源地址');
        result += `url(${JSON.stringify(resolvedUrl(value, base))})`;
        i = end + 1;
        continue;
      }
      functions.push(name);
      result += fn[0];
      i += fn[0].length;
      continue;
    }
    if (char === '(') functions.push('');
    else if (char === ')') functions.pop();
    result += char;
    i++;
  }
  return result;
}

function serializeSheet(sheet: CSSStyleSheet, base: string, view: Window, imported = false, ancestors = new Set<CSSStyleSheet>()): string {
  if (ancestors.has(sheet)) throw new Error('循环导入的样式无法冻结');
  ancestors.add(sheet);
  try {
    return Array.from(sheet.cssRules).map((rule) => {
      if (rule.type === 3) {
        const dependency = rule as CSSImportRule;
        const media = dependency.media.mediaText;
        const supports = dependency.supportsText;
        const applies = (!media || view.matchMedia(media).matches)
          && (!supports || CSS.supports(`(${supports})`));
        let css = '';
        if (applies) {
          if (!dependency.styleSheet) throw new Error('导入的样式尚未就绪');
          css = serializeSheet(dependency.styleSheet, new URL(dependency.href, base).href, view, true, ancestors);
        }
        if (media && media !== 'all') css = `@media ${media} {${css}}`;
        if (supports) css = `@supports (${supports}) {${css}}`;
        if (dependency.layerName != null) css = `@layer ${dependency.layerName} {${css}}`;
        return css;
      }
      // A namespace is scoped to its stylesheet, and cannot be flattened inside
      // an import's media/supports/layer group without changing its selectors.
      if (imported && rule.type === 10) throw new Error('带命名空间的导入需保留外链');
      return rebaseUrls(rule.cssText, base);
    }).join('\n');
  } finally {
    ancestors.delete(sheet);
  }
}

function reloadSheet(link: HTMLLinkElement, nonce: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('截图已取消'));
  // Chromium can retain an opaque sheet after a failed request. Only a fresh
  // link with listeners installed before insertion proves this load succeeded.
  const replacement = link.cloneNode(false) as HTMLLinkElement;
  if (nonce) replacement.nonce = nonce;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      replacement.removeEventListener('load', loaded);
      replacement.removeEventListener('error', failed);
      signal?.removeEventListener('abort', aborted);
      if (error) {
        replacement.remove();
        reject(error);
      }
      else resolve();
    };
    const loaded = (): void => finish(replacement.sheet ? undefined : new Error('截图样式未加载'));
    const failed = (): void => finish(new Error('截图样式加载失败'));
    const aborted = (): void => finish(new Error('截图已取消'));
    const timer = setTimeout(failed, STYLE_LOAD_TIMEOUT_MS);
    replacement.addEventListener('load', loaded);
    replacement.addEventListener('error', failed);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    else {
      try {
        link.replaceWith(replacement);
      } catch {
        finish(new Error('截图无法重新加载样式'));
      }
    }
  });
}

async function waitForFonts(clone: Document, signal?: AbortSignal): Promise<void> {
  // Restoring @font-face can start font loading after html2canvas's earlier font
  // wait. Force layout first so FontFaceSet.ready includes the actually used font.
  clone.documentElement.getBoundingClientRect();
  const ready = clone.fonts?.ready;
  if (!ready) return;
  await new Promise<void>((resolve, reject) => {
    const aborted = (): void => {
      signal?.removeEventListener('abort', aborted);
      reject(new Error('截图已取消'));
    };
    signal?.addEventListener('abort', aborted, { once: true });
    ready.then(() => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }, (error: unknown) => {
      signal?.removeEventListener('abort', aborted);
      reject(error);
    });
    if (signal?.aborted) aborted();
  });
}

/** Internal capture boundary; never changes the source document or its sheets. */
export function snapshotLinkedStyles(
  source: Document,
  ignore?: (el: Element) => boolean,
): (clone: Document, signal?: AbortSignal) => Promise<void> {
  const snapshots: LinkedStyleSnapshot[] = linkedStyles(source, ignore).map((link) => {
    const sheet = link.sheet;
    const disabled = link.disabled || sheet?.disabled === true;
    // Both alternate and preferred titled sheets participate in the browser's
    // stylesheet-set selection, which is not reflected by sheet.disabled.
    const selectionManaged = link.relList.contains('alternate') || link.title !== '';
    const required = sheet !== null && !disabled && (!link.media || source.defaultView!.matchMedia(link.media).matches);
    let css: string | null = null;
    let unrestorable = false;
    if (sheet && !disabled && !selectionManaged) {
      let readable = false;
      try {
        // A readable parent with an unreadable import must not be mistaken for
        // a fully loaded opaque top-level sheet when the import later fails.
        readable = sheet.cssRules != null;
      } catch {
        // Cross-origin CSSOM is deliberately opaque. Keep its link and require
        // the iframe to actually load it; never silently accept missing CSS.
      }
      if (readable) {
        try {
          css = serializeSheet(sheet, sheet.href || link.href, source.defaultView!);
        } catch {
          unrestorable = true;
        }
      }
    }
    return { href: link.href, media: link.media, nonce: link.nonce ?? '', disabled, selectionManaged, required, css, unrestorable };
  });

  return async (clone, signal) => {
    if (clone === source && snapshots.length > 0) throw new Error('样式恢复需要独立克隆文档');
    const remaining = new Map<string, LinkedStyleSnapshot[]>();
    for (const snapshot of snapshots) {
      const queue = remaining.get(snapshot.href) ?? [];
      queue.push(snapshot);
      remaining.set(snapshot.href, queue);
    }
    for (const link of linkedStyles(clone)) {
      const snapshot = remaining.get(link.href)?.shift();
      if (!snapshot) throw new Error('截图克隆的样式与源页面不一致');
      if (snapshot.unrestorable && snapshot.required) throw new Error('无法冻结截图所需的导入样式');
      // Explicitly assigning disabled=false enables an unselected alternate
      // sheet in Chrome. Preserve its rel/title selection behavior instead.
      if (!snapshot.selectionManaged || snapshot.disabled) {
        link.disabled = snapshot.disabled;
        if (link.sheet) link.sheet.disabled = snapshot.disabled;
      }
      if (snapshot.css !== null) {
        const style = clone.createElement('style');
        style.media = snapshot.media;
        if (snapshot.nonce) style.nonce = snapshot.nonce;
        style.textContent = snapshot.css;
        link.replaceWith(style);
        if (!style.sheet) throw new Error('截图无法应用已保存样式');
      } else if (snapshot.required) {
        await reloadSheet(link, snapshot.nonce, signal);
      }
    }
    if ([...remaining.values()].some((queue) => queue.some((snapshot) => snapshot.required))) {
      throw new Error('截图克隆缺少源页面样式');
    }
    if (snapshots.some((snapshot) => snapshot.required)) await waitForFonts(clone, signal);
  };
}
