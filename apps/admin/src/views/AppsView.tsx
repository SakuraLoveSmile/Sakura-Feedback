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
import { ConfirmDialog, EmptyState, Field, Icon, InlineError, useToast } from "../ui.tsx";

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

function archiveModeText(a: AppItem): string {
  return a.archiveMode === "automatic" ? "自动同步" : "人工同步";
}

export default function AppsView() {
  const toast = useToast();
  const [apps, setApps] = useState<AppItem[]>([]);
  const [draft, setDraft] = useState<Draft>(empty);
  const [rule, setRule] = useState<RuleDraft>(emptyRule);
  const [columns, setColumns] = useState<{ slug: string; name: string }[]>([]);
  const [projects, setProjects] = useState<{ id: string; workspaceId: string; name: string; slug: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<
    { kind: "enable"; app: AppItem } | { kind: "disable"; app: AppItem } | { kind: "remove"; app: AppItem } | null
  >(null);
  const [busy, setBusy] = useState(false);
  /** 正在读取软件详情：期间禁用规则编辑器，避免迟到的详情回写覆盖用户刚做的选择。 */
  const [detailLoading, setDetailLoading] = useState(false);
  /** 删除进行中的软件 id：期间所有删除按钮禁用（防重复点击/并发删除）。 */
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /**
   * 详情读取序号：删除软件后自增，使在途的详情响应失效——
   * 迟到的响应不得把已删软件重新写回详情面板。
   */
  const detailSeq = useRef(0);
  /** openDetail 在途请求计数：与 detailSeq 独立——响应被作废时加载态也要正确归位。 */
  const detailLoadingCount = useRef(0);

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
    const seq = ++detailSeq.current;
    const d = await api.get<AppDetail>(`/api/admin/apps/${appId}`);
    if (seq !== detailSeq.current) return null; // 删除/切换后的迟到响应直接丢弃
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
      const seq = ++detailSeq.current;
      setError(null);
      setColumns([]);
      // 加载期间禁用规则编辑器：详情回写不会覆盖管理员已经做出的选择。
      // 计数而非按序号复位：删除/其他刷新把本次响应作废时，detailLoading 也必须归位。
      detailLoadingCount.current += 1;
      setDetailLoading(true);
      try {
        const detail = await api.get<AppDetail>(`/api/admin/apps/${app.id}`);
        if (seq !== detailSeq.current) return; // 删除/切换后的迟到响应直接丢弃
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
        if (seq !== detailSeq.current) return;
        setError(err instanceof ApiError ? err.message : "读取软件详情失败");
      } finally {
        detailLoadingCount.current -= 1;
        if (detailLoadingCount.current === 0) setDetailLoading(false);
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
        toast("ok", `已加载 ${r.projects?.length ?? 0} 个项目`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "项目列表请求失败");
    } finally {
      setBusy(false);
    }
  }, [toast]);

  useEffect(() => {
    void load().catch((e) => setError(e instanceof ApiError ? e.message : "加载失败"));
    void loadProjects();
  }, [load, loadProjects]);

  /** 普通保存：写名称/来源/默认目标，**不触发归档**。必须带页面读到的规则版本。 */
  async function save() {
    setBusy(true);
    setError(null);
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
        toast(
          "ok",
          updated?.ruleComplete
            ? "已保存（普通保存不会触发同步）。规则已完整，可点「启用自动同步并处理积压」。"
            : "已保存（普通保存不会触发同步）。规则尚不完整：需要项目、目标列与至少一个工作区标签。",
        );
      } else {
        setDraft(empty);
        setRule(emptyRule);
        setColumns([]);
        setSelected(null);
        setSources([]);
        setOptions(null);
        toast("ok", `已保存（共 ${list.length} 个软件）；普通保存不会触发同步`);
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
    try {
      const r = await api.post<KaneoTestResult>("/api/admin/connection/kaneo/test", { projectId });
      if (!r.ok) {
        setError(`连接/项目校验失败：${r.reason ?? "未知原因"}`);
        setColumns([]);
      } else {
        setColumns(r.columns ?? []);
        toast("ok", `项目「${r.project?.name}」连通，共 ${r.columns?.length} 列`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "测试失败");
    } finally {
      setBusy(false);
    }
  }

  /** 明确启用自动同步并处理积压（与“普通保存”是两个独立动作）。 */
  async function enableAuto(app: AppItem) {
    if (!app.ruleComplete) {
      setError("自动同步规则不完整：请先选择项目、目标列与至少一个工作区标签（点“配置”并保存）");
      return;
    }
    setConfirmState({ kind: "enable", app });
  }

  async function doEnableAuto(app: AppItem) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ ok: boolean; replayed: boolean }>(`/api/admin/apps/${app.id}/auto-archive/enable`, {
        expectedRuleVersion: app.ruleVersion,
        operationId: operationKey(`enable:${app.id}`),
      });
      confirmOps.current.delete(`enable:${app.id}`);
      await load();
      if (selected?.id === app.id) await loadDetail(app.id);
      toast("ok", r.replayed ? "该操作已执行过（幂等返回），未重复处理积压" : "已启用自动同步，正在补处理积压");
    } catch (err) {
      await reportWriteFailure(err, app.id, "启用失败");
    } finally {
      setBusy(false);
    }
  }

  async function disableAuto(app: AppItem) {
    setConfirmState({ kind: "disable", app });
  }

  async function doDisableAuto(app: AppItem) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/admin/apps/${app.id}/auto-archive/disable`, {
        expectedRuleVersion: app.ruleVersion,
        operationId: operationKey(`disable:${app.id}`),
      });
      confirmOps.current.delete(`disable:${app.id}`);
      await load();
      if (selected?.id === app.id) await loadDetail(app.id);
      toast("ok", "已关闭自动同步：已授权的任务继续执行");
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
      toast(
        "ok",
        r.alreadyConfirmed
          ? "该来源此前已确认"
          : r.replayed
            ? "该确认操作已执行过（幂等返回）"
            : r.backlogDispatched
              ? "已确认来源，正在自动补处理该来源的积压反馈"
              : "已确认来源。当前仍是人工同步模式：需要点「启用自动同步并处理积压」后才会自动处理",
      );
    } catch (err) {
      await reportWriteFailure(err, app.id, "确认来源失败");
    } finally {
      setBusy(false);
    }
  }

  /**
   * 删除软件（T4/T5）：软删除——历史反馈、截图与日志全部保留；
   * 该 appId 再次提交反馈时会以全新配置重新出现。
   * 流程：确认 → 进行中禁用删除按钮（防重复点击）→ 失败给出可重试的错误提示；
   * 成功但列表刷新失败与删除失败分开提示；先使在途详情响应失效再乐观移除行。
   */
  async function remove(app: AppItem) {
    if (deletingId) return; // 已有删除进行中：忽略重复点击
    setConfirmState({ kind: "remove", app });
  }

  async function doRemove(app: AppItem) {
    setDeletingId(app.id);
    setError(null);
    try {
      await api.del(`/api/admin/apps/${app.id}`);
    } catch (err) {
      setError(`删除失败：${err instanceof ApiError ? err.message : "请求失败"}（可重试）`);
      setDeletingId(null);
      return;
    }
    // 删除已成功：先使在途详情响应失效，再关闭对应详情并乐观移除列表行
    detailSeq.current++;
    if (selected?.id === app.id) {
      setSelected(null);
      setSources([]);
      setOptions(null);
    }
    if (draft.id === app.id) {
      setDraft(empty);
      setRule(emptyRule);
    }
    setApps((prev) => prev.filter((a) => a.id !== app.id));
    setDeletingId(null);
    try {
      await load();
      toast("ok", `已删除「${app.name}」：历史反馈与附件保留；该 appId 再次提交时会重新出现。`);
    } catch {
      toast("info", `已删除「${app.name}」，但列表刷新失败，请手动刷新页面确认。`);
    }
  }

  const pendingTotal = apps.filter((a) => a.configStatus === "pending").length;
  const pendingSourceTotal = apps.reduce((n, a) => n + a.pendingSources, 0);
  const waitingTotal = apps.reduce((n, a) => n + a.waitingFeedbacks, 0);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>软件配置</h1>
          <div className="sub">
            待配置软件 <b>{pendingTotal}</b> 个 · 待确认来源 <b>{pendingSourceTotal}</b> 条 · 等待同步反馈{" "}
            <b>{waitingTotal}</b> 条
          </div>
        </div>
      </div>
      {error && <InlineError message={error} />}

      <div className="table-wrap">
        {apps.length === 0 ? (
          <EmptyState title="还没有软件配置" hint="组件首次提交反馈后会自动出现在这里，也可以手动新增。" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>appId</th>
                <th>状态</th>
                <th>同步方式</th>
                <th>来源（待确认/已确认）</th>
                <th>等待反馈</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>
                    <code className="wrap-anywhere">{a.appId}</code>
                  </td>
                  <td>
                    {a.configStatus === "pending" ? (
                      <span className="tag tone-warn">待配置</span>
                    ) : (
                      <span className="tag archived">已配置</span>
                    )}
                    {a.configStatus === "pending" && <div className="muted small">自动发现</div>}
                  </td>
                  <td>
                    {archiveModeText(a)}
                    {a.archiveMode === "automatic" && !a.ruleComplete && <div className="err small">规则不完整</div>}
                    <div className="muted small">规则 v{a.ruleVersion}</div>
                  </td>
                  <td>
                    <b>{a.pendingSources}</b> / {a.confirmedSources}
                  </td>
                  <td>{a.waitingFeedbacks}</td>
                  <td>
                    <div className="row" style={{ gap: "var(--sp-2)", flexWrap: "wrap" }}>
                      <button type="button" className="btn sm" onClick={() => void openDetail(a)}>
                        配置
                      </button>
                      {a.archiveMode === "automatic" ? (
                        <button type="button" className="btn sm" onClick={() => disableAuto(a)} disabled={busy}>
                          关闭自动同步
                        </button>
                      ) : (
                        <button type="button" className="btn sm" onClick={() => enableAuto(a)} disabled={busy}>
                          启用自动同步
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn sm danger"
                        onClick={() => void remove(a)}
                        disabled={busy || deletingId !== null}
                      >
                        {deletingId === a.id ? "删除中…" : "删除"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <div className="card">
          <h2>来源确认：{selected.name}</h2>
          <p className="muted">
            服务端按请求 Origin 逐条记录来源；无 Origin 的原生客户端记为 <code>native</code>
            。待确认来源不会自动同步，确认后由扫描自动补处理。
          </p>
          <div className="table-wrap" style={{ border: "none", borderRadius: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>来源</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>最近出现</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.origin}>
                    <td>
                      <code className="wrap-anywhere">{s.origin}</code>
                    </td>
                    <td>{s.kind === "native" ? "原生客户端" : "浏览器"}</td>
                    <td>
                      {s.status === "confirmed" ? (
                        <span className="tag archived">已确认</span>
                      ) : (
                        <span className="tag tone-warn">待确认</span>
                      )}
                    </td>
                    <td className="muted">{s.lastSeenAt}</td>
                    <td>
                      {s.status === "pending" ? (
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => void confirmSource(selected, s.origin)}
                          disabled={busy}
                        >
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
                    <td colSpan={5}>
                      <EmptyState title="还没有观察到任何来源" hint="组件提交后自动登记。" />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <h2>{draft.id ? `配置：${draft.name}` : "新增软件"}</h2>
        <div className="fields-2col">
          <Field id="an" label="名称">
            {(ctl) => (
              <input {...ctl} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            )}
          </Field>
          <Field id="ai2" label="appId（创建后不可改）">
            {(ctl) => (
              <input
                {...ctl}
                value={draft.appId}
                disabled={Boolean(draft.id)}
                onChange={(e) => setDraft({ ...draft, appId: e.target.value })}
              />
            )}
          </Field>
        </div>
        <Field id="orig" label="允许的 Web 来源（每行一个 origin；此处登记的来源直接视为已确认）">
          {(ctl) => (
            <textarea
              {...ctl}
              rows={2}
              value={draft.originsText}
              onChange={(e) => setDraft({ ...draft, originsText: e.target.value })}
            />
          )}
        </Field>

        <h3 style={{ marginTop: "var(--sp-2)" }}>默认同步目标（自动同步规则）</h3>
        <div className="row row-wrap" style={{ alignItems: "flex-start" }}>
          <div style={{ flex: 1 }}>
            <Field id="pid" label={<>Kaneo 项目 {projects.length > 0 ? "（从实例加载）" : "id"}</>}>
              {(ctl) =>
                projects.length > 0 ? (
                  <select
                    {...ctl}
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
                    {...ctl}
                    value={rule.projectId}
                    disabled={detailLoading}
                    onChange={(e) => setRule({ ...rule, projectId: e.target.value })}
                  />
                )
              }
            </Field>
          </div>
          <button
            type="button"
            className="btn"
            onClick={loadProjects}
            disabled={busy}
            style={{ marginTop: 22, whiteSpace: "nowrap" }}
          >
            <Icon name="refresh" size={16} />
            {busy ? "加载中…" : "刷新项目列表"}
          </button>
          <div style={{ flex: 1 }}>
            <Field id="col" label="目标列">
              {(ctl) =>
                options && options.columns.length > 0 ? (
                  <select
                    {...ctl}
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
                    {...ctl}
                    value={rule.columnSlug}
                    disabled={detailLoading}
                    onChange={(e) => setRule({ ...rule, columnSlug: e.target.value })}
                  />
                )
              }
            </Field>
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => void loadOptions(rule.projectId)}
            disabled={busy || !rule.projectId}
            style={{ marginTop: 22 }}
          >
            加载列 / 标签 / 成员
          </button>
        </div>

        {optionsError && <InlineError message={optionsError} onRetry={() => void loadOptions(rule.projectId)} />}

        {options && (
          <div className="row row-wrap" style={{ alignItems: "flex-start" }}>
            <div className="field" style={{ flex: 2 }}>
              <span className="muted">工作区标签（至少选一个）</span>
              <div className="label-picker">
                {options.labels.map((l) => (
                  <label key={l.id}>
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
            <div style={{ flex: 1 }}>
              <Field id="as" label="负责人（可选）">
                {(ctl) => (
                  <select
                    {...ctl}
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
                )}
              </Field>
            </div>
          </div>
        )}

        <div className="btn-row">
          <button type="button" className="btn primary" onClick={save} disabled={busy}>
            {draft.id ? "保存配置（不触发同步）" : "创建"}
          </button>
          {selected && (
            <button type="button" className="btn" onClick={() => enableAuto(selected)} disabled={busy}>
              启用自动同步并处理积压
            </button>
          )}
          {draft.id && (
            <button
              type="button"
              className="btn"
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

      {confirmState?.kind === "enable" && (
        <ConfirmDialog
          title={`启用「${confirmState.app.name}」的自动同步？`}
          body={<p>启用后立即开始处理该软件的积压反馈，按当前规则同步到 Kaneo。</p>}
          confirmLabel="启用并处理积压"
          onClose={() => setConfirmState(null)}
          onConfirm={() => {
            const app = confirmState.app;
            setConfirmState(null);
            void doEnableAuto(app);
          }}
        />
      )}
      {confirmState?.kind === "disable" && (
        <ConfirmDialog
          title={`关闭「${confirmState.app.name}」的自动同步？`}
          body={<p>已授权的任务会继续执行，只阻止新的自动授权。</p>}
          confirmLabel="关闭自动同步"
          onClose={() => setConfirmState(null)}
          onConfirm={() => {
            const app = confirmState.app;
            setConfirmState(null);
            void doDisableAuto(app);
          }}
        />
      )}
      {confirmState?.kind === "remove" && (
        <ConfirmDialog
          title={`删除软件「${confirmState.app.name}」？`}
          body={
            <>
              <p>
                <code className="wrap-anywhere">{confirmState.app.appId}</code>
              </p>
              <p>历史反馈、截图与日志全部保留；该 appId 再次提交反馈时会以全新的待配置记录重新出现。</p>
            </>
          }
          confirmLabel="删除软件"
          danger
          onClose={() => setConfirmState(null)}
          onConfirm={() => {
            const app = confirmState.app;
            setConfirmState(null);
            void doRemove(app);
          }}
        />
      )}
    </div>
  );
}
