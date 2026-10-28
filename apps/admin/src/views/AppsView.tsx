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

/**
 * 表单快照：同时是 dirty 判定的基准单元与冲突比较的「编辑基准」内容——
 * 普通 GET 只刷新 serverSnapshot，绝不回写草稿或基准。
 */
interface FormSnapshot {
  draft: Draft;
  rule: RuleDraft;
}

const emptySnapshot: FormSnapshot = { draft: empty, rule: emptyRule };

type EditAction = { kind: "open"; appId: string } | { kind: "new" } | { kind: "reset" };

/** 快照语义相等：labelIds 按集合比较（勾选顺序不影响规则内容）。 */
function sameForm(a: FormSnapshot, b: FormSnapshot): boolean {
  const labels = (ids: string[]) => [...ids].sort().join("\n");
  return (
    a.draft.id === b.draft.id &&
    a.draft.appId === b.draft.appId &&
    a.draft.name === b.draft.name &&
    a.draft.originsText === b.draft.originsText &&
    a.draft.kaneoProjectId === b.draft.kaneoProjectId &&
    a.draft.kaneoColumnSlug === b.draft.kaneoColumnSlug &&
    a.rule.projectId === b.rule.projectId &&
    a.rule.columnId === b.rule.columnId &&
    a.rule.columnSlug === b.rule.columnSlug &&
    a.rule.assigneeId === b.rule.assigneeId &&
    labels(a.rule.labelIds) === labels(b.rule.labelIds)
  );
}

/** 表单草稿按服务端字段归一：origins 逐行 trim、去空行；labelIds 拷贝。 */
function normalizeForm(f: FormSnapshot): FormSnapshot {
  return {
    draft: {
      ...f.draft,
      originsText: f.draft.originsText
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join("\n"),
    },
    rule: { ...f.rule, labelIds: [...f.rule.labelIds] },
  };
}

/** AppItem → 表单快照（服务端值是「已保存/最新保存」的序列化形态）。 */
function formFromApp(app: AppItem): FormSnapshot {
  return {
    draft: {
      id: app.id,
      appId: app.appId,
      name: app.name,
      originsText: app.allowedOrigins.join("\n"),
      kaneoProjectId: app.defaults.projectId,
      kaneoColumnSlug: app.defaults.columnSlug,
    },
    rule: {
      projectId: app.defaults.projectId,
      columnId: app.defaults.columnId,
      columnSlug: app.defaults.columnSlug,
      labelIds: [...app.defaults.labelIds],
      assigneeId: app.defaults.assigneeId ?? "",
    },
  };
}

/** 来源集合规范化比较：trim、去空、排序后相等（只比较，不自动合并集合）。 */
function originsKey(text: string): string {
  return text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()
    .join("\n");
}

/** 标签集合规范化比较（id 排序）。 */
function labelsKey(ids: string[]): string {
  return [...ids].sort().join("\n");
}

/** 默认同步目标原子组：项目/列/标签/负责人必须整体取同一方，防止组合出无效目标。 */
interface TargetValue {
  projectId: string;
  columnId: string;
  columnSlug: string;
  labelIds: string[];
  assigneeId: string;
}

function targetFrom(f: FormSnapshot): TargetValue {
  return {
    projectId: f.rule.projectId || f.draft.kaneoProjectId,
    columnId: f.rule.columnId,
    columnSlug: f.rule.columnSlug || f.draft.kaneoColumnSlug,
    labelIds: [...f.rule.labelIds],
    assigneeId: f.rule.assigneeId,
  };
}

function targetKey(t: TargetValue): string {
  return [t.projectId, t.columnId, t.columnSlug, labelsKey(t.labelIds), t.assigneeId].join(" ");
}

type GroupKey = "name" | "origins" | "target";
type ConflictSide = "mine" | "theirs";
/** auto-mine=仅我方修改；auto-theirs=仅对方修改；same=双方一致；needsChoice=双方都改且不同。 */
type RowState = "auto-mine" | "auto-theirs" | "same" | "needsChoice";

interface ResolvedGroup {
  state: RowState;
  /** needsChoice 时由用户在比较区选择；其余情况 side 指明自动采用方。 */
  side: ConflictSide | null;
}

function resolveGroup(base: string, mine: string, theirs: string): ResolvedGroup {
  const mineChanged = mine !== base;
  const theirsChanged = theirs !== base;
  if (!mineChanged && !theirsChanged) return { state: "same", side: "mine" };
  if (!mineChanged) return { state: "auto-theirs", side: "theirs" };
  if (!theirsChanged) return { state: "auto-mine", side: "mine" };
  if (mine === theirs) return { state: "same", side: "mine" };
  return { state: "needsChoice", side: null };
}

interface CompareRow {
  key: GroupKey;
  title: string;
  state: RowState;
  mine: string[];
  theirs: string[];
}

function archiveModeText(a: AppItem): string {
  return a.archiveMode === "automatic" ? "自动同步" : "人工同步";
}

/** 冻结规格：fieldset/legend 去掉浏览器默认边框，组标题 16px/24px。 */
const fieldsetStyle = { border: 0, margin: 0, padding: 0, minWidth: 0 } as const;
const fieldsetDividedStyle = {
  border: 0,
  borderTop: "1px solid var(--border-subtle)",
  margin: "var(--sp-3) 0 0",
  padding: "var(--sp-3) 0 0",
  minWidth: 0,
} as const;
const legendStyle = {
  fontSize: 16,
  lineHeight: "24px",
  fontWeight: 600,
  padding: 0,
  marginBottom: "var(--sp-2)",
} as const;
/** 比较区取值块：subtle 底 + 8px 圆角，长值换行。 */
const valueBoxStyle = {
  background: "var(--subtle)",
  borderRadius: "var(--radius-ctl)",
  padding: "var(--sp-2) var(--sp-3)",
  fontSize: 14,
  lineHeight: "22px",
  overflowWrap: "anywhere",
  minWidth: 0,
} as const;

