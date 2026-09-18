/**
 * 反馈详情抽屉（固定内容顺序）：
 * 1. 标题、同步状态、Kaneo 入口（头部）
 * 2. 软件、账号、时间、反馈 ID
 * 3. 用户原话
 * 4. 截图与日志附件
 * 5. AI 整理结果
 * 6. 分类与同步目标（回收站只读）
 * 7. 异常及可用恢复动作（回收站只读）
 * 8. 默认折叠的技术错误与操作记录
 *
 * 未保存的分类修改在关闭抽屉时提示放弃；轮询刷新不覆盖正在编辑的草稿
 * （仅在服务端 classification.version 变化时回写本地状态）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type AppItem,
  AUDIT_LABELS,
  api,
  type ClassifyOptions,
  type FeedbackDetail,
  type LifecycleAction,
  STATUS_LABELS,
} from "../api.ts";
import { ConfirmDialog, Drawer, EmptyState, Icon, InlineError, Modal, SkeletonRows, useToast } from "../ui.tsx";

const SECTION_LABELS: Record<string, string> = {
  experience: "使用体验",
  problems: "问题",
  suggestions: "建议",
  questions: "待确认",
};

const RECOVERY_LABELS: Record<string, string> = {
  retry: "重试处理",
  recheck: "重新核对",
  "force-create": "确认缺失后再次创建",
  retry_comment: "重试截图评论",
  replace_upload: "替换截图上传",
  retry_log: "重试日志上传",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function FeedbackDrawer({
  detail,
  onClose,
  onRetry,
  onAction,
  onTrash,
  onPurge,
  onChanged,
}: {
  detail: FeedbackDetail | "loading" | "purged" | "error" | null;
  onClose: () => void;
  /** 详情拉取失败（非 410）时由父级重新请求。 */
  onRetry: () => void;
  /** 单条生命周期动作（走父级批量入口，含刷新与通知）。 */
  onAction: (action: LifecycleAction, id: string) => Promise<boolean>;
  onTrash: (d: FeedbackDetail) => void;
  onPurge: (d: FeedbackDetail) => void;
  /** 分类/恢复等操作完成后由父级刷新详情与列表。 */
  onChanged: () => void;
}) {
  const toast = useToast();
  const [classifyDirty, setClassifyDirty] = useState(false);
  const [discardAsk, setDiscardAsk] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [logPreview, setLogPreview] = useState<{ id: string; name: string; text: string } | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  /** 关闭前检查未保存的分类草稿。 */
  const requestClose = useCallback(() => {
    if (classifyDirty) setDiscardAsk(true);
    else onClose();
  }, [classifyDirty, onClose]);

  /** 处理类操作（重试/恢复/核对）：错误内联展示，成功后由父级刷新。 */
  const runOp = useCallback(
    async (fn: () => Promise<unknown>): Promise<boolean> => {
      setActionErr(null);
      try {
        await fn();
        onChanged();
        return true;
      } catch (err) {
        setActionErr(err instanceof ApiError ? err.message : "操作失败");
        return false;
      }
    },
    [onChanged],
  );

  if (detail === "loading" || detail === null) {
    return (
      <Drawer title="反馈详情" onClose={requestClose}>
        <SkeletonRows rows={8} />
      </Drawer>
    );
  }
  if (detail === "purged") {
    return (
      <Drawer title="反馈详情" onClose={onClose}>
        <EmptyState title="该反馈已被彻底删除" hint="记录及其附件已清理，仅保留最小删除凭据。" />
      </Drawer>
    );
  }
  if (detail === "error") {
    return (
      <Drawer title="反馈详情" onClose={onClose}>
        <EmptyState
          title="详情加载失败"
          hint="网络或服务暂时不可用，可重试。"
          action={
            <button type="button" className="btn primary" onClick={onRetry}>
              重试
            </button>
          }
        />
      </Drawer>
    );
  }

  const readOnly = detail.readOnly === true || detail.mgmtState === "trash";
  const available = new Set(detail.availableActions ?? []);
  const rev = detail.recovery?.revision;
  const fid = detail.id;

  async function openLogPreview(logId: string, name: string) {
    try {
      const res = await fetch(`/api/admin/feedback/${fid}/logs/${logId}/preview`, {
        credentials: "same-origin",
      });
      if (!res.ok) throw new ApiError(`http_${res.status}`, "读取日志失败", res.status);
      setLogPreview({ id: logId, name, text: await res.text() });
    } catch (err) {
      toast("err", err instanceof Error ? err.message : "读取日志失败");
    }
  }

  return (
    <Drawer
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {detail.title || detail.text.slice(0, 40) || "（无标题）"}
          </span>
          <span className={`tag ${detail.status}`}>{STATUS_LABELS[detail.status] ?? detail.status}</span>
          {readOnly && <span className="tag tone-warn">回收站 · 只读</span>}
        </span>
      }
      onClose={requestClose}
      footer={
        <>
          {available.has("archive") && (
            <button type="button" className="btn primary" onClick={() => void onAction("archive", detail.id)}>
              <Icon name="archive" size={16} />
              归档
            </button>
          )}
          {available.has("unarchive") && (
            <button type="button" className="btn" onClick={() => void onAction("unarchive", detail.id)}>
              <Icon name="restore" size={16} />
              恢复到收件箱
            </button>
          )}
          {available.has("resume_processing") && (
            <button type="button" className="btn" onClick={() => void onAction("resume_processing", detail.id)}>
              <Icon name="play" size={16} />
              恢复处理
            </button>
          )}
          {available.has("restore") && (
            <button type="button" className="btn primary" onClick={() => void onAction("restore", detail.id)}>
              <Icon name="restore" size={16} />
              恢复
            </button>
          )}
          {available.has("trash") && (
            <button type="button" className="btn" onClick={() => onTrash(detail)}>
              <Icon name="trash" size={16} />
              移入回收站
            </button>
          )}
          {available.has("purge") && (
            <button type="button" className="btn danger" onClick={() => onPurge(detail)}>
              <Icon name="trash" size={16} />
              彻底删除
            </button>
          )}
          {detail.kaneoUrl && (
            <a className="btn" href={detail.kaneoUrl} target="_blank" rel="noreferrer" style={{ marginLeft: "auto" }}>
              <Icon name="external" size={16} />在 Kaneo 中查看
            </a>
          )}
        </>
      }
    >
      {/* 2. 软件、账号、时间、反馈 ID */}
      <section>
        <dl className="kv">
          <dt>软件</dt>
          <dd>
            {detail.app?.name ?? detail.appId}
            <span className="muted small wrap-anywhere">（{detail.appId}）</span>
            {detail.app?.deletedAt && <span className="tag tone-warn">软件已删除</span>}
          </dd>
          <dt>提交账号</dt>
          <dd>{detail.username ?? "—"}</dd>
          <dt>提交时间</dt>
          <dd>{new Date(detail.createdAt).toLocaleString()}</dd>
          <dt>反馈 ID</dt>
          <dd>
            <code className="wrap-anywhere">{detail.id}</code>
          </dd>
          {detail.context?.appVersion && (
            <>
              <dt>应用版本</dt>
              <dd>{detail.context.appVersion}</dd>
            </>
          )}
          {detail.context?.pageLabel && (
            <>
              <dt>页面</dt>
              <dd>{detail.context.pageLabel}</dd>
            </>
          )}
        </dl>
      </section>

      {/* 3. 用户原话 */}
      <section>
        <h3>用户原话</h3>
        <blockquote className="quote">{detail.text}</blockquote>
      </section>

      {/* 4. 截图与日志附件 */}
      {(detail.screenshot || (detail.logs && detail.logs.length > 0)) && (
        <section>
          <h3>附件</h3>
          {detail.screenshot && (
            <div className="attach-item">
              <Icon name="image" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>截图</div>
                <div className="muted small">
                  {detail.screenshot.width}×{detail.screenshot.height} · {formatBytes(detail.screenshot.byteSize)}
                </div>
              </div>
              <button type="button" className="btn sm" onClick={() => setLightbox(true)}>
                查看
              </button>
            </div>
          )}
          {(detail.logs ?? []).map((l) => (
            <div key={l.id} className="attach-item">
              <Icon name="file" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="wrap-anywhere">{l.filename}</div>
                <div className="muted small">
                  {l.source === "auto" ? "自动" : "手动"} · {formatBytes(l.byteSize)}
                </div>
              </div>
              <button type="button" className="btn sm" onClick={() => void openLogPreview(l.id, l.filename)}>
                预览
              </button>
              <a className="btn sm" href={`/api/admin/feedback/${detail.id}/logs/${l.id}/download`} download>
                下载
              </a>
            </div>
          ))}
        </section>
      )}

      {/* 5. AI 整理结果 */}
      {detail.processed && (
        <section>
          <h3>AI 整理结果</h3>
          <dl className="kv">
            <dt>标题</dt>
            <dd>{detail.processed.title}</dd>
          </dl>
          {Object.entries(detail.processed.sections).map(([k, v]) =>
            v ? (
              <div key={k} style={{ marginTop: "var(--sp-2)" }}>
                <div className="muted small">{SECTION_LABELS[k] ?? k}</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{v}</div>
              </div>
            ) : null,
          )}
        </section>
      )}

      {actionErr && <InlineError message={actionErr} />}

      {/* 6. 分类与同步目标 */}
      <section>
        <h3>分类与同步目标</h3>
        <ClassifyPanel detail={detail} readOnly={readOnly} onDirtyChange={setClassifyDirty} onAction={runOp} />
      </section>

      {/* 7. 异常及可用恢复动作 */}
      {!readOnly && detail.recovery && detail.recovery.allowedActions.length > 0 && (
        <section>
          <h3>恢复动作</h3>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {detail.recovery.allowedActions.map((action) => (
              <button
                key={action}
                type="button"
                className="btn"
                title={detail.recovery?.actionNotes[action] ?? detail.recovery?.actionTargets[action] ?? ""}
                onClick={() =>
                  void runOp(() =>
                    action === "retry"
                      ? api.post(`/api/feedback/${detail.id}/retry`, { expectedRevision: rev })
                      : action === "recheck" || action === "force-create"
                        ? api.post(`/api/feedback/${detail.id}/resolve`, { action, expectedRevision: rev })
                        : action === "retry_log"
                          ? api.post(`/api/feedback/${detail.id}/recover`, {
                              action,
                              expectedRevision: rev,
                              logId: detail.recovery?.pendingLogIds?.[0],
                            })
                          : api.post(`/api/feedback/${detail.id}/recover`, { action, expectedRevision: rev }),
                  )
                }
              >
                {RECOVERY_LABELS[action] ?? action}
              </button>
            ))}
          </div>
          <p className="muted small" style={{ marginTop: "var(--sp-2)" }}>
            操作按当前恢复状态提供，悬停按钮可查看该动作的风险说明。retry_comment
            针对评论：重发前会先查重，只有未命中才发送一次，但远端列表与写入之间存在竞态，仍可能产生重复评论，请在 Kaneo
            中复核；自动路径（重试、后台恢复、重新核对）绝不自动重发评论。replace_upload
            针对图片：替换会复用原任务并申请新上传地址，旧对象与旧 key
            记录保留、不自动删除远端文件，是上传地址过期后的唯一出路。
          </p>
        </section>
      )}
      {readOnly && (
        <p className="muted small">回收站中的记录为只读：不能分类、同步、重试或重传附件。可恢复回收件箱或彻底删除。</p>
      )}

      {/* 8. 默认折叠：技术错误 + 操作记录 */}
      {(detail.lastError || (detail.audit && detail.audit.length > 0)) && (
        <details className="collapsible">
          <summary>技术细节与操作记录</summary>
          {detail.lastError && (
            <pre className="log-pre" style={{ maxHeight: 160 }}>
              {detail.lastError}
            </pre>
          )}
          {detail.recovery && (
            <dl className="kv" style={{ marginTop: "var(--sp-2)" }}>
              <dt>恢复版本</dt>
              <dd>{detail.recovery.revision}</dd>
              <dt>阶段</dt>
              <dd>{detail.recovery.stage ?? "—"}</dd>
              <dt>上传结果</dt>
              <dd>{detail.recovery.uploadOutcome ?? "—"}</dd>
              <dt>评论结果</dt>
              <dd>{detail.recovery.commentOutcome ?? "—"}</dd>
              <dt>尝试次数</dt>
              <dd>{detail.attemptCount}</dd>
            </dl>
          )}
          {detail.audit && detail.audit.length > 0 && (
            <ul className="audit-list">
              {detail.audit.map((a) => (
                <li key={a.id}>
                  <span className="muted">{new Date(a.at).toLocaleString()}</span> · {a.actor || "系统"} ·{" "}
                  {AUDIT_LABELS[a.action] ?? a.action}
                </li>
              ))}
            </ul>
          )}
        </details>
      )}

      {/* 弹层 */}
      {lightbox && detail.screenshot && (
        <Modal title="截图预览" onClose={() => setLightbox(false)} wide>
          <img
            className="lightbox-img"
            src={`/api/admin/feedback/${detail.id}/screenshot`}
            alt={`反馈截图 ${detail.screenshot.width}×${detail.screenshot.height}`}
          />
        </Modal>
      )}
      {logPreview && (
        <Modal title={logPreview.name} onClose={() => setLogPreview(null)} wide>
          <pre className="log-pre">{logPreview.text}</pre>
        </Modal>
      )}
      {discardAsk && (
        <ConfirmDialog
          title="放弃未保存的分类修改？"
          body={<p>分类表单有未保存的修改，关闭抽屉将丢弃这些修改。</p>}
          confirmLabel="放弃修改"
          danger
          onConfirm={() => {
            setDiscardAsk(false);
            onClose();
          }}
          onClose={() => setDiscardAsk(false)}
        />
      )}
    </Drawer>
  );
}

