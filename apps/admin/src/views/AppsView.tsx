import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type AppDetail,
  type AppItem,
  type AppSourceItem,
  api,
  type ClassifyOptions,
  type KaneoTestResult,
} from "../api.ts";

interface Draft {
  id?: string;
  appId: string;
  name: string;
  originsText: string; // 每行一个
  kaneoProjectId: string;
  kaneoColumnSlug: string;
}

/** 默认归档目标（自动归档规则）编辑状态。 */
interface RuleDraft {
  projectId: string;
  columnId: string;
  columnSlug: string;
  labelIds: string[];
  assigneeId: string;
}

const empty: Draft = { appId: "", name: "", originsText: "", kaneoProjectId: "", kaneoColumnSlug: "" };
const emptyRule: RuleDraft = { projectId: "", columnId: "", columnSlug: "", labelIds: [], assigneeId: "" };

function configStatusText(a: AppItem): string {
  return a.configStatus === "pending" ? "待配置" : "已配置";
}

function archiveModeText(a: AppItem): string {
  return a.archiveMode === "automatic" ? "自动归档" : "人工归档";
}

export default function AppsView() {
  const [apps, setApps] = useState<AppItem[]>([]);
  const [draft, setDraft] = useState<Draft>(empty);
  const [rule, setRule] = useState<RuleDraft>(emptyRule);
  const [columns, setColumns] = useState<{ slug: string; name: string }[]>([]);
  const [projects, setProjects] = useState<{ id: string; workspaceId: string; name: string; slug: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 正在读取软件详情：期间禁用规则编辑器，避免迟到的详情回写覆盖用户刚做的选择。 */
  const [detailLoading, setDetailLoading] = useState(false);

  // 详情面板：来源列表与规则选项
  const [selected, setSelected] = useState<AppItem | null>(null);
  const [sources, setSources] = useState<AppSourceItem[]>([]);
  const [options, setOptions] = useState<ClassifyOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  /** 选项请求序号：切换项目后丢弃迟到响应，避免把旧项目的列/标签写进规则。 */
  const optionsSeq = useRef(0);
  /**
   * 来源确认的稳定操作幂等键：同一次点击（含失败后的重试）复用同一个键，
   * 网络重试不会生成新键，也就不会被服务端当成第二次操作。
   */
  const confirmOps = useRef<Map<string, string>>(new Map());

  /** 一次操作的稳定幂等键（重试复用；成功后清除）。 */
  function operationKey(scope: string): string {
    const existing = confirmOps.current.get(scope);
    if (existing) return existing;
    const key =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    confirmOps.current.set(scope, key);
    return key;
  }

  const load = useCallback(async () => {
    const r = await api.get<{ apps: AppItem[] }>("/api/admin/apps");
    setApps(r.apps);
    return r.apps;
  }, []);

  const loadDetail = useCallback(async (appId: string) => {
    const d = await api.get<AppDetail>(`/api/admin/apps/${appId}`);
    setSelected(d.app);
    setSources(d.sources);
    return d.app;
  }, []);

  const loadOptions = useCallback(async (projectId: string) => {
    const seq = ++optionsSeq.current;
    setOptionsError(null);
    if (!projectId) {
      setOptions(null);
      return;
    }
    try {
      const r = await api.get<ClassifyOptions>(
        `/api/admin/feedback/options?projectId=${encodeURIComponent(projectId)}`,
      );
      if (seq !== optionsSeq.current) return; // 迟到的旧项目响应直接丢弃
      setOptions(r);
    } catch (err) {
      if (seq !== optionsSeq.current) return;
      setOptions(null);
      setOptionsError(err instanceof ApiError ? err.message : "读取 Kaneo 选项失败");
    }
  }, []);

  const openDetail = useCallback(
    async (app: AppItem) => {
      setError(null);
      setColumns([]);
      // 加载期间禁用规则编辑器：详情回写不会覆盖管理员已经做出的选择。
      setDetailLoading(true);
      try {
        const detail = await api.get<AppDetail>(`/api/admin/apps/${app.id}`);
        const fresh = detail.app;
        setSelected(fresh);
        setSources(detail.sources);
        setDraft({
          id: fresh.id,
          appId: fresh.appId,
          name: fresh.name,
          originsText: fresh.allowedOrigins.join("\n"),
          kaneoProjectId: fresh.defaults.projectId,
          kaneoColumnSlug: fresh.defaults.columnSlug,
        });
        setRule({
          projectId: fresh.defaults.projectId,
          columnId: fresh.defaults.columnId,
          columnSlug: fresh.defaults.columnSlug,
          labelIds: fresh.defaults.labelIds,
          assigneeId: fresh.defaults.assigneeId ?? "",
        });
        await loadOptions(fresh.defaults.projectId);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "读取软件详情失败");
      } finally {
        setDetailLoading(false);
      }
    },
    [loadOptions],
  );

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

  /** 普通保存：写名称/来源/默认目标，**不触发归档**。必须带页面读到的规则版本。 */
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
        kaneoProjectId: rule.projectId || draft.kaneoProjectId,
        kaneoColumnId: rule.columnId,
        kaneoColumnSlug: rule.columnSlug || draft.kaneoColumnSlug,
        kaneoLabelIds: rule.labelIds,
        kaneoAssigneeId: rule.assigneeId || null,
        ...(rule.assigneeId
          ? { kaneoAssigneeName: options?.members.find((m) => m.id === rule.assigneeId)?.name ?? null }
          : {}),
      };
      if (draft.id) {
        // T2 版本契约：旧页面（版本已过期）保存会被 409 拒绝，不静默覆盖他人配置。
        const expectedRuleVersion = selected?.id === draft.id ? selected.ruleVersion : undefined;
        if (expectedRuleVersion === undefined) {
          setError("缺少页面读取到的规则版本，请刷新后重试");
          return;
        }
        await api.put(`/api/admin/apps/${draft.id}`, { ...body, expectedRuleVersion });
      } else {
        await api.post("/api/admin/apps", body);
      }
      const list = await load();
      if (draft.id) {
        // 保存后保持该软件被选中：普通保存与「启用自动归档」是两个独立动作，
        // 管理员保存完规则后应该能直接点启用，而不必再找一遍。
        const updated = list.find((a) => a.id === draft.id);
        if (updated) await openDetail(updated);
        setNotice(
          updated?.ruleComplete
            ? "已保存（普通保存不会触发归档）。规则已完整，可点「启用自动归档并处理积压」。"
            : "已保存（普通保存不会触发归档）。规则尚不完整：需要项目、目标列与至少一个工作区标签。",
        );
      } else {
        setDraft(empty);
        setRule(emptyRule);
        setColumns([]);
        setSelected(null);
        setSources([]);
        setOptions(null);
        setNotice(`已保存（共 ${list.length} 个软件）；普通保存不会触发归档`);
      }
    } catch (err) {
      await reportWriteFailure(err, draft.id, "保存失败");
    } finally {
      setBusy(false);
    }
  }

  /**
   * 版本冲突的统一处理（T2）：提示具体原因、刷新详情，由管理员重新确认；
   * **绝不静默重试写入**。
   */
  async function reportWriteFailure(err: unknown, appId: string | undefined, fallback: string): Promise<void> {
    if (err instanceof ApiError && err.code === "version_conflict") {
      const message = `${err.message} 已刷新最新配置，请确认后重新操作。`;
      if (appId) {
        try {
          const list = await load();
          const fresh = list.find((a) => a.id === appId);
          if (fresh) await openDetail(fresh);
          else await loadDetail(appId);
        } catch {
          /* 刷新失败保留原始错误说明 */
        }
      }
      setError(message); // 刷新会清空错误，因此最后再写入提示
      return;
    }
    setError(err instanceof ApiError ? err.message : fallback);
  }

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
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "测试失败");
    } finally {
      setBusy(false);
    }
  }

  /** 明确启用自动归档并处理积压（与“普通保存”是两个独立动作）。 */
  async function enableAuto(app: AppItem) {
    if (!app.ruleComplete) {
      setError("自动归档规则不完整：请先选择项目、目标列与至少一个工作区标签（点“编辑”配置并保存）");
      return;
    }
    if (!window.confirm(`启用「${app.name}」的自动归档并立即处理积压反馈？`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.post<{ ok: boolean; replayed: boolean }>(`/api/admin/apps/${app.id}/auto-archive/enable`, {
        expectedRuleVersion: app.ruleVersion,
        operationId: operationKey(`enable:${app.id}`),
      });
      confirmOps.current.delete(`enable:${app.id}`);
      await load();
      if (selected?.id === app.id) await loadDetail(app.id);
      setNotice(r.replayed ? "该操作已执行过（幂等返回），未重复处理积压" : "已启用自动归档，正在补处理积压");
    } catch (err) {
      await reportWriteFailure(err, app.id, "启用失败");
    } finally {
      setBusy(false);
    }
  }

  async function disableAuto(app: AppItem) {
    if (!window.confirm(`关闭「${app.name}」的自动归档？已授权的任务会继续执行，只阻止新的自动授权。`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.post(`/api/admin/apps/${app.id}/auto-archive/disable`, {
        expectedRuleVersion: app.ruleVersion,
        operationId: operationKey(`disable:${app.id}`),
      });
      confirmOps.current.delete(`disable:${app.id}`);
      await load();
      if (selected?.id === app.id) await loadDetail(app.id);
      setNotice("已关闭自动归档：已授权的任务继续执行");
    } catch (err) {
      await reportWriteFailure(err, app.id, "关闭失败");
    } finally {
      setBusy(false);
    }
  }

  /**
   * 确认来源：带**当前详情里的规则版本**与**一次操作的稳定幂等键**。
   * 版本过期 → 409（不确认、不补处理），页面刷新详情后由管理员重新确认。
   * 提示区分「等待启用自动归档」（人工模式）与「正在补处理」（自动模式）。
   */
  async function confirmSource(app: AppItem, origin: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const scope = `confirm:${app.id}:${origin}`;
    try {
      const r = await api.post<{
        ok: boolean;
        replayed?: boolean;
        alreadyConfirmed?: boolean;
        autoArchiveEnabled?: boolean;
        backlogDispatched?: boolean;
      }>(`/api/admin/apps/${app.id}/sources/confirm`, {
        origin,
        operationId: operationKey(scope),
        expectedRuleVersion: app.ruleVersion,
      });
      confirmOps.current.delete(scope);
      await load();
      await loadDetail(app.id);
      setNotice(
        r.alreadyConfirmed
          ? "该来源此前已确认"
          : r.replayed
            ? "该确认操作已执行过（幂等返回）"
            : r.backlogDispatched
              ? "已确认来源，正在自动补处理该来源的积压反馈"
              : "已确认来源。当前仍是人工归档模式：需要点「启用自动归档并处理积压」后才会自动处理",
      );
    } catch (err) {
      await reportWriteFailure(err, app.id, "确认来源失败");
    } finally {
      setBusy(false);
    }
  }

  async function remove(app: AppItem) {
    if (!window.confirm(`删除软件「${app.name}」？历史反馈保留。`)) return;
    await api.del(`/api/admin/apps/${app.id}`);
    if (selected?.id === app.id) {
      setSelected(null);
      setSources([]);
      setDraft(empty);
      setRule(emptyRule);
    }
    await load();
  }

  const pendingTotal = apps.filter((a) => a.configStatus === "pending").length;
  const pendingSourceTotal = apps.reduce((n, a) => n + a.pendingSources, 0);
  const waitingTotal = apps.reduce((n, a) => n + a.waitingFeedbacks, 0);

  return (
    <div>
      {error && <p className="err">{error}</p>}
      {notice && <p className="ok-text">{notice}</p>}

      <p className="muted">
        待配置软件 <b>{pendingTotal}</b> 个 · 待确认来源 <b>{pendingSourceTotal}</b> 条 · 等待归档反馈{" "}
        <b>{waitingTotal}</b> 条
      </p>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>appId</th>
              <th>状态</th>
              <th>归档方式</th>
              <th>来源（待确认/已确认）</th>
              <th>等待反馈</th>
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
                <td>
                  {configStatusText(a)}
                  {a.configStatus === "pending" && <span className="muted"> · 自动发现</span>}
                </td>
                <td>
                  {archiveModeText(a)}
                  {a.archiveMode === "automatic" && !a.ruleComplete && <span className="err"> · 规则不完整</span>}
                  <span className="muted"> · 规则 v{a.ruleVersion}</span>
                </td>
                <td>
                  <b>{a.pendingSources}</b> / {a.confirmedSources}
                </td>
                <td>{a.waitingFeedbacks}</td>
                <td className="row">
                  <button type="button" onClick={() => void openDetail(a)}>
                    配置
                  </button>
                  {a.archiveMode === "automatic" ? (
                    <button type="button" onClick={() => void disableAuto(a)} disabled={busy}>
                      关闭自动归档
                    </button>
                  ) : (
                    <button type="button" onClick={() => void enableAuto(a)} disabled={busy}>
                      启用自动归档
                    </button>
                  )}
                  <button type="button" onClick={() => void remove(a)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
            {apps.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ padding: 16 }}>
                  还没有软件配置：组件首次提交反馈后会自动出现在这里，也可以手动新增
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="card">
          <h1>来源确认：{selected.name}</h1>
          <p className="muted">
            服务端按请求 Origin 逐条记录来源；无 Origin 的原生客户端记为 <code>native</code>。待确认来源不会自动归档，
            确认后由扫描自动补处理。
          </p>
          <table>
            <thead>
              <tr>
                <th>来源</th>
                <th>类型</th>
                <th>状态</th>
                <th>最近出现</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.origin}>
                  <td>
                    <code>{s.origin}</code>
                  </td>
                  <td>{s.kind === "native" ? "原生客户端" : "浏览器"}</td>
                  <td>{s.status === "confirmed" ? "已确认" : "待确认"}</td>
                  <td className="muted">{s.lastSeenAt}</td>
                  <td>
                    {s.status === "pending" ? (
                      <button type="button" onClick={() => void confirmSource(selected, s.origin)} disabled={busy}>
                        确认来源
                      </button>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {sources.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted" style={{ padding: 16 }}>
                    还没有观察到任何来源（组件提交后自动登记）
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h1>{draft.id ? `配置：${draft.name}` : "新增软件"}</h1>
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
          <label htmlFor="orig">允许的 Web 来源（每行一个 origin；此处登记的来源直接视为已确认）</label>
          <textarea
            id="orig"
            rows={2}
            value={draft.originsText}
            onChange={(e) => setDraft({ ...draft, originsText: e.target.value })}
          />
        </div>

        <h1 style={{ fontSize: 15, marginTop: 8 }}>默认归档目标（自动归档规则）</h1>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="pid">Kaneo 项目 {projects.length > 0 ? "（从实例加载）" : "id"}</label>
            {projects.length > 0 ? (
              <select
                id="pid"
                value={rule.projectId}
                disabled={detailLoading}
                onChange={(e) => {
                  // 切换项目：立即清空列/标签/负责人，并丢弃旧项目的迟到响应
                  setRule({
                    ...rule,
                    projectId: e.target.value,
                    columnId: "",
                    columnSlug: "",
                    labelIds: [],
                    assigneeId: "",
                  });
                  setOptions(null);
                  void loadOptions(e.target.value);
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
                value={rule.projectId}
                disabled={detailLoading}
                onChange={(e) => setRule({ ...rule, projectId: e.target.value })}
              />
            )}
          </div>
          <button type="button" onClick={loadProjects} disabled={busy} style={{ marginTop: 22, whiteSpace: "nowrap" }}>
            {busy ? "…" : "↻ 刷新项目列表"}
          </button>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="col">目标列</label>
            {options && options.columns.length > 0 ? (
              <select
                id="col"
                value={rule.columnId}
                disabled={detailLoading}
                onChange={(e) => {
                  const hit = options.columns.find((c) => c.id === e.target.value);
                  setRule({ ...rule, columnId: e.target.value, columnSlug: hit?.slug ?? "" });
                }}
              >
                <option value="">— 选择列 —</option>
                {options.columns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}（{c.slug}）
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="col"
                value={rule.columnSlug}
                disabled={detailLoading}
                onChange={(e) => setRule({ ...rule, columnSlug: e.target.value })}
              />
            )}
          </div>
          <button
            type="button"
            onClick={() => void loadOptions(rule.projectId)}
            disabled={busy || !rule.projectId}
            style={{ marginTop: 22 }}
          >
            加载列 / 标签 / 成员
          </button>
        </div>

        {optionsError && <p className="err">{optionsError}</p>}

        {options && (
          <div className="row" style={{ alignItems: "flex-start" }}>
            <div className="field" style={{ flex: 2 }}>
              <span className="muted">工作区标签（至少选一个）</span>
              <div className="row" style={{ flexWrap: "wrap" }}>
                {options.labels.map((l) => (
                  <label key={l.id} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={rule.labelIds.includes(l.id)}
                      disabled={detailLoading}
                      onChange={(e) =>
                        setRule({
                          ...rule,
                          labelIds: e.target.checked
                            ? [...rule.labelIds, l.id]
                            : rule.labelIds.filter((x) => x !== l.id),
                        })
                      }
                    />
                    {l.name}
                  </label>
                ))}
                {options.labels.length === 0 && <span className="muted">该项目工作区没有可用标签</span>}
              </div>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="as">负责人（可选）</label>
              <select
                id="as"
                value={rule.assigneeId}
                onChange={(e) => setRule({ ...rule, assigneeId: e.target.value })}
              >
                <option value="">— 不指定 —</option>
                {options.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="row">
          <button type="button" className="primary" onClick={save} disabled={busy}>
            {draft.id ? "保存配置（不触发归档）" : "创建"}
          </button>
          {selected && (
            <button type="button" onClick={() => void enableAuto(selected)} disabled={busy}>
              启用自动归档并处理积压
            </button>
          )}
          {draft.id && (
            <button
              type="button"
              onClick={() => {
                setDraft(empty);
                setRule(emptyRule);
                setColumns([]);
                setSelected(null);
                setSources([]);
                setOptions(null);
              }}
            >
              取消编辑
            </button>
          )}
        </div>
        {columns.length > 0 && <p className="muted">项目共 {columns.length} 列（已通过连接测试）</p>}
      </div>
    </div>
  );
}
