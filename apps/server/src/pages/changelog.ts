import { type PublicChangelog, type PublicRelease, RELEASE_GROUPS } from "../db/changelog.ts";

function html(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function releaseHtml(release: PublicRelease): string {
  return `<article class="release">
    <header><h2>${html(release.version)}</h2><time datetime="${html(release.releaseDate)}">${html(release.releaseDate)}</time></header>
    ${release.summary ? `<p class="summary prose">${html(release.summary)}</p>` : ""}
    ${RELEASE_GROUPS.map((group) => {
      const entries = release.entries.filter((entry) => entry.type === group.type);
      if (!entries.length) return "";
      return `<section><h3>${group.label}</h3><ul>${entries
        .map(
          (entry) => `<li>
        <h4>${html(entry.title)}</h4>
        ${entry.description ? `<p class="prose">${html(entry.description)}</p>` : ""}
        ${entry.contributors.length ? `<p class="credits">感谢 ${entry.contributors.map(html).join("、")} 提出反馈。</p>` : ""}
      </li>`,
        )
        .join("")}</ul></section>`;
    }).join("")}
    ${release.upgradeNotes ? `<section class="upgrade"><h3>升级说明</h3><p class="prose">${html(release.upgradeNotes)}</p></section>` : ""}
  </article>`;
}

/** 只接收公开 DTO；无脚本、无外部请求，不以 innerHTML 解析用户 Markdown。 */
export function changelogPageHtml(changelog: PublicChangelog): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${html(changelog.appName)} · 更新日志</title>
<style>
:root{color-scheme:light dark;--bg:#f3f4f7;--panel:#fff;--text:#101828;--muted:#667085;--border:#e8eaf0;--primary:#2f5bea;--subtle:#f2f4f8}
@media(prefers-color-scheme:dark){:root{--bg:#101828;--panel:#182230;--text:#f2f4f7;--muted:#b4bdcb;--border:#344054;--primary:#a4bcfd;--subtle:#1d2939}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.7 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
main{width:min(100%,864px);margin:0 auto;padding:48px 24px 64px;overflow-wrap:anywhere}h1,h2,h3,h4,p{margin:0}h1{font-size:28px;line-height:1.35}h2{font-size:22px}h3{font-size:16px;margin-bottom:12px}h4{font-size:14px;font-weight:600}
.page-head{margin-bottom:32px}.eyebrow{color:var(--muted);margin-bottom:8px}.page-head .description{color:var(--muted);margin-top:8px}a{color:var(--primary);text-underline-offset:3px}a:focus-visible{outline:2px solid var(--primary);outline-offset:4px}
.actions{margin-top:16px}.release{border:1px solid var(--border);border-radius:14px;background:var(--panel);padding:24px;margin-top:24px}.release header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}.release time{color:var(--muted);white-space:nowrap}
.summary{color:var(--muted);margin-top:12px}.prose{white-space:pre-wrap}section{margin-top:24px}ul{list-style:none;margin:0;padding:0}li+li{margin-top:16px}li p{margin-top:4px}.credits{color:var(--muted)}.upgrade{background:var(--subtle);padding:16px;border-radius:9px}.empty{color:var(--muted);padding:32px 0}
@media(max-width:600px){main{padding:24px 16px 32px}.page-head{margin-bottom:24px}.release{padding:16px;margin-top:16px}h1{font-size:24px}h2{font-size:20px}}
</style></head><body><main>
<header class="page-head"><p class="eyebrow">${html(changelog.appName)}</p><h1>更新日志</h1><p class="description">每一次改进，都有你的参与。</p>
<p class="actions"><a href="/api/changelog/${encodeURIComponent(changelog.appId)}/markdown">查看 Markdown</a></p></header>
${changelog.items.length ? changelog.items.map(releaseHtml).join("") : '<p class="empty">暂未发布更新日志。</p>'}
</main></body></html>`;
}
