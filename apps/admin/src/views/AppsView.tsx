import { useCallback, useEffect, useState } from "react";
import { ApiError, type AppItem, api, type KaneoTestResult } from "../api.ts";

interface Draft {
  id?: string;
  appId: string;
  name: string;
  originsText: string; // 每行一个
  kaneoProjectId: string;
  kaneoColumnSlug: string;
}

const empty: Draft = { appId: "", name: "", originsText: "", kaneoProjectId: "", kaneoColumnSlug: "" };

export default function AppsView() {
  const [apps, setApps] = useState<AppItem[]>([]);
  const [draft, setDraft] = useState<Draft>(empty);
  const [columns, setColumns] = useState<{ slug: string; name: string }[]>([]);
  const [projects, setProjects] = useState<{ id: string; workspaceId: string; name: string; slug: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api.get<{ apps: AppItem[] }>("/api/admin/apps");
    setApps(r.apps);
  }, []);
  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = {
        appId: draft.appId,
        name: draft.name,
        allowedOrigins: draft.originsText
          .split(/\n+/)
          .map((s) => s.trim())
          .filter(Boolean),
        kaneoProjectId: draft.kaneoProjectId,
        kaneoColumnSlug: draft.kaneoColumnSlug,
      };
      if (draft.id) await api.put(`/api/admin/apps/${draft.id}`, body);
      else await api.post("/api/admin/apps", body);
      await load();
      setDraft(empty);
      setColumns([]);
      setNotice("已保存");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  const loadProjects = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.get<{
        ok: boolean;
        workspaces?: unknown[];
        projects?: { id: string; workspaceId: string; name: string; slug: string }[];
        reason?: string;
      }>("/api/admin/connection/kaneo/projects");
      if (!r.ok) {
        setError(`项目列表获取失败：${r.reason ?? "未知原因"}`);
        setProjects([]);
      } else {
        setProjects(r.projects ?? []);
        setNotice(`已加载 ${r.projects?.length ?? 0} 个项目`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "项目列表请求失败");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load().catch((e) => setError(e instanceof ApiError ? e.message : "加载失败"));
    void loadProjects();
  }, [load, loadProjects]);

  async function testProjectWith(projectId: string) {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.post<KaneoTestResult>("/api/admin/connection/kaneo/test", { projectId });
      if (!r.ok) {
        setError(`连接/项目校验失败：${r.reason ?? "未知原因"}`);
        setColumns([]);
      } else {
        setColumns(r.columns ?? []);
        setNotice(`项目「${r.project?.name}」连通，共 ${r.columns?.length} 列`);
        if (r.columns && !r.columns.some((c) => c.slug === draft.kaneoColumnSlug)) {
          setDraft({ ...draft, kaneoColumnSlug: r.columns[0]?.slug ?? "" });
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "测试失败");
    } finally {
      setBusy(false);
    }
  }

  async function remove(app: AppItem) {
    if (!window.confirm(`删除软件「${app.name}」？历史反馈保留。`)) return;
    await api.del(`/api/admin/apps/${app.id}`);
    await load();
  }

  return (
    <div>
      {error && <p className="err">{error}</p>}
      {notice && <p className="ok-text">{notice}</p>}
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>appId</th>
              <th>允许来源</th>
              <th>Kaneo 项目 / 列</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {apps.map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td>
                  <code>{a.appId}</code>
                </td>
                <td className="muted">{a.allowedOrigins.join(" ") || "—"}</td>
                <td>
                  <code>{a.kaneoProjectId || "—"}</code> / <code>{a.kaneoColumnSlug || "—"}</code>
                </td>
                <td className="row">
                  <button
                    type="button"
                    onClick={() =>
                      setDraft({
                        id: a.id,
                        appId: a.appId,
                        name: a.name,
                        originsText: a.allowedOrigins.join("\n"),
                        kaneoProjectId: a.kaneoProjectId,
                        kaneoColumnSlug: a.kaneoColumnSlug,
                      })
                    }
                  >
                    编辑
                  </button>
                  <button type="button" onClick={() => remove(a)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
            {apps.length === 0 && (
              <tr>
                <td colSpan={5} className="muted" style={{ padding: 16 }}>
                  还没有软件配置，用下方表单添加
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h1>{draft.id ? `编辑：${draft.name}` : "新增软件"}</h1>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="an">名称</label>
            <input id="an" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="ai2">appId（创建后不可改）</label>
            <input
              id="ai2"
              value={draft.appId}
              disabled={Boolean(draft.id)}
              onChange={(e) => setDraft({ ...draft, appId: e.target.value })}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="orig">允许的 Web 来源（每行一个 origin，登录握手回传令牌用）</label>
          <textarea
            id="orig"
            rows={2}
            value={draft.originsText}
            onChange={(e) => setDraft({ ...draft, originsText: e.target.value })}
          />
        </div>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="pid">Kaneo 项目 {projects.length > 0 ? "（从实例加载）" : "id"}</label>
            {projects.length > 0 ? (
              <select
                id="pid"
                value={draft.kaneoProjectId}
                onChange={(e) => {
                  setDraft({ ...draft, kaneoProjectId: e.target.value });
                  void testProjectWith(e.target.value);
                }}
              >
                <option value="">— 选择项目 —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}（{p.slug}）
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="pid"
                value={draft.kaneoProjectId}
                onChange={(e) => setDraft({ ...draft, kaneoProjectId: e.target.value })}
              />
            )}
          </div>
          <button type="button" onClick={loadProjects} disabled={busy} style={{ marginTop: 22, whiteSpace: "nowrap" }}>
            {busy ? "…" : "↻ 刷新项目列表"}
          </button>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="col">目标列（保存真实 slug）</label>
            {columns.length > 0 ? (
              <select
                id="col"
                value={draft.kaneoColumnSlug}
                onChange={(e) => setDraft({ ...draft, kaneoColumnSlug: e.target.value })}
              >
                {columns.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.name}（{c.slug}）
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="col"
                value={draft.kaneoColumnSlug}
                onChange={(e) => setDraft({ ...draft, kaneoColumnSlug: e.target.value })}
              />
            )}
          </div>
          <button
            type="button"
            onClick={() => testProjectWith(draft.kaneoProjectId)}
            disabled={busy || !draft.kaneoProjectId}
            style={{ marginTop: 22 }}
          >
            测试项目并加载列
          </button>
        </div>
        <div className="row">
          <button type="button" className="primary" onClick={save} disabled={busy}>
            {draft.id ? "保存修改" : "创建"}
          </button>
          {draft.id && (
            <button
              type="button"
              onClick={() => {
                setDraft(empty);
                setColumns([]);
              }}
            >
              取消编辑
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
