import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type SystemUpdateStatus } from "../api.ts";
import { InlineError, SkeletonRows } from "../ui.tsx";

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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    const s = await api.get<SystemUpdateStatus>("/api/admin/system/update");
    setStatus(s);
    return s;
  }, []);

  useEffect(() => {
    void loadStatus().catch((e) => setError(e instanceof ApiError ? e.message : "加载失败"));
  }, [loadStatus]);

  async function check() {
    setChecking(true);
    setError(null);
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
      setError(err instanceof ApiError ? err.message : "检查失败");
    } finally {
      setChecking(false);
    }
  }

  if (!status) {
    return (
      <div>
        <div className="page-header">
          <div>
            <h1>系统更新</h1>
            <div className="sub">当前版本与最新稳定版检查。</div>
          </div>
        </div>
        <div className="card">
          <SkeletonRows rows={3} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>系统更新</h1>
          <div className="sub">只检查是否有新版本；安装更新请在服务器上手动执行。</div>
        </div>
      </div>
      {error && <InlineError message={error} onRetry={() => void loadStatus().catch(() => undefined)} />}
      {notice && <p className="ok-text">{notice}</p>}

      <div className="card">
        <div className="kv">
          <span className="muted">当前版本</span>
          <span>
            <code>{status.current.version}</code>
          </span>
          <span className="muted">检查来源</span>
          <span>
            {status.config.manifestUrl ? (
              <code className="wrap-anywhere">{status.config.manifestUrl}</code>
            ) : (
              <span className="muted">已关闭（FEEDBACK_UPDATE_MANIFEST_URL=off）</span>
            )}
          </span>
          <span className="muted">自动检查</span>
          <span className="muted">
            {status.config.checkIntervalMs > 0
              ? `每 ${Math.round(status.config.checkIntervalMs / 3600_000)} 小时检查一次（只检查，绝不自动安装）`
              : "已关闭自动检查（仅手动）"}
          </span>
        </div>
      </div>

      <div className="card">
        <div className="row row-wrap spread" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>版本状态</h2>
          <div className="btn-row">
            <button type="button" className="btn" onClick={check} disabled={checking || !status.config.manifestUrl}>
              {checking ? "检查中…" : "检查更新"}
            </button>
          </div>
        </div>
        <CheckSummary check={status.check} />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>如何更新</h2>
        <p className="muted" style={{ marginBottom: 0 }}>
          本页不提供在线安装。确认有新版本后，请在服务器上进入部署目录执行 <code>bash deploy/update.sh</code>
          （会先备份数据卷再拉取重建），或手动 <code>docker compose pull && docker compose up -d</code>
          。详见部署文档「升级」一节。
        </p>
      </div>
    </div>
  );
}

function CheckSummary({ check }: { check: SystemUpdateStatus["check"] }) {
  if (check.state === "never") return <p className="muted">尚未检查过。点击「检查更新」获取最新稳定版信息。</p>;
  if (check.state === "failed") {
    return (
      <>
        <p className="err">
          检查失败：{check.failedMessage ?? "未知原因"}
          {check.failedCode ? `（${check.failedCode}）` : ""}
        </p>
        <p className="muted" style={{ marginBottom: 0 }}>
          检查失败不影响正在运行的服务。上次检查：{fmt(check.checkedAt)}。
        </p>
      </>
    );
  }
  const latest = check.latest;
  if (!latest) return <p className="muted">没有可用的版本信息。</p>;
  return (
    <>
      <div className="kv">
        <span className="muted">最新稳定版</span>
        <span>
          <code>{latest.version}</code>{" "}
          {check.state === "up_to_date" ? (
            <span className="tag archived">已是最新</span>
          ) : (
            <span className="tag received">可更新</span>
          )}
          {latest.releaseUrl && (
            <>
              {" "}
              <a href={latest.releaseUrl} target="_blank" rel="noreferrer">
                查看发布页
              </a>
            </>
          )}
        </span>
        <span className="muted">发布时间</span>
        <span className="muted">{fmt(latest.publishedAt)}</span>
        <span className="muted">本次检查</span>
        <span className="muted">
          {fmt(check.checkedAt)}
          {check.source ? `（来源：${check.source}）` : ""}
        </span>
        {latest.image && (
          <>
            <span className="muted">镜像</span>
            <span>
              <code className="wrap-anywhere">{latest.image}</code>
              {latest.digest ? <span className="muted">（{latest.digest}）</span> : null}
            </span>
          </>
        )}
      </div>
      {latest.notes ? (
        <div style={{ marginTop: 12 }}>
          <div className="muted" style={{ marginBottom: 4 }}>
            发布说明
          </div>
          <blockquote className="quote">{latest.notes}</blockquote>
        </div>
      ) : (
        <p className="muted">该版本清单未包含发布说明。</p>
      )}
    </>
  );
}
