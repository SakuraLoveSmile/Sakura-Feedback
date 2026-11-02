import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type SystemUpdateStatus } from "../api.ts";
import { Icon, InlineError, SkeletonRows } from "../ui.tsx";

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/**
 * 「系统更新」：当前版本 / 最新稳定版与发布说明 / 检查更新。
 *
 * v0.5.1 起为**只读检查页**：服务端直接拉取 GitHub Release 的版本清单并与本机
 * 版本比较，本页只展示结果。安装更新不再由 Web 触发——请在服务器上按部署文档
 * 手动执行（`deploy/update.sh` 或 `docker compose pull && up -d`）。
 */
export default function SystemUpdateView() {
  const [status, setStatus] = useState<SystemUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  /** 页级：状态加载失败（带重试）。 */
  const [error, setError] = useState<string | null>(null);
  /** 卡内：手动检查失败——贴近「检查更新」按钮，点按钮即重试。 */
  const [checkError, setCheckError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    const s = await api.get<SystemUpdateStatus>("/api/admin/system/update");
    setStatus(s);
    setError(null);
    return s;
  }, []);

  useEffect(() => {
    void loadStatus().catch((e) => setError(e instanceof ApiError ? e.message : "加载失败"));
  }, [loadStatus]);

  async function check() {
    setChecking(true);
    setCheckError(null);
    setNotice(null);
    try {
      const r = await api.post<{ check: SystemUpdateStatus["check"] }>("/api/admin/system/update/check");
      setStatus((prev) => (prev ? { ...prev, check: r.check } : prev));
      setNotice(
        r.check.state === "failed"
          ? "检查失败（不影响正在运行的服务，可稍后重试）"
          : r.check.state === "up_to_date"
            ? "当前已是最新稳定版"
            : "发现新版本，请到服务器上手动更新",
      );
    } catch (err) {
      setCheckError(err instanceof ApiError ? err.message : "检查失败");
    } finally {
      setChecking(false);
    }
  }

  if (!status) {
    return (
      <div className="update-page">
        <div className="page-header">
          <div>
            <h1>系统更新</h1>
            <div className="sub">当前版本与最新稳定版检查。</div>
          </div>
        </div>
        {error ? (
          <InlineError
            message={error}
            onRetry={() => void loadStatus().catch((e) => setError(e instanceof ApiError ? e.message : "加载失败"))}
          />
        ) : (
          <div className="card">
            <SkeletonRows rows={3} />
          </div>
        )}
      </div>
    );
  }

  const checkInfo = status.check;
  const latest = checkInfo.state === "up_to_date" || checkInfo.state === "ok" ? checkInfo.latest : null;
  const stateTag =
    checkInfo.state === "never" ? (
      <span className="tag">尚未检查</span>
    ) : checkInfo.state === "failed" ? (
      <span className="tag tone-err">检查失败</span>
    ) : checkInfo.state === "up_to_date" ? (
      <span className="tag archived">已是最新</span>
    ) : (
      <span className="tag received">可更新</span>
    );
  const stateText =
    checkInfo.state === "never"
      ? "尚未检查过"
      : checkInfo.state === "failed"
        ? "检查失败，可重试"
        : checkInfo.state === "up_to_date"
          ? "已是最新稳定版"
          : "发现新版本，请在服务器上更新";
  const noteLines = (latest?.notes ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);

  return (
    <div className="update-page">
      <div className="page-header">
        <div>
          <h1>系统更新</h1>
          <div className="sub">只检查是否有新版本；安装更新请在服务器上手动执行，检查失败不影响正在运行的服务。</div>
        </div>
      </div>
      {error && <InlineError message={error} onRetry={() => void loadStatus().catch(() => undefined)} />}
      {notice && (
        <p className="inline-ok" role="status">
          {notice}
        </p>
      )}

      <section className="version-hero">
        <div className="version-hero-main">
          <div className="version-eyebrow">Current Version</div>
          <div className="version-line">
            <b>{status.current.version}</b>
            <span className="muted">{stateText}</span>
          </div>
          <div className="version-meta muted small">
            <span>上次检查：{checkInfo.state === "never" ? "尚未检查" : fmt(checkInfo.checkedAt)}</span>
            <span>
              自动检查：
              {status.config.checkIntervalMs > 0
                ? `每 ${Math.round(status.config.checkIntervalMs / 3600_000)} 小时`
                : "已关闭"}
            </span>
            <span>来源：{status.config.manifestUrl ? "GitHub Releases 清单" : "已关闭"}</span>
          </div>
        </div>
        <div className="version-hero-side">
          {stateTag}
          <button
            type="button"
            className="btn sm"
            onClick={check}
            disabled={checking || !status.config.manifestUrl}
            title={
              checking
                ? "正在检查…"
                : !status.config.manifestUrl
                  ? "已关闭更新检查（FEEDBACK_UPDATE_MANIFEST_URL=off），无法手动检查"
                  : undefined
            }
            aria-busy={checking}
          >
            <Icon name="refresh" size={14} />
            {checking ? "检查中…" : "检查更新"}
          </button>
        </div>
      </section>
      {/* 禁用原因可见化：配置关闭检查时说明为什么按钮不可点 */}
      {!status.config.manifestUrl && (
        <p className="muted small">已关闭更新检查（FEEDBACK_UPDATE_MANIFEST_URL=off），无法手动检查。</p>
      )}
      {/* 检查请求失败：贴近按钮回显，点「检查更新」即重试 */}
      {checkError && <InlineError message={checkError} onRetry={() => void check()} />}
      {checkInfo.state === "failed" && (
        <p className="err">
          检查失败：{checkInfo.failedMessage ?? "未知原因"}
          {checkInfo.failedCode ? `（${checkInfo.failedCode}）` : ""}
        </p>
      )}

      <div className="update-grid">
        <div className="card update-card">
          <div className="update-card-head">
            <h2 className="update-card-title">版本信息</h2>
            <span className="tag">版本清单</span>
          </div>
          <dl className="kv">
            <dt>当前版本</dt>
            <dd>
              <code>{status.current.version}</code>
            </dd>
            <dt>最新稳定版</dt>
            <dd>
              {latest ? (
                <>
                  <code>{latest.version}</code> {stateTag}
                </>
              ) : (
                <span className="muted">—</span>
              )}
            </dd>
            <dt>发布时间</dt>
            <dd className="muted">{latest ? fmt(latest.publishedAt) : "—"}</dd>
            <dt>检查来源</dt>
            <dd>
              {status.config.manifestUrl ? (
                <code className="wrap-anywhere">{status.config.manifestUrl}</code>
              ) : (
                <span className="muted">已关闭（FEEDBACK_UPDATE_MANIFEST_URL=off）</span>
              )}
              {checkInfo.source ? <span className="muted">（本次来源：{checkInfo.source}）</span> : null}
            </dd>
            <dt>自动检查</dt>
            <dd className="muted">
              {status.config.checkIntervalMs > 0
                ? `每 ${Math.round(status.config.checkIntervalMs / 3600_000)} 小时一次（只检查，绝不自动安装）`
                : "已关闭自动检查（仅手动）"}
            </dd>
            {latest?.image && (
              <>
                <dt>镜像</dt>
                <dd>
                  <code className="wrap-anywhere">{latest.image}</code>
                  {latest.digest ? <span className="muted">（{latest.digest}）</span> : null}
                </dd>
              </>
            )}
          </dl>
          <div className="update-note">
            <i style={{ background: "var(--ok-text)" }} aria-hidden="true" />
            <span>检查来源与自动检查间隔由服务器环境变量控制；本页不提供在线安装。</span>
          </div>
        </div>

        <div className="card update-card">
          <div className="update-card-head">
            <h2 className="update-card-title">发布说明</h2>
          </div>
          {latest ? (
            noteLines.length > 0 ? (
              <ul className="notes-list">
                {noteLines.map((line) => (
                  <li key={line} className="note-item">
                    <i aria-hidden="true" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">该版本清单未包含发布说明。</p>
            )
          ) : (
            <p className="muted">还没有可用的版本信息；点击「检查更新」获取最新稳定版与发布说明。</p>
          )}
          {latest?.releaseUrl && (
            <p style={{ marginTop: 12, marginBottom: 0 }}>
              <a className="btn sm" href={latest.releaseUrl} target="_blank" rel="noreferrer">
                查看完整发布页
                <Icon name="external" size={14} />
              </a>
            </p>
          )}
        </div>
      </div>

      <div className="card update-card how-to">
        <div className="update-card-head">
          <h2 className="update-card-title">如何在服务器上更新</h2>
          <span className="tag tone-warn">确认有新版本后再执行</span>
        </div>
        <p className="muted">
          进入部署目录执行下面的命令。脚本会先备份数据卷，再拉取镜像并重建服务；详见部署文档「升级」一节。
        </p>
        <div className="code-block">
          <span className="prompt">$</span> bash deploy/update.sh
          <br />
          <span className="comment"># 或手动：</span>
          <br />
          <span className="prompt">$</span> docker compose pull &amp;&amp; docker compose up -d
        </div>
      </div>
    </div>
  );
}