// ---------- 分类面板（暂存 / 保存并同步到 Kaneo） ----------

interface ClassifyState {
  projectId: string;
  columnId: string;
  labelIds: string[];
  assigneeId: string;
}

function classifyStateOf(detail: FeedbackDetail, fallbackProject: string): ClassifyState {
  const c = detail.classification;
  return {
    projectId: c?.projectId ?? fallbackProject,
    columnId: c?.columnId ?? "",
    labelIds: c?.labelIds ?? [],
    assigneeId: c?.assigneeId ?? "",
  };
}

/** 操作幂等键：crypto.randomUUID 仅在安全上下文存在，HTTP（局域网 IP 直连）下退化使用时间戳+随机串。 */
function newOperationId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  return c && typeof c.randomUUID === "function"
    ? c.randomUUID()
    : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 人工分类与同步：
 * - 项目、目标列、至少一个工作区标签必填；负责人可选；
 * - 「保存」= 暂存（允许缺项）；「保存并同步到 Kaneo」= 完整校验后固定快照并入队；
 * - 切换项目立即清空列/标签/负责人，并用请求序号 + 当前项目校验丢弃迟到响应；
 * - 已进入同步队列或已同步的记录锁定分类（只读展示）；回收站记录整体只读。
 */
function ClassifyPanel({
  detail,
  readOnly,
  onDirtyChange,
  onAction,
}: {
  detail: FeedbackDetail;
  readOnly: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onAction: (fn: () => Promise<unknown>) => Promise<boolean>;
}) {
  const locked = Boolean(detail.classificationLocked) || readOnly;
  const [projects, setProjects] = useState<{ id: string; name: string; workspaceId: string }[]>([]);
  const [appDefault, setAppDefault] = useState<{ projectId: string; columnSlug: string } | null>(null);
  const [state, setState] = useState<ClassifyState>(() =>
    classifyStateOf(detail, detail.classification?.projectId ?? ""),
  );
  const [options, setOptions] = useState<ClassifyOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "err" | "ok"; text: string } | null>(null);
  const seqRef = useRef(0);
  /** 一次提交操作的稳定幂等键：失败后重试复用同一键，成功后才生成新键（服务端据此去重）。 */
  const opIdRef = useRef<string | null>(null);
  /** 软件默认项目/列只用于**首次**预填；用户手动切换项目后不再自动选择任何列。 */
  const autoPrefillRef = useRef(true);
  /** 上次从服务端应用到表单的分类版本：轮询刷新 detail 对象时不得覆盖草稿。 */
  const appliedVersionRef = useRef(detail.classification?.version ?? -1);
  /**
   * 脏标记只在用户主动修改时置位（自动预填不算未保存修改）；
   * 保存成功后服务端版本回写表单时清除。
   */
  const dirtyRef = useRef(false);

  // 软件默认项目/列仅用于预填（标签与负责人绝不自动选择）；只读模式也加载项目列表用于显示名称。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [projRes, appsRes] = await Promise.all([
          api.get<{ ok: boolean; projects?: { id: string; name: string; workspaceId: string }[] }>(
            "/api/admin/connection/kaneo/projects",
          ),
          api.get<{ apps: AppItem[] }>("/api/admin/apps"),
        ]);
        if (!alive) return;
        setProjects(projRes.projects ?? []);
        const app = (appsRes.apps ?? []).find((a) => a.appId === detail.appId);
        setAppDefault(app ? { projectId: app.kaneoProjectId, columnSlug: app.kaneoColumnSlug } : null);
      } catch {
        /* 连接未配置时保持空列表 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [detail.appId]);

  // 首次拿到详情时用软件默认项目/列预填（仅在用户/记录都没有选择、且未手动切换过项目时）。
  useEffect(() => {
    if (!appDefault || !autoPrefillRef.current) return;
    setState((prev) => {
      if (prev.projectId) return prev;
      return { ...prev, projectId: appDefault.projectId };
    });
  }, [appDefault]);

  const loadOptions = useCallback(async (projectId: string) => {
    const seq = ++seqRef.current;
    setOptionsError(null);
    setOptions(null);
    if (!projectId) return;
    try {
      const res = await api.get<ClassifyOptions>(
        `/api/admin/feedback/options?projectId=${encodeURIComponent(projectId)}`,
      );
      // 迟到响应丢弃：序号必须仍是当前请求，且返回项目必须与当前选择一致。
      if (seq !== seqRef.current) return;
      if (res.project.id !== projectId) return;
      setOptions(res);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setOptionsError(err instanceof ApiError ? err.message : "读取 Kaneo 选项失败");
    }
  }, []);

  useEffect(() => {
    void loadOptions(state.projectId);
  }, [state.projectId, loadOptions]);

  // 仅当服务端分类版本变化（保存成功 / 他人修改）时回写本地表单；轮询返回同版本不得覆盖草稿。
  useEffect(() => {
    const v = detail.classification?.version ?? -1;
    if (v === appliedVersionRef.current) return;
    appliedVersionRef.current = v;
    dirtyRef.current = false;
    onDirtyChange(false);
    setState((prev) => {
      const next = classifyStateOf(detail, prev.projectId);
      return { ...prev, columnId: next.columnId, labelIds: next.labelIds, assigneeId: next.assigneeId };
    });
  }, [detail, onDirtyChange]);

  // 首次加载到列选项时用软件默认列预填（按 slug 匹配实时列选项）；只做一次。
  useEffect(() => {
    if (!options || !appDefault || !autoPrefillRef.current) return;
    autoPrefillRef.current = false;
    setState((prev) => {
      if (prev.columnId || detail.classification?.columnId) return prev;
      const hit = options.columns.find((c) => c.slug === appDefault.columnSlug);
      return hit ? { ...prev, columnId: hit.id } : prev;
    });
  }, [options, appDefault, detail.classification?.columnId]);

  const column = options?.columns.find((c) => c.id === state.columnId) ?? null;
  const complete = Boolean(state.projectId && column && state.labelIds.length > 0);

  function markDirty() {
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      onDirtyChange(true);
    }
  }

  function changeProject(projectId: string) {
    // 切换项目立即清空列/标签/负责人，避免把上一项目的选项误存进快照。
    autoPrefillRef.current = false;
    markDirty();
    setState({ projectId, columnId: "", labelIds: [], assigneeId: "" });
  }

  function toggleLabel(id: string) {
    markDirty();
    setState((prev) => ({
      ...prev,
      labelIds: prev.labelIds.includes(id) ? prev.labelIds.filter((x) => x !== id) : [...prev.labelIds, id],
    }));
  }

  async function submit(mode: "save" | "archive") {
    if (mode === "archive" && !complete) {
      setNotice({ kind: "err", text: "同步前必须选择项目、目标列与至少一个工作区标签" });
      return;
    }
    setBusy(true);
    setNotice(null);
    // 失败后重试复用同一幂等键，成功后才换新键（服务端据此去重同一笔操作）。
    if (opIdRef.current === null) opIdRef.current = newOperationId();
    const operationId = opIdRef.current;
    try {
      const succeeded = await onAction(() =>
        api.post<{ ok: boolean; classifyVersion: number }>(`/api/admin/feedback/${detail.id}/classify`, {
          action: mode,
          classifyVersion: detail.classification?.version ?? 0,
          operationId,
          projectId: state.projectId || null,
          columnId: state.columnId || null,
          columnSlug: column?.slug ?? null,
          labelIds: state.labelIds,
          assigneeId: state.assigneeId || null,
          assigneeName: (options?.members ?? []).find((m) => m.id === state.assigneeId)?.name ?? null,
        }),
      );
      if (!succeeded) return;
      opIdRef.current = null;
      setNotice({ kind: "ok", text: mode === "archive" ? "已固定同步目标并入队" : "已保存" });
    } finally {
      setBusy(false);
    }
  }

  if (readOnly) {
    const c = detail.classification;
    return (
      <dl className="kv">
        <dt>项目</dt>
        <dd>{projects.find((p) => p.id === c?.projectId)?.name ?? c?.projectId ?? "—"}</dd>
        <dt>目标列</dt>
        <dd>{c?.columnSlug ?? "—"}</dd>
        <dt>标签</dt>
        <dd>{c && c.labelIds.length > 0 ? c.labelIds.join("、") : "—"}</dd>
        <dt>负责人</dt>
        <dd>{c?.assigneeName ?? "—"}</dd>
      </dl>
    );
  }

  return (
    <div>
      <div className="form-grid">
        <label htmlFor="cls-project">项目</label>
        <span>
          <select
            id="cls-project"
            value={state.projectId}
            disabled={locked}
            onChange={(e) => changeProject(e.target.value)}
          >
            <option value="">（未选择）</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </span>
        <label htmlFor="cls-column">目标列</label>
        <span>
          <select
            id="cls-column"
            value={state.columnId}
            disabled={locked || !state.projectId || !options}
            onChange={(e) => {
              markDirty();
              setState((prev) => ({ ...prev, columnId: e.target.value }));
            }}
          >
            <option value="">（未选择）</option>
            {(options?.columns ?? []).map((col) => (
              <option key={col.id} value={col.id}>
                {col.name}（{col.slug}）
              </option>
            ))}
          </select>
        </span>
        <label htmlFor="cls-assignee">负责人（可选）</label>
        <span>
          <select
            id="cls-assignee"
            value={state.assigneeId}
            disabled={locked || !options}
            onChange={(e) => {
              markDirty();
              setState((prev) => ({ ...prev, assigneeId: e.target.value }));
            }}
          >
            <option value="">（不指定负责人）</option>
            {(options?.members ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </span>
      </div>
      <div style={{ margin: "var(--sp-2) 0" }}>
        <div className="muted small" style={{ marginBottom: 4 }}>
          工作区标签（至少一个；仅工作区级标签可选，不会移动其他任务的标签）
        </div>
        {optionsError && <InlineError message={optionsError} onRetry={() => void loadOptions(state.projectId)} />}
        {options && options.labels.length === 0 && <p className="muted small">该工作区没有工作区级标签。</p>}
        <div className="label-picker">
          {(options?.labels ?? []).map((l) => (
            <label key={l.id}>
              <input
                type="checkbox"
                checked={state.labelIds.includes(l.id)}
                disabled={locked}
                onChange={() => toggleLabel(l.id)}
              />
              {l.name}
            </label>
          ))}
        </div>
      </div>
      {notice && <p className={notice.kind === "err" ? "err" : "ok-text"}>{notice.text}</p>}
      {!locked && (
        <div className="row row-wrap" style={{ marginTop: "var(--sp-2)" }}>
          <button type="button" className="btn" disabled={busy} onClick={() => void submit("save")}>
            保存
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !complete}
            onClick={() => void submit("archive")}
          >
            保存并同步到 Kaneo
          </button>
          {!complete && <span className="muted small">同步前请补齐项目、目标列与标签</span>}
        </div>
      )}
      {locked && !readOnly && <p className="muted small">该记录已进入同步流程或已同步，分类已锁定。</p>}
    </div>
  );
}
