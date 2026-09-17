/**
 * 反馈详情抽屉（固定内容顺序）：
 * 1. 头部：完整标题（最多两行）、处理状态、所在区域、关闭
 * 2. 基本信息：软件、提交账号、时间；「更多信息」展开 ID/appId/版本/页面
 * 3. 异常提示：当前问题与可用恢复动作（原始错误折叠进操作记录）
 * 4. 用户原话
 * 5. 附件：截图缩略图（点击放大）＋日志文件行
 * 6. AI 整理（默认折叠）
 * 7. 分类与同步目标（回收站只读）
 * 8. 默认折叠的操作记录与技术细节
 * 底部操作：分类编辑时「保存分类」为次按钮、「保存并同步」为主按钮；
 * 归档等管理动作与删除动作分开两侧。
 *
 * 未保存的分类修改在关闭抽屉时提示放弃；轮询刷新不覆盖正在编辑的草稿
 * （仅在服务端 classification.version 变化时回写本地状态）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ApiError,
  type AppItem,
  AUDIT_LABELS,
  api,
  type ClassifyOptions,
  type FeedbackDetail,
  type LifecycleAction,
  STATUS_LABELS,
  VIEW_LABELS,
} from "../api.ts";
import {
  AttachmentItem,
  ConfirmDialog,
  Drawer,
  EmptyState,
  FormSection,
  fmtDateTime,
  Icon,
  InlineError,
  Modal,
  SkeletonRows,
  StatusBadge,
  useToast,
} from "../ui.tsx";

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
  onAction,
  onTrash,
  onPurge,
  onChanged,
}: {
  detail: FeedbackDetail | "loading" | "purged" | null;
  onClose: () => void;
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
  /** 底部操作区左半部分的容器：分类面板的保存按钮经 portal 渲染到这里。 */
  const [footLeft, setFootLeft] = useState<HTMLDivElement | null>(null);
  /** 分类面板是否处于可编辑态（控制 portal 按钮与提示出现）。 */
  const [classifyEditable, setClassifyEditable] = useState(false);
  const [copied, setCopied] = useState(false);

  /** 关闭前检查未保存的分类草稿。 */
  const requestClose = useCallback(() => {
    if (classifyDirty) setDiscardAsk(true);
    else onClose();
  }, [classifyDirty, onClose]);

  /** 处理类操作（重试/恢复/核对）：错误内联展示，成功后由父级刷新。 */
  const runOp = useCallback(
    async (fn: () => Promise<unknown>) => {
      setActionErr(null);
      try {
        await fn();
        onChanged();
      } catch (err) {
        setActionErr(err instanceof ApiError ? err.message : "操作失败");
      }
    },
    [onChanged],
  );

  function copyId(id: string) {
    void navigator.clipboard
      ?.writeText(id)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => toast("err", "复制失败"));
  }

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

  const readOnly = detail.readOnly === true || detail.mgmtState === "trash";
  const available = new Set(detail.availableActions ?? []);
  const rev = detail.recovery?.revision;
  const fid = detail.id;
  const hasIssue = Boolean(
    detail.errorSummary ||
      detail.lastError ||
      detail.autoBlockedKind ||
      detail.resumePaused ||
      (detail.recovery && detail.recovery.allowedActions.length > 0),
  );

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
      title={detail.title ?? detail.text.slice(0, 40) ?? "（无标题）"}
      headerMeta={
        <>
          <StatusBadge tone={detail.status}>{STATUS_LABELS[detail.status] ?? detail.status}</StatusBadge>
          <StatusBadge tone="neutral">{VIEW_LABELS[detail.mgmtState]}</StatusBadge>
          {readOnly && <StatusBadge tone="warn">回收站 · 只读</StatusBadge>}
          {detail.resumePaused && <StatusBadge tone="warn">已暂停</StatusBadge>}
        </>
      }
      onClose={requestClose}
      footer={
        <>
          <div className="drawer-foot-left" ref={setFootLeft}>
            {available.has("archive") && (
              <button type="button" className="btn" onClick={() => void onAction("archive", detail.id)}>
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
          </div>
          <div className="drawer-foot-right">
            {detail.kaneoUrl && (
              <a className="btn" href={detail.kaneoUrl} target="_blank" rel="noreferrer">
                <Icon name="external" size={16} />在 Kaneo 中查看
              </a>
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
          </div>
        </>
      }
    >
      {/* 3. 异常提示：当前问题 + 可用恢复动作（置顶，原始错误折叠在操作记录里） */}
      {!readOnly && hasIssue && (
        <div className="issue-banner" role="alert">
          <Icon name="alert" size={16} />
          <div className="issue-banner-main">
            <div>
              {detail.errorSummary ??
                (detail.lastError ? "最近一次处理失败" : null) ??
                (detail.autoBlockedKind === "config"
                  ? `配置问题：${detail.autoBlockedReason ?? "等待管理员修正"}`
                  : detail.autoBlockedKind === "retryable"
                    ? `可恢复故障：${detail.autoBlockedReason ?? "处理中会自动重试"}`
                    : detail.resumePaused
                      ? "处理已暂停，可手动恢复"
                      : "该记录存在待处理的异常")}
            </div>
            {detail.recovery && detail.recovery.allowedActions.length > 0 && (
              <div className="issue-actions">
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
            )}
            {detail.recovery && detail.recovery.allowedActions.length > 0 && (
              <p className="muted small" style={{ marginTop: "var(--sp-2)", marginBottom: 0 }}>
                操作按当前恢复状态提供，悬停按钮可查看该动作的风险说明。retry_comment
                针对评论：重发前会先查重，只有未命中才发送一次，但远端列表与写入之间存在竞态，仍可能产生重复评论，请在
                Kaneo 中复核；自动路径（重试、后台恢复、重新核对）绝不自动重发评论。replace_upload
                针对图片：替换会复用原任务并申请新上传地址，旧对象与旧 key
                记录保留、不自动删除远端文件，是上传地址过期后的唯一出路。
              </p>
            )}
          </div>
        </div>
      )}
      {readOnly && (
        <p className="notice-bar" style={{ display: "flex" }}>
          <Icon name="trash" size={16} />
          回收站中的记录为只读：不能分类、同步、重试或重传附件。可恢复回收件箱或彻底删除。
        </p>
      )}
      {actionErr && <InlineError message={actionErr} />}

      {/* 2. 基本信息 */}
      <FormSection title="基本信息">
        <dl className="kv">
          <dt>软件</dt>
          <dd>
            {detail.app?.name ?? detail.appId}
            {detail.app?.deletedAt && <StatusBadge tone="warn">软件已删除</StatusBadge>}
          </dd>
          <dt>提交账号</dt>
          <dd>{detail.username ?? "—"}</dd>
          <dt>提交时间</dt>
          <dd>{fmtDateTime(detail.createdAt)}</dd>
        </dl>
        <details className="info-more">
          <summary>更多信息</summary>
          <dl className="kv" style={{ marginTop: "var(--sp-2)" }}>
            <dt>反馈 ID</dt>
            <dd>
              <code className="wrap-anywhere">{detail.id}</code>{" "}
              <button type="button" className="copy-btn" onClick={() => copyId(detail.id)}>
                <Icon name="copy" size={12} />
                {copied ? "已复制" : "复制"}
              </button>
            </dd>
            <dt>appId</dt>
            <dd>
              <code className="wrap-anywhere">{detail.appId}</code>
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
                <dd className="wrap-anywhere">{detail.context.pageLabel}</dd>
              </>
            )}
          </dl>
        </details>
      </FormSection>

      {/* 4. 用户原话 */}
      <FormSection title="用户原话">
        <blockquote className="quote">{detail.text}</blockquote>
      </FormSection>

      {/* 5. 附件：截图缩略图 + 日志文件行 */}
      {(detail.screenshot || (detail.logs && detail.logs.length > 0)) && (
        <FormSection title="附件">
          {detail.screenshot && (
            <button
              type="button"
              className="screenshot-thumb-wrap"
              onClick={() => setLightbox(true)}
              aria-label={`查看截图 ${detail.screenshot.width}×${detail.screenshot.height}`}
            >
              <img
                className="screenshot-thumb"
                src={`/api/admin/feedback/${detail.id}/screenshot`}
                alt={`反馈截图 ${detail.screenshot.width}×${detail.screenshot.height}`}
              />
              <span className="muted small" style={{ display: "block", padding: "var(--sp-1) 0" }}>
                截图 {detail.screenshot.width}×{detail.screenshot.height} · {formatBytes(detail.screenshot.byteSize)} ·
                点击放大
              </span>
            </button>
          )}
          {(detail.logs ?? []).map((l) => (
            <AttachmentItem
              key={l.id}
              icon="file"
              name={l.filename}
              meta={`${l.source === "auto" ? "自动" : "手动"} · ${formatBytes(l.byteSize)}`}
              actions={
                <>
                  <button type="button" className="btn sm" onClick={() => void openLogPreview(l.id, l.filename)}>
                    预览
                  </button>
                  <a className="btn sm" href={`/api/admin/feedback/${detail.id}/logs/${l.id}/download`} download>
                    下载
                  </a>
                </>
              }
            />
          ))}
        </FormSection>
      )}

      {/* 6. AI 整理（默认折叠） */}
      {detail.processed && (
        <details className="collapsible">
          <summary>
            AI 整理 <span className="tag tone-info">AI</span>
          </summary>
          <div style={{ marginTop: "var(--sp-2)" }}>
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
          </div>
        </details>
      )}

      {/* 7. 分类与同步目标 */}
      <FormSection title="分类与同步目标">
        <ClassifyPanel
          detail={detail}
          readOnly={readOnly}
          onDirtyChange={setClassifyDirty}
          onAction={runOp}
          actionsTarget={classifyEditable ? footLeft : null}
          onEditableChange={setClassifyEditable}
        />
      </FormSection>

      {/* 8. 默认折叠：技术错误 + 操作记录 */}
      {(detail.lastError || (detail.audit && detail.audit.length > 0)) && (
        <details className="collapsible">
          <summary>操作记录与技术细节</summary>
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
                  <span className="muted">{fmtDateTime(a.at)}</span> · {a.actor || "系统"} ·{" "}
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

/**
 * 人工分类与同步：
 * - 项目、目标列、至少一个工作区标签必填；负责人可选；
 * - 「保存分类」= 暂存（允许缺项）；「保存并同步」= 完整校验后固定快照并入队；
 * - 切换项目立即清空列/标签/负责人，并用请求序号 + 当前项目校验丢弃迟到响应；
 * - 已进入同步队列或已同步的记录锁定分类（只读展示）；回收站记录整体只读。
 * - 保存按钮经 portal 渲染到抽屉底部操作区（分类编辑时是主操作）。
 */
function ClassifyPanel({
  detail,
  readOnly,
  onDirtyChange,
  onAction,
  actionsTarget,
  onEditableChange,
}: {
  detail: FeedbackDetail;
  readOnly: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onAction: (fn: () => Promise<unknown>) => Promise<void>;
  /** 抽屉底部操作区左半部分的 DOM 容器；非空时保存按钮 portal 到其中。 */
  actionsTarget: HTMLElement | null;
  onEditableChange: (editable: boolean) => void;
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
  const [notice, setNotice] = useState<string | null>(null);
  const [labelQuery, setLabelQuery] = useState("");
  const seqRef = useRef(0);
  /** 软件默认项目/列只用于**首次**预填；用户手动切换项目后不再自动选择任何列。 */
  const autoPrefillRef = useRef(true);
  /** 上次从服务端应用到表单的分类版本：轮询刷新 detail 对象时不得覆盖草稿。 */
  const appliedVersionRef = useRef(detail.classification?.version ?? -1);
  /**
   * 脏标记只在用户主动修改时置位（自动预填不算未保存修改）；
   * 保存成功后服务端版本回写表单时清除。
   */
  const dirtyRef = useRef(false);

  // 是否可编辑：供父级决定是否在底部操作区渲染保存按钮。
  useEffect(() => {
    onEditableChange(!locked);
    return () => onEditableChange(false);
  }, [locked, onEditableChange]);

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
  const selectedLabels = (options?.labels ?? []).filter((l) => state.labelIds.includes(l.id));
  const filteredLabels = (options?.labels ?? []).filter(
    (l) => !labelQuery || l.name.toLowerCase().includes(labelQuery.toLowerCase()),
  );

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
    setLabelQuery("");
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
      setNotice("同步前必须选择项目、目标列与至少一个工作区标签");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await onAction(() =>
        api.post<{ ok: boolean; classifyVersion: number }>(`/api/admin/feedback/${detail.id}/classify`, {
          action: mode,
          classifyVersion: detail.classification?.version ?? 0,
          operationId: crypto.randomUUID(),
          projectId: state.projectId || null,
          columnId: state.columnId || null,
          columnSlug: column?.slug ?? null,
          labelIds: state.labelIds,
          assigneeId: state.assigneeId || null,
          assigneeName: (options?.members ?? []).find((m) => m.id === state.assigneeId)?.name ?? null,
        }),
      );
      setNotice(mode === "archive" ? "已固定同步目标并入队" : "已保存");
    } catch {
      /* 错误由父级内联展示 */
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
        <dt>负责人</dt>
        <dd>{c?.assigneeName ?? "—"}</dd>
        <dt>标签</dt>
        <dd>{c && c.labelIds.length > 0 ? c.labelIds.join("、") : "—"}</dd>
      </dl>
    );
  }

  return (
    <div>
      <div className="form-grid">
        <span>项目</span>
        <span>
          <select
            aria-label="Kaneo 项目"
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
        <span>目标列</span>
        <span>
          <select
            aria-label="目标列"
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
        <span>负责人（可选）</span>
        <span>
          <select
            aria-label="负责人"
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
        {(options?.labels ?? []).length > 0 && (
          <div className="label-picker-box">
            <div className="label-picker-search">
              <input
                type="text"
                placeholder="搜索标签"
                aria-label="搜索标签"
                value={labelQuery}
                disabled={locked}
                onChange={(e) => setLabelQuery(e.target.value)}
              />
            </div>
            <div className="label-picker-list">
              {filteredLabels.map((l) => (
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
              {filteredLabels.length === 0 && (
                <p className="muted small" style={{ margin: "var(--sp-2)" }}>
                  没有匹配的标签
                </p>
              )}
            </div>
          </div>
        )}
        {selectedLabels.length > 0 && (
          <div className="label-pills">
            {selectedLabels.map((l) => (
              <span key={l.id} className="label-pill">
                {l.name}
                {!locked && (
                  <button type="button" aria-label={`移除标签 ${l.name}`} onClick={() => toggleLabel(l.id)}>
                    <Icon name="close" size={12} />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
      {notice && <p className={notice.includes("必须") ? "err" : "ok-text"}>{notice}</p>}
      {locked && !readOnly && <p className="muted small">该记录已进入同步流程或已同步，分类已锁定。</p>}
      {!locked && !complete && (
        <p className="muted small" style={{ marginTop: "var(--sp-2)" }}>
          同步前请补齐项目、目标列与标签
        </p>
      )}
      {/* 保存按钮 portal 到抽屉底部操作区 */}
      {!locked &&
        actionsTarget &&
        createPortal(
          <>
            <button type="button" className="btn" disabled={busy} onClick={() => void submit("save")}>
              保存分类
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !complete}
              onClick={() => void submit("archive")}
            >
              保存并同步
            </button>
          </>,
          actionsTarget,
        )}
    </div>
  );
}