export default function AppsView() {
  const toast = useToast();
  const [apps, setApps] = useState<AppItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const listSeq = useRef(0);
  /**
   * 状态三分离：
   * - form  = 当前草稿（draft + rule），输入控件唯一写入点；
   * - editBase = 编辑基准（最近一次载入/应用比较/保存成功的快照 + 其 ruleVersion），
   *   保存的 expectedRuleVersion 永远取自它；
   * - serverSnapshot = 最近一次详情 GET 的服务端值，只读参照，绝不回填表单。
   */
  const [form, setFormState] = useState<FormSnapshot>(emptySnapshot);
  const [editBase, setEditBase] = useState<{ ruleVersion: number; form: FormSnapshot } | null>(null);
  const [serverSnapshot, setServerSnapshot] = useState<FormSnapshot | null>(null);
  const [columns, setColumns] = useState<{ slug: string; name: string }[]>([]);
  const [projects, setProjects] = useState<{ id: string; workspaceId: string; name: string; slug: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<
    | { kind: "enable"; app: AppItem }
    | { kind: "disable"; app: AppItem }
    | { kind: "remove"; app: AppItem }
    | { kind: "discard"; action: EditAction; generation: number }
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  /** 正在读取软件详情：期间禁用规则编辑器，避免迟到的详情回写覆盖用户刚做的选择。 */
  const [detailLoading, setDetailLoading] = useState(false);
  /** 删除进行中的软件 id：期间所有删除按钮禁用（防重复点击/并发删除）。 */
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /**
   * 详情读取序号：删除/切换/更新请求后自增，使在途的旧响应失效——
   * 迟到的响应不得把旧对象写回详情面板或服务器快照。
   */
  const detailSeq = useRef(0);
  /** 详情在途请求计数：与 detailSeq 独立——响应被作废时加载态也要正确归位。 */
  const detailLoadingCount = useRef(0);
  /**
   * 表单镜像 ref + 编辑代次（generation）：异步写/读响应到达时据此判定
   * 「提交的内容是否仍是当前草稿」——写期间的新编辑保留为未保存，不被响应覆盖。
   * setForm/patch* 同步维护 ref（ref 为权威最新值），不依赖 effect 刷新时序。
   */
  const formRef = useRef<FormSnapshot>(form);
  const editGen = useRef(0);

  // 详情面板：来源列表与规则选项
  const [selected, setSelected] = useState<AppItem | null>(null);
  const [sources, setSources] = useState<AppSourceItem[]>([]);
  const [options, setOptions] = useState<ClassifyOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  /** 目标列连接/项目校验错误：贴近「默认同步目标」字段回显，点重试即重测。 */
  const [targetError, setTargetError] = useState<string | null>(null);
  /** 选项请求序号：切换项目后丢弃迟到响应，避免把旧项目的列/标签写进规则。 */
  const optionsSeq = useRef(0);
  /**
   * 来源确认的稳定操作幂等键：同一次点击（含失败后的重试）复用同一个键，
   * 网络重试不会生成新键，也就不会被服务端当成第二次操作。
   */
  const confirmOps = useRef<Map<string, string>>(new Map());

  /** 本次「保存」操作进行中（busy 覆盖多种操作；saving 专供「保存中」状态判定）。 */
  const [saving, setSaving] = useState(false);
  /** 最近一次 PUT/POST 成功且回读确认后的留痕（规则版本 + 保存时间）。 */
  const [savedInfo, setSavedInfo] = useState<{ at: string; ruleVersion: number } | null>(null);
  /**
   * 表单 409 冲突状态：存在且未解决时禁止写入。
   * fetchError 表示「最新配置读取失败」——保留旧基准与草稿，仅提供重试；
   * 快照到手后 compareOpen 打开比较区并冻结表单。
   */
  const [conflict, setConflict] = useState<{
    appId: string;
    message: string;
    ruleVersion: number | null;
    savedAt: string | null;
    fetchError: string | null;
  } | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  /** needsChoice 组的用户选择：默认不选，必须明确「我的修改」或「最新保存」。 */
  const [compareChoices, setCompareChoices] = useState<Partial<Record<GroupKey, ConflictSide>>>({});
  /** 冲突比较两侧项目的只读选项；不复用当前表单项目，避免一侧名称污染另一侧。 */
  const [compareOptions, setCompareOptions] = useState<Record<string, ClassifyOptions>>({});
  const [compareOptionsError, setCompareOptionsError] = useState<string | null>(null);
  const [compareOptionsLoading, setCompareOptionsLoading] = useState(false);
  const compareOptionsSeq = useRef(0);
  /** 非表单操作（启用/关闭/确认来源）的版本冲突留痕，独立于表单冲突。 */
  const [conflictInfo, setConflictInfo] = useState<{
    message: string;
    ruleVersion: number | null;
    savedAt: string | null;
  } | null>(null);
  /** 网络/服务失败留痕（表单草稿已保留，可重试）。 */
  const [writeError, setWriteError] = useState<{ label: string; message: string } | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  /** 保存类留痕归零（新一轮载入/取消/表单重置时调用）。 */
  const clearSaveStatus = useCallback((): void => {
    setSavedInfo(null);
    setConflictInfo(null);
    setWriteError(null);
    setRefreshError(null);
  }, []);

  /** 草稿整体替换（载入/应用比较/保存成功回写）：同步 ref 并推进代次。 */
  const setForm = useCallback((f: FormSnapshot) => {
    formRef.current = f;
    editGen.current += 1;
    setFormState(f);
  }, []);

  const patchDraft = useCallback((patch: Partial<Draft>) => {
    const next: FormSnapshot = { draft: { ...formRef.current.draft, ...patch }, rule: formRef.current.rule };
    formRef.current = next;
    editGen.current += 1;
    setFormState(next);
  }, []);

  const patchRule = useCallback((patch: Partial<RuleDraft>) => {
    const next: FormSnapshot = { draft: formRef.current.draft, rule: { ...formRef.current.rule, ...patch } };
    formRef.current = next;
    editGen.current += 1;
    setFormState(next);
  }, []);

  const { draft, rule } = form;

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
    const seq = ++listSeq.current;
    setListLoading(true);
    setListError(null);
    try {
      const r = await api.get<{ apps: AppItem[] }>("/api/admin/apps");
      if (seq === listSeq.current) setApps(r.apps);
      return r.apps;
    } catch (err) {
      if (seq === listSeq.current) setListError(err instanceof ApiError ? err.message : "读取软件列表失败");
      throw err;
    } finally {
      if (seq === listSeq.current) setListLoading(false);
    }
  }, []);

  /**
   * GET-only 详情刷新：只更新 serverSnapshot（以及对应的 selected/sources 展示）。
   * force=false（默认）时仅当响应对象仍是表单正在编辑的对象才回写展示态；
   * 绝不触碰 draft/rule/editBase——保存后回读、重试刷新都走这条路。
   */
  const fetchDetail = useCallback(async (appId: string, force = false): Promise<AppItem | null> => {
    const seq = ++detailSeq.current;
    const d = await api.get<AppDetail>(`/api/admin/apps/${appId}`);
    if (seq !== detailSeq.current) return null; // 删除/切换/更新请求后的迟到响应直接丢弃
    setServerSnapshot(formFromApp(d.app));
    if (force || formRef.current.draft.id === appId) {
      setSelected(d.app);
      setSources(d.sources);
    }
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

  const loadCompareOptions = useCallback(async (mine: FormSnapshot, theirs: FormSnapshot) => {
    const seq = ++compareOptionsSeq.current;
    const projectIds = [...new Set([targetFrom(mine).projectId, targetFrom(theirs).projectId].filter(Boolean))];
    setCompareOptionsError(null);
    setCompareOptionsLoading(projectIds.length > 0);
    if (projectIds.length === 0) {
      setCompareOptions({});
      setCompareOptionsLoading(false);
      return;
    }
    const results = await Promise.all(
      projectIds.map(async (projectId) => {
        try {
          return {
            projectId,
            options: await api.get<ClassifyOptions>(
              `/api/admin/feedback/options?projectId=${encodeURIComponent(projectId)}`,
            ),
          };
        } catch (err) {
          return { projectId, error: err instanceof ApiError ? err.message : "读取 Kaneo 选项失败" };
        }
      }),
    );
    if (seq !== compareOptionsSeq.current) return;
    const loaded: Record<string, ClassifyOptions> = {};
    const errors: string[] = [];
    for (const result of results) {
      if (result.options) loaded[result.projectId] = result.options;
      if (result.error) errors.push(`${result.projectId}：${result.error}`);
    }
    setCompareOptions(loaded);
    setCompareOptionsError(errors.length > 0 ? `冲突比较的 Kaneo 选项读取失败：${errors.join("；")}` : null);
    setCompareOptionsLoading(false);
  }, []);

  const openDetail = useCallback(
    async (appId: string): Promise<AppItem | null> => {
      const seq = ++detailSeq.current;
      const generation = editGen.current;
      setError(null);
      setTargetError(null);
      setColumns([]);
      // 加载期间禁用规则编辑器：详情回写不会覆盖管理员已经做出的选择。
      // 计数而非按序号复位：删除/其他刷新把本次响应作废时，detailLoading 也必须归位。
      detailLoadingCount.current += 1;
      setDetailLoading(true);
      try {
        const detail = await api.get<AppDetail>(`/api/admin/apps/${appId}`);
        if (seq !== detailSeq.current) return null; // 删除/切换后的迟到响应直接丢弃
        const fresh = detail.app;
        const nextForm = formFromApp(fresh);
        // 同一对象的重复 GET：只更新服务器快照与来源，不回填草稿、不换编辑基准——
        // 已有旧草稿保持原样（草稿保护：最新版本不自动替换草稿）。
        if (formRef.current.draft.id === fresh.id) {
          setServerSnapshot(nextForm);
          setSelected(fresh);
          setSources(detail.sources);
          return fresh;
        }
        if (generation !== editGen.current) return null;
        // 新编辑对象：服务端值初始化草稿、编辑基准与快照；冲突/失败留痕随新对象归零。
        setForm(nextForm);
        setEditBase({ ruleVersion: fresh.ruleVersion, form: nextForm });
        setServerSnapshot(nextForm);
        setSelected(fresh);
        setSources(detail.sources);
        setSavedInfo(null);
        setConflict(null);
        setCompareOpen(false);
        setCompareChoices({});
        compareOptionsSeq.current += 1;
        setCompareOptions({});
        setCompareOptionsError(null);
        setCompareOptionsLoading(false);
        setConflictInfo(null);
        setWriteError(null);
        setRefreshError(null);
        await loadOptions(fresh.defaults.projectId);
        return fresh;
      } catch (err) {
        if (seq !== detailSeq.current) return null;
        // 读取失败保留旧基准与草稿（不回填、不清空）。
        setError(err instanceof ApiError ? err.message : "读取软件详情失败");
        return null;
      } finally {
        detailLoadingCount.current -= 1;
        if (detailLoadingCount.current === 0) setDetailLoading(false);
      }
    },
    [loadOptions, setForm],
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
    void load().catch(() => {}); // 列表失败由独立错误区提供重试，不显示为成功空列表。
    void loadProjects();
  }, [load, loadProjects]);

  /** 重置表单/详情面板（取消编辑、删除当前对象、保存成功后收起时复用）。 */
  const resetEditing = useCallback(() => {
    detailSeq.current += 1;
    optionsSeq.current += 1;
    setForm(emptySnapshot);
    setEditBase(null);
    setServerSnapshot(null);
    setSelected(null);
    setSources([]);
    setOptions(null);
    setOptionsError(null);
    setColumns([]);
    setTargetError(null);
    setConflict(null);
    setCompareOpen(false);
    setCompareChoices({});
    compareOptionsSeq.current += 1;
    setCompareOptions({});
    setCompareOptionsError(null);
    setCompareOptionsLoading(false);
    clearSaveStatus();
  }, [setForm, clearSaveStatus]);

  /** 仅用户发起的切换/新建/取消需要草稿确认；保存成功等内部重置仍直接执行。 */
  function performEditAction(action: EditAction) {
    if (busy || saving || detailLoadingCount.current > 0 || deletingId !== null) return;
    if (action.kind === "open") {
      // 弹窗只记录目标 ID，执行时从当前列表查找，避免使用过期的软件对象。
      if (!apps.some((app) => app.id === action.appId)) {
        setError("该软件已不在当前列表中，请刷新列表后重新选择。");
        return;
      }
      void openDetail(action.appId);
      return;
    }
    resetEditing();
    if (action.kind === "new") document.getElementById("an")?.focus();
  }

  function requestEditAction(action: EditAction) {
    if (busy || saving || detailLoadingCount.current > 0 || deletingId !== null || confirmState) return;
    const changesObject = action.kind !== "open" || action.appId !== formRef.current.draft.id;
    const dirty = !sameForm(editBase?.form ?? emptySnapshot, formRef.current);
    if (changesObject && dirty) {
      setConfirmState({ kind: "discard", action, generation: editGen.current });
      return;
    }
    performEditAction(action);
  }

  /**
   * 表单 409 冲突进入「逐项对比」流程：先 GET 最新配置作为快照
   * （读取失败保留旧基准与草稿、标记 fetchError 供重试），
   * 快照到手后打开比较区并冻结表单。绝不自动重放写入——再次冲突重新比较。
   */
  const enterConflict = useCallback(
    async (appId: string, message: string) => {
      let snapshotApp: AppItem | null = null;
      let fetchError: string | null = null;
      compareOptionsSeq.current += 1;
      setCompareOptions({});
      setCompareOptionsError(null);
      setCompareOptionsLoading(false);
      // 冲突快照必须是最新：作废旧的在途详情响应，避免更旧的数据覆盖快照。
      const seq = ++detailSeq.current;
      try {
        const detail = await api.get<AppDetail>(`/api/admin/apps/${appId}`);
        if (seq !== detailSeq.current || formRef.current.draft.id !== appId) {
          // 已有更新的读取或已切换对象：本次响应不参与快照。
        } else {
          snapshotApp = detail.app;
          setServerSnapshot(formFromApp(detail.app));
          setSelected(detail.app);
          setSources(detail.sources);
        }
      } catch (err) {
        fetchError = err instanceof ApiError ? err.message : "读取最新配置失败";
      }
      // 期间已切换到其他对象/取消编辑：表单冲突不展示，仅刷新列表留痕。
      if (formRef.current.draft.id !== appId) {
        try {
          await load();
        } catch {
          /* 列表刷新失败不影响冲突留痕 */
        }
        return;
      }
      setSavedInfo(null);
      setWriteError(null);
      setConflict({
        appId,
        message,
        ruleVersion: snapshotApp?.ruleVersion ?? null,
        savedAt: snapshotApp?.updatedAt ?? null,
        fetchError,
      });
      setCompareChoices({});
      setCompareOpen(snapshotApp !== null);
      setCompareOptions({});
      setCompareOptionsError(null);
      if (snapshotApp) {
        await loadCompareOptions(formRef.current, formFromApp(snapshotApp));
      }
      try {
        await load();
      } catch {
        /* 列表刷新失败不影响冲突处理 */
      }
    },
    [load, loadCompareOptions],
  );

  /**
   * 操作类写入（启用/关闭/确认来源）的冲突：刷新列表与详情，由管理员重新确认；
   * **绝不静默重试写入**，也不回写草稿——用户正在编辑的内容原样保留。
   * 冲突对象就是表单正在编辑的对象时，把表单标记为「冲突待比较」（基准版本已过期）。
   */
  async function reportWriteFailure(err: unknown, appId: string | undefined, fallback: string): Promise<void> {
    if (err instanceof ApiError && err.code === "version_conflict") {
      let latest: AppItem | null = null;
      try {
        const list = await load();
        latest = list.find((a) => a.id === appId) ?? null;
        // 仅刷新详情展示/快照（fetchDetail 不动 draft/rule/editBase）。
        if (appId) {
          const fresh = await fetchDetail(appId, true);
          if (fresh) latest = fresh;
        }
      } catch {
        /* 刷新失败仍提示冲突本身 */
      }
      setSavedInfo(null);
      setWriteError(null);
      setConflictInfo({
        message: err.message,
        ruleVersion: latest?.ruleVersion ?? null,
        savedAt: latest?.updatedAt ?? null,
      });
      setError(`${err.message} 你的修改仍在表单中：对比最新保存版本后可再次保存。`);
      if (
        appId &&
        formRef.current.draft.id === appId &&
        editBase &&
        latest &&
        latest.ruleVersion > editBase.ruleVersion
      ) {
        setConflict(
          (prev) =>
            prev ?? {
              appId,
              message: err.message,
              ruleVersion: latest.ruleVersion,
              savedAt: latest.updatedAt ?? null,
              fetchError: null,
            },
        );
      }
      return;
    }
    const message = err instanceof ApiError ? err.message : fallback;
    setSavedInfo(null);
    setConflictInfo(null);
    setWriteError({ label: fallback, message });
    setError(message);
  }

  /**
   * 普通保存：写名称/来源/默认目标，**不触发归档**。
   * 版本号取自编辑基准（editBase.ruleVersion）；捕获提交快照 + 编辑代次 + 对象身份，
   * 写入成功采用响应版本与规范化值——写期间的新编辑保留为未保存状态。
   */
  async function save() {
    if (busy || saving || detailLoadingCount.current > 0) return;
    // 未解决冲突禁止写入：必须先逐项比较并「应用比较结果」（或取消编辑）。
    if (conflict) {
      setError("存在未解决的保存冲突：请逐项比较并应用结果后再保存。");
      return;
    }
    setBusy(true);
    setSaving(true);
    setError(null);
    // 新一次保存是用户主动行为：上一轮操作冲突/失败留痕归零。
    setConflictInfo(null);
    setWriteError(null);
    setRefreshError(null);
    const submitted = formRef.current;
    const gen = editGen.current;
    const objectId = submitted.draft.id;
    let savedApp: AppItem;
    let created = false;
    try {
      const body = {
        appId: submitted.draft.appId,
        name: submitted.draft.name,
        allowedOrigins: submitted.draft.originsText
          .split(/\n+/)
          .map((s) => s.trim())
          .filter(Boolean),
        kaneoProjectId: submitted.rule.projectId || submitted.draft.kaneoProjectId,
        kaneoColumnId: submitted.rule.columnId,
        kaneoColumnSlug: submitted.rule.columnSlug || submitted.draft.kaneoColumnSlug,
        kaneoLabelIds: submitted.rule.labelIds,
        kaneoAssigneeId: submitted.rule.assigneeId || null,
        ...(submitted.rule.assigneeId
          ? { kaneoAssigneeName: options?.members.find((m) => m.id === submitted.rule.assigneeId)?.name ?? null }
          : {}),
      };
      if (objectId) {
        // T2 版本契约：版本取自编辑基准；基准缺失或与提交对象不一致都拒绝写入。
        const expectedRuleVersion = editBase?.form.draft.id === objectId ? editBase.ruleVersion : undefined;
        if (expectedRuleVersion === undefined) {
          setError("缺少编辑基准的规则版本，请重新打开该软件的配置后重试");
          setSaving(false);
          setBusy(false);
          return;
        }
        savedApp = await api.put<AppItem>(`/api/admin/apps/${objectId}`, { ...body, expectedRuleVersion });
      } else {
        savedApp = await api.post<AppItem>("/api/admin/apps", body);
        created = true;
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "version_conflict" && objectId) {
        // 仍是同一编辑对象才进入比较；期间已切换对象则只在列表层面留痕。
        await enterConflict(objectId, err.message);
      } else {
        const message = err instanceof ApiError ? err.message : "保存失败";
        setSavedInfo(null);
        setWriteError({ label: "保存失败", message });
        setError(message);
      }
      setSaving(false);
      setBusy(false);
      return;
    }

    const savedAt = new Date().toLocaleString();
    const normalized = normalizeForm(formFromApp(savedApp));
    const stillCurrent = formRef.current.draft.id === objectId || formRef.current.draft.id === savedApp.id;
    if (stillCurrent && editGen.current === gen) {
      // 写期间无新编辑：草稿采用响应规范化值，基准前进到响应版本。
      setForm(normalized);
      setEditBase({ ruleVersion: savedApp.ruleVersion, form: normalized });
      setSelected((prev) => (prev?.id === savedApp.id ? savedApp : prev));
    } else if (stillCurrent) {
      // 写期间有新编辑：基准采用响应版本与值，草稿保留为未保存状态；
      // 创建场景必须把已分配的 id 写回草稿——下一次保存走 PUT，绝不重复创建。
      setEditBase({ ruleVersion: savedApp.ruleVersion, form: normalized });
      if (created) patchDraft({ id: savedApp.id });
      setSelected((prev) => (prev?.id === savedApp.id ? savedApp : prev));
    }
    // 已切换/清空：不回写表单（写入期间禁止切换对象，双保险）。
    setSavedInfo({ at: savedAt, ruleVersion: savedApp.ruleVersion });
    setConflictInfo(null);
    setWriteError(null);
    setRefreshError(null);

    let list: AppItem[];
    try {
      list = await load();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "列表刷新失败";
      setRefreshError(`已保存，但列表刷新失败：${message}`);
      setError(null);
      toast("info", "配置已保存，但列表刷新失败，可重试刷新");
      setSaving(false);
      setBusy(false);
      return;
    }
    try {
      if (created && formRef.current.draft.id === savedApp.id) {
        // 创建成功后回读确认；回读失败时 POST 响应已是服务端已存行的序列化，
        // 草稿保留 id（下一次保存仍是 PUT），绝不重复创建。
        try {
          const check = await api.get<AppDetail>(`/api/admin/apps/${savedApp.id}`);
          resetEditing();
          setSavedInfo({ at: savedAt, ruleVersion: check.app.ruleVersion });
          toast("ok", `已保存（共 ${list.length} 个软件）；普通保存不会触发同步`);
        } catch {
          setRefreshError("已保存，但详情回读失败；草稿已保留为已创建对象，可重试刷新或再次保存");
          toast("info", "配置已创建，但详情回读失败；草稿已保留，重试保存将更新而不是重复创建");
        }
      } else if (!created && formRef.current.draft.id === savedApp.id) {
        // 保存后 GET 回读只刷新服务器快照与来源（GET-only，不重置表单/基准）。
        const updated = list.find((a) => a.id === savedApp.id);
        try {
          await fetchDetail(savedApp.id, true);
        } catch {
          setRefreshError("已保存，但详情刷新失败，可重试刷新");
        }
        toast(
          "ok",
          updated?.ruleComplete
            ? "已保存（普通保存不会触发同步）。规则已完整，可点「启用自动同步并处理积压」。"
            : "已保存（普通保存不会触发同步）。规则尚不完整：需要项目、目标列与至少一个工作区标签。",
        );
      }
    } finally {
      setSaving(false);
      setBusy(false);
    }
  }

  /** 「重试刷新」：GET-only——只刷新列表与服务器快照/来源，绝不调用会重置表单的载入流程。 */
  async function retrySaveRefresh() {
    setBusy(true);
    try {
      const list = await load();
      const currentId = formRef.current.draft.id;
      if (currentId) {
        const updated = list.find((a) => a.id === currentId);
        if (!updated) throw new Error("保存的配置暂未出现在列表中");
        await fetchDetail(currentId, true);
      }
      setRefreshError(null);
      setError(null);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "列表刷新失败";
      setRefreshError(`已保存，但刷新仍失败：${message}`);
    } finally {
      setBusy(false);
    }
  }

  async function testProjectWith(projectId: string) {
    setTargetError(null);
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<KaneoTestResult>("/api/admin/connection/kaneo/test", { projectId });
      if (!r.ok) {
        setTargetError(`连接/项目校验失败：${r.reason ?? "未知原因"}`);
        setColumns([]);
      } else {
        setColumns(r.columns ?? []);
        toast("ok", `项目「${r.project?.name}」连通，共 ${r.columns?.length} 列`);
      }
    } catch (err) {
      setTargetError(err instanceof ApiError ? err.message : "测试失败");
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
      if (selected?.id === app.id) await fetchDetail(app.id, true);
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
      if (selected?.id === app.id) await fetchDetail(app.id, true);
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
      await fetchDetail(app.id, true);
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
    if (formRef.current.draft.id === app.id) {
      resetEditing();
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

  // —— 规则保存状态摘要：dirty 以编辑基准判定（当前草稿 vs 基准快照），
  //    规则缺项与「来源待确认」分开表述 ——
  const formDirty = editBase ? !sameForm(editBase.form, form) : !sameForm(emptySnapshot, form);
  const effectiveProjectId = rule.projectId || draft.kaneoProjectId;
  const missingRule: string[] = [];
  if (!effectiveProjectId) missingRule.push("缺 Kaneo 项目");
  if (!rule.columnId) missingRule.push("缺目标列 ID");
  if (rule.labelIds.length === 0) missingRule.push("缺至少一个工作区标签");
  const pendingSourceCount = sources.filter((s) => s.status === "pending").length;

  // —— 冲突比较：三组（名称 / 允许来源 / 默认同步目标），基准 = editBase.form ——
  const baseForm = editBase?.form ?? emptySnapshot;
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "";

  function compareProjectName(id: string): string {
    return compareOptions[id]?.project.name || projectName(id);
  }

  function compareTargetLines(t: TargetValue): string[] {
    const selected = t.projectId ? compareOptions[t.projectId] : undefined;
    const project = t.projectId ? `${compareProjectName(t.projectId) || "不可用"}（id:${t.projectId}）` : "（未选择）";
    const column =
      t.columnId || t.columnSlug
        ? (() => {
            const match = selected?.columns.find((c) => c.id === t.columnId || c.slug === t.columnSlug);
            if (!match) return `不可用（id:${t.columnId || "—"}，slug:${t.columnSlug || "—"}）`;
            return `${match.name}（slug:${match.slug}，id:${match.id}）`;
          })()
        : "（未选择）";
    const labels =
      t.labelIds.length > 0
        ? t.labelIds
            .map((id) => {
              const match = selected?.labels.find((label) => label.id === id);
              return match ? `${match.name}（id:${id}）` : `不可用（id:${id}）`;
            })
            .join("、")
        : "（无标签）";
    const assignee = t.assigneeId
      ? (() => {
          const match = selected?.members.find((member) => member.id === t.assigneeId);
          return match ? `${match.name}（id:${t.assigneeId}）` : `不可用（id:${t.assigneeId}）`;
        })()
      : "— 不指定 —";
    return [`项目：${project}`, `目标列：${column}`, `标签：${labels}`, `负责人：${assignee}`];
  }

  function originsLines(text: string): string[] {
    const lines = Array.from(
      new Set(
        text
          .split(/\n+/)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    );
    return lines.length > 0 ? lines : ["（无来源）"];
  }

  function targetLines(t: TargetValue): string[] {
    return compareTargetLines(t);
  }

  function targetNeedsExplicitChoice(t: TargetValue): boolean {
    if (!t.projectId) return false;
    const selected = compareOptions[t.projectId];
    if (!selected || compareOptionsLoading || compareOptionsError) return true;
    if (t.columnId && !selected.columns.some((column) => column.id === t.columnId || column.slug === t.columnSlug)) {
      return true;
    }
    if (t.labelIds.some((id) => !selected.labels.some((label) => label.id === id))) return true;
    return Boolean(t.assigneeId && !selected.members.some((member) => member.id === t.assigneeId));
  }

  /** 三组比较行：mine=当前草稿（含冲突后继续的编辑），theirs=服务器快照。 */
  function buildCompareRows(): CompareRow[] {
    if (!conflict || !serverSnapshot) return [];
    const mineTarget = targetFrom(form);
    const theirsTarget = targetFrom(serverSnapshot);
    const targetState = resolveGroup(
      targetKey(targetFrom(baseForm)),
      targetKey(mineTarget),
      targetKey(theirsTarget),
    ).state;
    return [
      {
        key: "name",
        title: "软件名称",
        state: resolveGroup(baseForm.draft.name, form.draft.name, serverSnapshot.draft.name).state,
        mine: [form.draft.name || "（空）"],
        theirs: [serverSnapshot.draft.name || "（空）"],
      },
      {
        key: "origins",
        title: "允许来源",
        state: resolveGroup(
          originsKey(baseForm.draft.originsText),
          originsKey(form.draft.originsText),
          originsKey(serverSnapshot.draft.originsText),
        ).state,
        mine: originsLines(form.draft.originsText),
        theirs: originsLines(serverSnapshot.draft.originsText),
      },
      {
        key: "target",
        title: "默认同步目标",
        state:
          targetNeedsExplicitChoice(mineTarget) || targetNeedsExplicitChoice(theirsTarget)
            ? "needsChoice"
            : targetState,
        mine: targetLines(mineTarget),
        theirs: targetLines(theirsTarget),
      },
    ];
  }

  const compareRows = buildCompareRows();
  const allResolved =
    !compareOptionsLoading &&
    !compareOptionsError &&
    compareRows.every((r) => r.state !== "needsChoice" || compareChoices[r.key]);

  /**
   * 应用比较结果：只更新草稿与编辑基准（基准前进到最新保存快照及其版本），
   * 表单解冻回到可编辑状态；真正的 PUT 仍由「保存配置」触发。
   */
  function applyCompare() {
    if (!conflict || !serverSnapshot || !editBase || !allResolved) return;
    const nameR = resolveGroup(baseForm.draft.name, form.draft.name, serverSnapshot.draft.name);
    const originsR = resolveGroup(
      originsKey(baseForm.draft.originsText),
      originsKey(form.draft.originsText),
      originsKey(serverSnapshot.draft.originsText),
    );
    const targetR = resolveGroup(
      targetKey(targetFrom(baseForm)),
      targetKey(targetFrom(form)),
      targetKey(targetFrom(serverSnapshot)),
    );
    const nameSide = nameR.state === "needsChoice" ? compareChoices.name : nameR.side;
    const originsSide = originsR.state === "needsChoice" ? compareChoices.origins : originsR.side;
    const targetRow = compareRows.find((row) => row.key === "target");
    const targetSide =
      targetRow?.state === "needsChoice" || targetR.state === "needsChoice" ? compareChoices.target : targetR.side;
    if (!nameSide || !originsSide || !targetSide) return; // 仍有未选择组（按钮已禁用，双保险）
    const nextDraft: Draft = {
      ...form.draft,
      name: nameSide === "theirs" ? serverSnapshot.draft.name : form.draft.name,
      originsText: originsSide === "theirs" ? serverSnapshot.draft.originsText : form.draft.originsText,
    };
    const pickedTarget: TargetValue = targetSide === "theirs" ? targetFrom(serverSnapshot) : targetFrom(form);
    const nextRule: RuleDraft = {
      projectId: pickedTarget.projectId,
      columnId: pickedTarget.columnId,
      columnSlug: pickedTarget.columnSlug,
      labelIds: [...pickedTarget.labelIds],
      assigneeId: pickedTarget.assigneeId,
    };
    // draft.kaneo* 冗余字段同步到所选目标，保持与 rule 的回退语义一致。
    nextDraft.kaneoProjectId = pickedTarget.projectId;
    nextDraft.kaneoColumnSlug = pickedTarget.columnSlug;
    setForm({ draft: nextDraft, rule: nextRule });
    setEditBase({ ruleVersion: conflict.ruleVersion ?? editBase.ruleVersion, form: serverSnapshot });
    setConflict(null);
    setCompareOpen(false);
    setCompareChoices({});
    setError(null);
  }

  /** 退出比较继续编辑：冲突仍未解决（conflict 保留），保存保持禁用直到应用结果。 */
  function exitCompare() {
    setCompareOpen(false);
    setCompareChoices({});
  }

  /** 比较期间冻结表单；冲突未解决时保存禁用。 */
  const formFrozen = compareOpen || detailLoading;
  const formFrozenHint = detailLoading ? "正在读取软件详情，完成后可继续操作" : "冲突比较期间表单已冻结";
  const conflictPending = conflict !== null;
  const editActionBlocked = busy || saving || detailLoading || deletingId !== null;
  const editActionHint = saving
    ? "保存进行中，完成后可切换软件"
    : detailLoading
      ? "正在读取软件详情，完成后可继续操作"
      : busy || deletingId !== null
        ? "有操作进行中，稍候重试"
        : undefined;

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
        <button
          type="button"
          className="btn primary"
          disabled={editActionBlocked}
          title={editActionHint}
          onClick={() => requestEditAction({ kind: "new" })}
        >
          新增软件
        </button>
      </div>
      {error && <InlineError message={error} />}
      {listError && <InlineError message={listError} onRetry={() => void load().catch(() => {})} />}

      <div className="table-wrap" aria-busy={listLoading}>
        {apps.length === 0 && listLoading ? (
          <div className="empty" role="status">
            正在读取软件列表…
          </div>
        ) : apps.length === 0 && listError ? (
          <EmptyState title="软件列表未加载" hint="请重试读取列表，当前编辑内容仍会保留。" />
        ) : apps.length === 0 ? (
          <EmptyState
            title="还没有软件配置"
            hint="组件首次提交反馈后会自动出现在这里，也可以手动新增。"
            action={
              <button
                type="button"
                className="btn sm"
                disabled={editActionBlocked}
                title={editActionHint}
                onClick={() => requestEditAction({ kind: "new" })}
              >
                手动新增软件
              </button>
            }
          />
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
                      {/* 保存或详情加载期间禁止切换对象；未保存修改需先确认。 */}
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => requestEditAction({ kind: "open", appId: a.id })}
                        disabled={editActionBlocked}
                        title={editActionHint}
                      >
                        配置
                      </button>
                      {a.archiveMode === "automatic" ? (
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => disableAuto(a)}
                          disabled={busy}
                          title={busy ? "有操作进行中，稍候重试" : undefined}
                        >
                          关闭自动同步
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => enableAuto(a)}
                          disabled={busy}
                          title={
                            busy
                              ? "有操作进行中，稍候重试"
                              : !a.ruleComplete
                                ? "自动同步规则不完整：需先配置项目、目标列与至少一个工作区标签"
                                : undefined
                          }
                        >
                          启用自动同步
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn sm danger"
                        onClick={() => void remove(a)}
                        disabled={busy || saving || deletingId !== null}
                        title={
                          deletingId !== null
                            ? "已有删除进行中，稍候重试"
                            : saving
                              ? "保存进行中，稍候重试"
                              : busy
                                ? "有操作进行中，稍候重试"
                                : undefined
                        }
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
        <div className="rule-status" style={{ marginTop: 16 }} role="status" aria-live="polite">
          {saving && (
            <div className="rule-status-line">
              <span className="rule-status-tag muted">保存中</span>
              <span className="muted small">正在写入配置…</span>
            </div>
          )}
          {conflict && (
            <div className="rule-status-line" role="alert">
              <span className="rule-status-tag err">保存冲突</span>
              <span className="small">
                {conflict.message}
                {conflict.ruleVersion !== null &&
                  `（最新保存版本：规则 v${conflict.ruleVersion}${conflict.savedAt ? `，${conflict.savedAt}` : ""}）`}
                {conflict.fetchError
                  ? `；读取最新配置失败：${conflict.fetchError}。旧基准与草稿已保留，可重试。`
                  : compareOpen
                    ? "；正在逐项比较，表单已冻结。"
                    : "；冲突未解决，保存已禁用：请进入比较或取消编辑。"}
              </span>
              {conflict.fetchError ? (
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() => void enterConflict(conflict.appId, conflict.message)}
                >
                  重试读取最新配置
                </button>
              ) : (
                !compareOpen && (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy}
                    onClick={() => {
                      setCompareChoices({});
                      setCompareOpen(true);
                    }}
                  >
                    进入比较
                  </button>
                )
              )}
            </div>
          )}
          {conflictInfo && (
            <div className="rule-status-line">
              <span className="rule-status-tag err">操作冲突</span>
              <span className="small">
                {conflictInfo.message}
                {conflictInfo.ruleVersion !== null &&
                  `（最新保存版本：规则 v${conflictInfo.ruleVersion}${conflictInfo.savedAt ? `，${conflictInfo.savedAt}` : ""}）`}
                ；你的修改仍在表单中，可比较后再次保存。
              </span>
            </div>
          )}
          {writeError && (
            <div className="rule-status-line" role="alert">
              <span className="rule-status-tag err">{writeError.label}</span>
              <span className="small">{writeError.message}；未写入，表单草稿已保留，可重试。</span>
            </div>
          )}
          {refreshError && (
            <div className="rule-status-line">
              <span className="rule-status-tag warn">已保存</span>
              <span className="small">
                {refreshError}{" "}
                <button type="button" className="btn sm" disabled={busy} onClick={() => void retrySaveRefresh()}>
                  重试刷新
                </button>
              </span>
            </div>
          )}
          {formDirty && !saving && (
            <div className="rule-status-line">
              <span className="rule-status-tag warn">未保存</span>
              <span className="muted small">有未保存的修改（与编辑基准不一致）。</span>
            </div>
          )}
          {!formDirty && !saving && savedInfo && (
            <div className="rule-status-line">
              <span className="rule-status-tag ok">已保存</span>
              <span className="muted small">
                规则 v{savedInfo.ruleVersion} · {savedInfo.at}
              </span>
            </div>
          )}
          {missingRule.length > 0 && (
            <div className="rule-status-line">
              <span className="rule-status-tag warn">规则缺项</span>
              <span className="small">{missingRule.join("；")}；补齐后才可启用自动同步。</span>
            </div>
          )}
          {pendingSourceCount > 0 && (
            <div className="rule-status-line">
              <span className="rule-status-tag warn">来源待确认</span>
              <span className="small">
                {pendingSourceCount} 条来源待确认：其反馈需确认后才会自动同步（与规则缺项相互独立）。
              </span>
            </div>
          )}
          {!saving &&
            !conflict &&
            !conflictInfo &&
            !writeError &&
            !formDirty &&
            !savedInfo &&
            missingRule.length === 0 &&
            pendingSourceCount === 0 && (
              <div className="rule-status-line">
                <span className="rule-status-tag ok">就绪</span>
                <span className="muted small">规则完整：保存或启用自动同步均可。</span>
              </div>
            )}
        </div>

        {conflict && !conflict.fetchError && compareOpen && (
          <section data-conflict-region="" aria-label="配置冲突比较">
            <hr className="sep" />
            <h3 style={{ marginTop: 0 }}>逐项比较：我的修改 vs 最新保存</h3>
            <p className="muted small" style={{ marginTop: 0 }}>
              基准为本次打开时读到的版本；仅一方修改或双方相同的项自动采用，双方都改且不同的项必须明确选择。
              比较期间表单已冻结；「应用比较结果」只更新草稿与基准，仍需点击「保存配置」才会写入。
            </p>
            {(compareOptionsLoading || compareOptionsError) && (
              <div className="rule-status-line" role={compareOptionsError ? "alert" : "status"} aria-live="polite">
                <span className={`rule-status-tag ${compareOptionsError ? "err" : "muted"}`}>
                  {compareOptionsError ? "选项读取失败" : "读取选项中"}
                </span>
                <span className="small">
                  {compareOptionsError ?? "正在分别读取两侧项目的列、标签和成员名称；读取完成前不能静默应用比较结果。"}
                </span>
                {compareOptionsError && (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy || compareOptionsLoading}
                    onClick={() => {
                      if (serverSnapshot) void loadCompareOptions(form, serverSnapshot);
                    }}
                  >
                    重试读取选项
                  </button>
                )}
              </div>
            )}
            {compareRows.map((row, i) => (
              <fieldset
                key={row.key}
                data-conflict-group={row.key}
                style={i === 0 ? fieldsetStyle : fieldsetDividedStyle}
              >
                <legend style={legendStyle}>
                  {row.title}
                  {row.state === "auto-mine" && (
                    <span className="rule-status-tag ok" style={{ marginLeft: "var(--sp-2)" }}>
                      采用我的修改
                    </span>
                  )}
                  {row.state === "auto-theirs" && (
                    <span className="rule-status-tag ok" style={{ marginLeft: "var(--sp-2)" }}>
                      采用最新保存
                    </span>
                  )}
                  {row.state === "same" && (
                    <span className="rule-status-tag muted" style={{ marginLeft: "var(--sp-2)" }}>
                      双方一致
                    </span>
                  )}
                  {row.state === "needsChoice" && (
                    <span className="rule-status-tag warn" style={{ marginLeft: "var(--sp-2)" }}>
                      需选择
                    </span>
                  )}
                </legend>
                <div className="fields-2col">
                  <div>
                    <div className="muted small" style={{ marginBottom: "var(--sp-1)" }}>
                      我的修改
                    </div>
                    <div style={valueBoxStyle} data-conflict-side="mine">
                      {row.mine.map((line) => (
                        <div key={line} className="wrap-anywhere">
                          {line}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="muted small" style={{ marginBottom: "var(--sp-1)" }}>
                      最新保存
                    </div>
                    <div style={valueBoxStyle} data-conflict-side="theirs">
                      {row.theirs.map((line) => (
                        <div key={line} className="wrap-anywhere">
                          {line}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                {row.state === "needsChoice" && (
                  <div className="row row-wrap" style={{ marginTop: "var(--sp-2)", gap: "var(--sp-3)" }}>
                    <label className="row" style={{ gap: "var(--sp-1)" }}>
                      <input
                        type="radio"
                        name={`conflict-${row.key}`}
                        value="mine"
                        disabled={busy}
                        checked={compareChoices[row.key] === "mine"}
                        onChange={() => setCompareChoices((prev) => ({ ...prev, [row.key]: "mine" }))}
                      />
                      我的修改
                    </label>
                    <label className="row" style={{ gap: "var(--sp-1)" }}>
                      <input
                        type="radio"
                        name={`conflict-${row.key}`}
                        value="theirs"
                        disabled={busy}
                        checked={compareChoices[row.key] === "theirs"}
                        onChange={() => setCompareChoices((prev) => ({ ...prev, [row.key]: "theirs" }))}
                      />
                      最新保存
                    </label>
                  </div>
                )}
              </fieldset>
            ))}
            <div className="btn-row" style={{ marginTop: "var(--sp-3)" }}>
              <button type="button" className="btn primary" disabled={!allResolved || busy} onClick={applyCompare}>
                应用比较结果
              </button>
              <button type="button" className="btn" disabled={busy} onClick={exitCompare}>
                退出比较继续编辑
              </button>
            </div>
            {!allResolved && (
              <p className="muted small" style={{ marginTop: "var(--sp-2)" }}>
                还有双方不同的项未选择：每组需点选「我的修改」或「最新保存」后才能应用。
              </p>
            )}
            <hr className="sep" />
          </section>
        )}

        <div className="fields-2col">
          <Field id="an" label="名称" hint="在后台列表与反馈详情中展示的名称。">
            {(ctl) => (
              <input
                {...ctl}
                value={draft.name}
                disabled={formFrozen}
                onChange={(e) => patchDraft({ name: e.target.value })}
              />
            )}
          </Field>
          <Field id="ai2" label="appId" hint="组件提交时携带的标识；创建后不可改。">
            {(ctl) => (
              <input
                {...ctl}
                value={draft.appId}
                disabled={Boolean(draft.id) || formFrozen}
                onChange={(e) => patchDraft({ appId: e.target.value })}
              />
            )}
          </Field>
        </div>
        <Field
          id="orig"
          label="允许的 Web 来源"
          hint="每行一个 origin（如 https://example.com）；此处登记的来源直接视为已确认。"
        >
          {(ctl) => (
            <textarea
              {...ctl}
              rows={2}
              value={draft.originsText}
              disabled={formFrozen}
              onChange={(e) => patchDraft({ originsText: e.target.value })}
            />
          )}
        </Field>

        <h3 style={{ marginTop: "var(--sp-2)" }}>默认同步目标（自动同步规则）</h3>
        <div className="row row-wrap" style={{ alignItems: "flex-start" }}>
          <div style={{ flex: 1 }}>
            <Field
              id="pid"
              label="Kaneo 项目"
              hint={
                projects.length > 0 ? "选项从连接配置的 Kaneo 实例加载。" : "实例选项未加载：直接填 Kaneo 项目 id。"
              }
            >
              {(ctl) =>
                projects.length > 0 ? (
                  <select
                    {...ctl}
                    value={rule.projectId}
                    disabled={detailLoading || formFrozen}
                    onChange={(e) => {
                      // 切换项目：立即清空列/标签/负责人，并丢弃旧项目的迟到响应
                      patchRule({
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
                    disabled={detailLoading || formFrozen}
                    onChange={(e) => patchRule({ projectId: e.target.value })}
                  />
                )
              }
            </Field>
          </div>
          <button
            type="button"
            className="btn"
            onClick={loadProjects}
            disabled={busy || formFrozen}
            title={formFrozen ? formFrozenHint : busy ? "有操作进行中，稍候重试" : undefined}
            style={{ marginTop: 22, whiteSpace: "nowrap" }}
          >
            <Icon name="refresh" size={16} />
            {busy ? "加载中…" : "刷新项目列表"}
          </button>
          <div style={{ flex: 1 }}>
            <Field id="col" label="目标列" hint="加载选项后从项目列中选择；未加载时直接填目标列 slug。">
              {(ctl) =>
                options && options.columns.length > 0 ? (
                  <select
                    {...ctl}
                    value={rule.columnId}
                    disabled={detailLoading || formFrozen}
                    onChange={(e) => {
                      const hit = options.columns.find((c) => c.id === e.target.value);
                      patchRule({ columnId: e.target.value, columnSlug: hit?.slug ?? "" });
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
                    disabled={detailLoading || formFrozen}
                    onChange={(e) => patchRule({ columnSlug: e.target.value })}
                  />
                )
              }
            </Field>
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => void loadOptions(rule.projectId)}
            disabled={busy || !rule.projectId || formFrozen}
            title={
              !rule.projectId
                ? "先选择 Kaneo 项目，才能加载列 / 标签 / 成员"
                : formFrozen
                  ? formFrozenHint
                  : busy
                    ? "有操作进行中，稍候重试"
                    : undefined
            }
            style={{ marginTop: 22 }}
          >
            加载列 / 标签 / 成员
          </button>
        </div>

        {/* 目标列校验错误：贴近「默认同步目标」字段，点重试即重测连接 */}
        {targetError && <InlineError message={targetError} onRetry={() => void testProjectWith(effectiveProjectId)} />}
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
                      disabled={detailLoading || formFrozen}
                      onChange={(e) =>
                        patchRule({
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
              <Field id="as" label="负责人" hint="可留空：同步任务不指定负责人。">
                {(ctl) => (
                  <select
                    {...ctl}
                    value={rule.assigneeId}
                    disabled={formFrozen}
                    onChange={(e) => patchRule({ assigneeId: e.target.value })}
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
          <button
            type="button"
            className="btn primary"
            onClick={save}
            disabled={busy || detailLoading || conflictPending}
            title={
              conflictPending
                ? "存在未解决的保存冲突：请逐项比较并应用结果后再保存"
                : detailLoading
                  ? "正在读取软件详情，完成后可保存"
                  : busy
                    ? "有操作进行中，稍候重试"
                    : undefined
            }
            aria-busy={saving}
          >
            {draft.id ? "保存配置（不触发同步）" : "创建"}
          </button>
          {selected && (
            <button
              type="button"
              className="btn"
              onClick={() => enableAuto(selected)}
              disabled={busy || formFrozen}
              title={
                formFrozen
                  ? formFrozenHint
                  : busy
                    ? "有操作进行中，稍候重试"
                    : !selected.ruleComplete
                      ? "自动同步规则不完整：需先配置项目、目标列与至少一个工作区标签"
                      : undefined
              }
            >
              启用自动同步并处理积压
            </button>
          )}
          {draft.id && (
            <button
              type="button"
              className="btn"
              disabled={editActionBlocked}
              title={editActionHint}
              onClick={() => requestEditAction({ kind: "reset" })}
            >
              取消编辑
            </button>
          )}
        </div>
        <p className="save-hint">
          保存位置：写入本服务器的软件配置；普通保存不会触发同步，同步到 Kaneo 需另行启用自动同步。
        </p>
        {columns.length > 0 && <p className="muted">项目共 {columns.length} 列（已通过连接测试）</p>}
      </div>

      {/* 危险操作独立分区：与配置表单分开；流程仍是确认弹窗 → 进行中禁用 → 可重试错误（与行内删除同一入口）。 */}
      {selected && (
        <div className="danger-zone">
          <div className="danger-zone-head">
            <h2>危险操作</h2>
            <span className="tag tone-err">软删除，历史保留</span>
          </div>
          <p>
            删除「{selected.name}」（<code className="wrap-anywhere">{selected.appId}</code>）：历史反馈、截图与日志
            全部保留；该 appId 再次提交反馈时会以全新待配置记录重新出现。列表行内也有同一删除入口。
          </p>
          <button
            type="button"
            className="btn danger"
            onClick={() => void remove(selected)}
            disabled={busy || saving || deletingId !== null}
            title={
              deletingId !== null
                ? "已有删除进行中，稍候重试"
                : saving
                  ? "保存进行中，稍候重试"
                  : busy
                    ? "有操作进行中，稍候重试"
                    : undefined
            }
          >
            {deletingId === selected.id ? "删除中…" : "删除该软件"}
          </button>
        </div>
      )}

      {confirmState?.kind === "discard" && (
        <ConfirmDialog
          title="放弃未保存的修改？"
          body={
            <p>
              当前配置还有未保存的修改。放弃后将
              {confirmState.action.kind === "open"
                ? "切换到所选软件"
                : confirmState.action.kind === "new"
                  ? "清空表单并新增软件"
                  : "取消本次编辑"}
              ；点「取消」可继续编辑，修改会原样保留。
            </p>
          }
          confirmLabel="放弃修改并继续"
          danger
          onClose={() => setConfirmState(null)}
          onConfirm={() => {
            const pending = confirmState;
            setConfirmState(null);
            // 草稿已改变或后台操作开始时，不执行旧确认目标。
            if (pending.generation !== editGen.current) return;
            performEditAction(pending.action);
          }}
        />
      )}
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
