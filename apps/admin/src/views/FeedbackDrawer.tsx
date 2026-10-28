/**
 * 反馈详情抽屉（T5 固定内容顺序，优先展示阅读主体）：
 * 1. 标题 + 工单状态（主标签）、Kaneo 入口（头部）
 * 2. 原始反馈正文 + 图片（尺寸、「局部截图／已编辑」类标记，历史单图兼容）
 * 3. 工单状态与基本信息（工单状态主标签；处理状态降为灰度辅助；处理说明、软件/账号/时间/ID）
 * 4. Issue 对话记录与回复区（「回复」保持当前状态 /「回复并解决」置为已解决，共用同一输入框）
 * 5. Kaneo 撤销任务审计（保留既有任务、链接与历史，回复不删除也不重复创建任务）
 * 6. 恢复动作与回收站只读提示（异常与可用恢复入口保持可见）
 * 7. 默认折叠（.section-fold）：AI 整理、分类与同步目标、日志（摘要，展开看文件与内容）、技术信息
 *
 * 未保存的分类修改与未发送回复在关闭抽屉时提示放弃；轮询刷新不覆盖正在编辑的草稿与回复输入
 * （分类仅在 classification.version 变化时回写；对话仅在 dialogueVersion 变化时重取，
 *  5 秒原位刷新不打断输入、不清空草稿、不强制滚动）。
 * v12：标记已解决必须填写处理说明（1..2000 字符），走独立弹窗提交；
 * Kaneo 撤销任务区保留审计展示（含 cancelled 状态）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type AppItem,
  AUDIT_LABELS,
  api,
  type ClassifyOptions,
  type FeedbackDetail,
  type FeedbackDialogueResponse,
  type FeedbackImageMeta,
  ISSUE_STATUS_LABELS,
  type IssueStatus,
  issueTone,
  type KaneoCancellationTask,
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

/** v12 处理说明长度限制（与服务端一致）。 */
const RESOLUTION_NOTE_MAX = 2000;

/** 灯箱条目：统一的查看目标（初始反馈图片 / 消息图片附件）。 */
interface LightboxItem {
  url: string;
  title: string;
  meta?: string;
}

interface LightboxState {
  items: LightboxItem[];
  index: number;
}

/** 初始反馈图片的展示来源标记（服务端 capture/manual/edited；历史客户端 auto/screenshot 兼容）。 */
function imageSourceLabel(source: FeedbackImageMeta["source"]): string | null {
  if (source === "capture" || source === "auto") return "自动截图";
  if (source === "manual") return "手动添加";
  if (source === "edited") return "已编辑";
  if (source === "screenshot") return "历史截图";
  return null;
}

/**
 * 「局部截图」标记：按每张图片自己的 capture.region 判断（0..1 归一化、相对原始捕获视口，
 * 缺省=整窗）。无 capture 或无 region 的图片（手动添加/已编辑图）不显示该标记；
 * 旧服务无 images 字段时走 screenshot 回退分支，另行用顶层 screenshot.capture.region 判定。
 */
function imageMarks(img: FeedbackImageMeta): string | null {
  return img.capture?.region ? "局部截图" : null;
}

const CANCEL_STATUS_LABELS: Record<KaneoCancellationTask["status"], string> = {
  pending: "待处理",
  processing: "处理中",
  confirmed: "已确认删除",
  uncertain: "等待重试（结果不确定）",
  failed: "撤销失败",
  cancelled: "已停止派发",
};

/** 需要人工核对/重试的撤销状态（v12 起不再派发新任务，仅存量 uncertain/failed 可重试）。 */
const CANCEL_ACTIONABLE = new Set<KaneoCancellationTask["status"]>(["uncertain", "failed"]);
/** 警示外观的撤销状态。 */
const CANCEL_ALERT = new Set<KaneoCancellationTask["status"]>(["uncertain", "failed", "pending", "processing"]);

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
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);
  const [logPreview, setLogPreview] = useState<{ id: string; name: string; text: string } | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  // 对话数据与回复状态
  const [dialogue, setDialogue] = useState<FeedbackDialogueResponse | null>(null);
  const [dialogueLoading, setDialogueLoading] = useState(false);
  const [dialogueError, setDialogueError] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [replySubmitting, setReplySubmitting] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [retryingCancel, setRetryingCancel] = useState(false);
  /** 「标记已解决」弹窗：status=仅改状态（issue-status 接口）；message=回复并解决（messages 接口）。 */
  const [resolveModal, setResolveModal] = useState<{ kind: "status" | "message" } | null>(null);
  const [resolveNote, setResolveNote] = useState("");
  const [resolveSubmitting, setResolveSubmitting] = useState(false);

  /**
   * 对话重取守卫：记录已加载对话的 {id, dialogueVersion}。5 秒轮询刷新 detail 对象时
   * 版本未变就不重取——对话区不闪烁、不打断输入、不引起滚动位移；出现新消息/状态变更
   * （版本变化）或上次加载失败（守卫重置）时才重新拉取。
   */
  const dialogueKeyRef = useRef<{ id: string; version: number } | null>(null);
  const dialogueRequestRef = useRef(0);
  const dialogueIdRef = useRef<string | null>(null);
  const activeDetailId = detail && typeof detail === "object" ? detail.id : null;

  // 对象切换、详情不可用或卸载后，旧请求不能再更新内容、错误或已读状态。
  useEffect(() => {
    dialogueIdRef.current = activeDetailId;
    dialogueKeyRef.current = null;
    setDialogue(null);
    setDialogueError(null);
    setDialogueLoading(false);
    return () => {
      dialogueIdRef.current = null;
      dialogueRequestRef.current += 1;
    };
  }, [activeDetailId]);

  const loadDialogue = useCallback(async (fid: string) => {
    if (dialogueIdRef.current !== fid) return;
    const request = ++dialogueRequestRef.current;
    const isCurrent = () => request === dialogueRequestRef.current && dialogueIdRef.current === fid;
    setDialogueLoading(true);
    try {
      const data = await api.get<FeedbackDialogueResponse>(`/api/admin/feedback/${fid}/dialogue`);
      if (!isCurrent()) return;
      dialogueKeyRef.current = { id: fid, version: data.feedback.dialogueVersion ?? 0 };
      setDialogue(data);
      setDialogueError(null);
      // 如果有未读消息，自动上报已读
      const maxSeq = data.messages.length > 0 ? Math.max(...data.messages.map((m) => m.seq)) : 0;
      if (maxSeq > data.lastReadSeq) {
        api.post(`/api/admin/feedback/${fid}/read`, { lastReadSeq: maxSeq }).catch(() => undefined);
      }
    } catch (err) {
      if (!isCurrent()) return;
      dialogueKeyRef.current = null; // 失败不锁定守卫：下一次轮询/刷新自动重试
      setDialogueError(err instanceof ApiError ? `对话记录加载失败：${err.message}` : "对话记录加载失败，请重试。");
    } finally {
      if (isCurrent()) setDialogueLoading(false);
    }
  }, []);

  useEffect(() => {
    if (detail && typeof detail === "object") {
      const key = { id: detail.id, version: detail.dialogueVersion ?? 0 };
      const last = dialogueKeyRef.current;
      if (last && last.id === key.id && last.version === key.version) return; // 版本未变：原位保留
      dialogueKeyRef.current = key;
      void loadDialogue(detail.id);
    }
  }, [detail, loadDialogue]);

  const dialogueBusy = replySubmitting || statusUpdating || resolveSubmitting;
  /** 所有关闭入口共用：提交中保留现场，其他时候检查分类草稿与未发送回复。 */
  const requestClose = useCallback(() => {
    if (dialogueBusy) {
      toast("info", "正在提交，请等待操作完成后再关闭。");
      return;
    }
    if (classifyDirty || replyText.trim()) setDiscardAsk(true);
    else onClose();
  }, [classifyDirty, replyText, dialogueBusy, onClose, toast]);

  const discardDialog = discardAsk ? (
    <ConfirmDialog
      title="放弃未保存的内容？"
      body={
        <p>
          {classifyDirty && replyText.trim()
            ? "分类表单有未保存的修改，回复也尚未发送。关闭抽屉将丢弃这些内容。"
            : classifyDirty
              ? "分类表单有未保存的修改，关闭抽屉将丢弃这些修改。"
              : "回复尚未发送，关闭抽屉将丢弃输入的回复内容。"}
        </p>
      }
      confirmLabel="放弃并关闭"
      danger
      onConfirm={() => {
        setDiscardAsk(false);
        setReplyText("");
        onClose();
      }}
      onClose={() => setDiscardAsk(false)}
    />
  ) : null;

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
        {discardDialog}
      </Drawer>
    );
  }
  if (detail === "purged") {
    return (
      <Drawer title="反馈详情" onClose={requestClose}>
        <EmptyState title="该反馈已被彻底删除" hint="记录及其附件已清理，仅保留最小删除凭据。" />
        {discardDialog}
      </Drawer>
    );
  }
  if (detail === "error") {
    return (
      <Drawer title="反馈详情" onClose={requestClose}>
        <EmptyState
          title="详情加载失败"
          hint="网络或服务暂时不可用，可重试。"
          action={
            <button type="button" className="btn primary" onClick={onRetry}>
              重试
            </button>
          }
        />
        {discardDialog}
      </Drawer>
    );
  }

  const readOnly = detail.readOnly === true || detail.mgmtState === "trash";
  const available = new Set(detail.availableActions ?? []);
  const rev = detail.recovery?.revision;
  const fid = detail.id;
  /** 收窄后的详情别名：内部 async 闭包里 prop 收窄不生效，统一经 d 访问。 */
  const d: FeedbackDetail = detail;

  /**
   * v12 有序图片列表：详情接口优先，对话接口兜底；历史单图记录服务端兼容读取后
   * 同样出现在列表中。若旧服务未实现 images（缺失或为空）但仍有截图元数据，
   * 回退到旧 screenshot 端点渲染，保证历史单图可见。
   */
  const imageMetas: FeedbackImageMeta[] = detail.images ?? dialogue?.feedback.images ?? [];
  const imageItems: LightboxItem[] =
    imageMetas.length > 0
      ? imageMetas.map((img, i) => ({
          url: `/api/admin/feedback/${fid}/images/${img.id}`,
          title: img.filename || `图片 ${i + 1}`,
          meta: [
            img.width && img.height ? `${img.width}×${img.height}` : null,
            img.mime ?? null,
            formatBytes(img.byteSize),
          ]
            .filter(Boolean)
            .join(" · "),
        }))
      : detail.screenshot
        ? [
            {
              url: `/api/admin/feedback/${fid}/screenshot`,
              title: "截图",
              meta: `${detail.screenshot.width}×${detail.screenshot.height} · ${formatBytes(detail.screenshot.byteSize)}`,
            },
          ]
        : [];

  const openImages = (index: number) => setLightbox({ items: imageItems, index });

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

  /**
   * v12「标记已解决」：处理说明必填（1..2000）。
   * kind=status → issue-status 接口（仅改状态）；kind=message → messages 接口（回复 + resolve）。
   */
  async function submitResolve() {
    const modal = resolveModal;
    if (!modal) return;
    const note = resolveNote.trim();
    if (!note || note.length > RESOLUTION_NOTE_MAX) return;
    setResolveSubmitting(true);
    try {
      if (modal.kind === "message") {
        await api.post(`/api/admin/feedback/${d.id}/messages`, {
          text: replyText.trim(),
          issueStatusAction: "resolve",
          resolutionNote: note,
          expectedDialogueVersion: d.dialogueVersion,
        });
        setReplyText("");
      } else {
        await api.post(`/api/admin/feedback/${d.id}/issue-status`, {
          issueStatus: "resolved",
          resolutionNote: note,
          expectedDialogueVersion: d.dialogueVersion,
        });
      }
      setResolveModal(null);
      toast("ok", modal.kind === "message" ? "已回复并标记为「已解决」" : "已标记为「已解决」");
      onChanged();
      void loadDialogue(d.id);
    } catch (err) {
      toast("err", err instanceof ApiError ? err.message : "操作失败");
    } finally {
      setResolveSubmitting(false);
    }
  }

  return (
    <Drawer
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {detail.title || detail.text.slice(0, 40) || "（无标题）"}
          </span>
          {/* 主要标签：工单状态（issueStatus）；处理状态降为灰度辅助 */}
          <span className={`tag ${issueTone(detail.issueStatus)}`}>
            {ISSUE_STATUS_LABELS[detail.issueStatus ?? "open"] ?? detail.issueStatus ?? "新反馈"}
          </span>
          <span className="tag">{STATUS_LABELS[detail.status] ?? detail.status}</span>
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
      {/* 1. 原始反馈正文 + 图片（优先展示；尺寸与「局部截图／已编辑」类标记，历史单图兼容） */}
      <section>
        <h3>原始反馈（用户原话）</h3>
        <div style={{ whiteSpace: "pre-wrap" }}>{detail.text}</div>
        {imageMetas.length > 0 ? (
          <ul className="img-grid" aria-label="反馈图片">
            {imageMetas.map((img, i) => {
              const sourceLabel = imageSourceLabel(img.source);
              const regionMark = imageMarks(img);
              const marks = [sourceLabel, regionMark].filter(Boolean).join(" · ");
              return (
                <li key={img.id}>
                  <button
                    type="button"
                    className="img-thumb"
                    onClick={() => openImages(i)}
                    aria-label={`放大查看图片 ${i + 1}（${img.filename || img.mime}）`}
                  >
                    {/* 管理端同源 Cookie 直链；加载失败由浏览器占位图标兜底 */}
                    <img src={`/api/admin/feedback/${fid}/images/${img.id}`} alt={`反馈图片 ${i + 1}`} loading="lazy" />
                    <span className="img-thumb-meta">
                      {marks && <span>{marks}</span>}
                      <span>
                        {img.width && img.height ? `${img.width}×${img.height}` : img.mime} ·{" "}
                        {formatBytes(img.byteSize)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          detail.screenshot && (
            <div className="attach-item">
              <Icon name="image" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>
                  截图
                  {detail.screenshot.capture?.region && (
                    <span className="tag tone-info" style={{ marginLeft: "var(--sp-2)" }}>
                      局部截图
                    </span>
                  )}
                </div>
                <div className="muted small">
                  {detail.screenshot.width}×{detail.screenshot.height} · {formatBytes(detail.screenshot.byteSize)}
                </div>
              </div>
              <button type="button" className="btn sm" onClick={() => openImages(0)}>
                查看
              </button>
            </div>
          )
        )}
      </section>

      {/* 2. 工单状态（主标签）与基本信息；处理状态降为灰度辅助 */}
      <section>
        <dl className="kv">
          <dt>工单状态</dt>
          <dd>
            <div className="row" style={{ alignItems: "center", gap: 8 }}>
              {detail.issueStatus && (
                <span
                  className={`tag ${detail.issueStatus === "waiting_admin" ? "tone-warn" : detail.issueStatus === "waiting_user" ? "tone-info" : detail.issueStatus === "resolved" ? "tone-ok" : ""}`}
                >
                  {ISSUE_STATUS_LABELS[detail.issueStatus] ?? detail.issueStatus}
                </span>
              )}
              {!readOnly && (
                <select
                  aria-label="工单状态"
                  value={detail.issueStatus ?? "open"}
                  disabled={dialogueBusy}
                  onChange={async (e) => {
                    const nextSt = e.target.value as IssueStatus;
                    // v12：标记已解决必须先填写处理说明，弹窗内完成校验与提交。
                    if (nextSt === "resolved") {
                      setResolveNote("");
                      setResolveModal({ kind: "status" });
                      e.target.value = detail.issueStatus ?? "open";
                      return;
                    }
                    setStatusUpdating(true);
                    try {
                      await api.post(`/api/admin/feedback/${detail.id}/issue-status`, {
                        issueStatus: nextSt,
                        expectedDialogueVersion: detail.dialogueVersion,
                      });
                      toast("ok", `工单状态已更新为「${ISSUE_STATUS_LABELS[nextSt]}」`);
                      onChanged();
                      void loadDialogue(detail.id);
                    } catch (err) {
                      toast("err", err instanceof ApiError ? err.message : "更新工单状态失败");
                    } finally {
                      setStatusUpdating(false);
                    }
                  }}
                  style={{ width: "auto", padding: "2px 8px", fontSize: "13px" }}
                >
                  {Object.entries(ISSUE_STATUS_LABELS).map(([val, label]) => (
                    <option key={val} value={val}>
                      {label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </dd>
          {/* 处理状态（同步进度）：灰度辅助信息，不与工单状态主标签争抢 */}
          <dt>处理状态</dt>
          <dd className="muted">{STATUS_LABELS[detail.status] ?? detail.status}</dd>
          {(detail.resolutionNote ?? dialogue?.feedback.resolutionNote) && (
            <>
              <dt>处理说明</dt>
              <dd>
                <div style={{ whiteSpace: "pre-wrap" }}>
                  {detail.resolutionNote ?? dialogue?.feedback.resolutionNote}
                </div>
              </dd>
            </>
          )}
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

      {/* 3. Issue 对话时间线与回复 */}
      <section>
        <h3>Issue 对话记录</h3>
        {dialogueError && (
          <InlineError message={dialogueError} onRetry={dialogueLoading ? undefined : () => void loadDialogue(fid)} />
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", margin: "12px 0" }}>
          {/* 追加的消息时间线（原始反馈正文与图片已前置到「原始反馈」区，避免重复展示） */}
          {(dialogue?.messages ?? []).map((msg) => (
            <div
              key={msg.id}
              style={{
                padding: "10px 14px",
                background:
                  msg.senderType === "admin"
                    ? "var(--bg-admin-msg, #eef2ff)"
                    : msg.senderType === "system"
                      ? "var(--bg-subtle, #f3f4f6)"
                      : "var(--bg-user-msg, #f0fdf4)",
                borderRadius: "8px",
                borderLeft: `4px solid ${msg.senderType === "admin" ? "#6366f1" : msg.senderType === "system" ? "#94a3b8" : "#22c55e"}`,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                <div>
                  <strong>
                    {msg.senderType === "admin"
                      ? `管理员（${msg.senderName}）`
                      : msg.senderType === "system"
                        ? `系统（${msg.senderName}）`
                        : `用户（${msg.senderName}）`}
                  </strong>
                  <span className="muted small" style={{ marginLeft: "8px" }}>
                    #{msg.seq}
                  </span>
                </div>
                <span className="muted small">{new Date(msg.createdAt).toLocaleString()}</span>
              </div>
              <div style={{ whiteSpace: "pre-wrap" }}>{msg.text}</div>
              {msg.resolutionNote && (
                <div
                  className="muted small"
                  style={{ marginTop: "6px", paddingTop: "6px", borderTop: "1px dashed var(--border-subtle, #e2e8f0)" }}
                >
                  处理说明：<span style={{ whiteSpace: "pre-wrap" }}>{msg.resolutionNote}</span>
                </div>
              )}
              {msg.attachments && msg.attachments.length > 0 && (
                <div style={{ marginTop: "8px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  {msg.attachments.map((att) => {
                    const url = `/api/feedback/messages/attachments/${att.id}`;
                    const isImage = att.kind === "image" || att.kind === "screenshot";
                    if (isImage) {
                      // 图片附件渲染为缩略图，点击在灯箱内放大（同源 Cookie 直链）。
                      return (
                        <button
                          key={att.id}
                          type="button"
                          className="img-thumb"
                          onClick={() =>
                            setLightbox({
                              items: [
                                {
                                  url,
                                  title: att.filename,
                                  meta: [
                                    att.width && att.height ? `${att.width}×${att.height}` : null,
                                    att.mime ?? null,
                                    formatBytes(att.byteSize),
                                  ]
                                    .filter(Boolean)
                                    .join(" · "),
                                },
                              ],
                              index: 0,
                            })
                          }
                          aria-label={`放大查看图片附件 ${att.filename}`}
                        >
                          <img src={url} alt={att.filename} loading="lazy" />
                          <span className="img-thumb-meta">
                            <span>{formatBytes(att.byteSize)}</span>
                          </span>
                        </button>
                      );
                    }
                    return (
                      <a key={att.id} className="btn sm" href={url} target="_blank" rel="noreferrer">
                        <Icon name="file" size={14} />
                        {att.filename} ({formatBytes(att.byteSize)})
                      </a>
                    );
                  })}
                </div>
              )}
            </div>
          ))}

          {dialogueLoading && (
            <div className="muted small" style={{ textAlign: "center" }}>
              加载对话记录中…
            </div>
          )}
        </div>

        {/* 管理员回复区：「回复」与「回复并解决」共用同一输入框，主次分明；管理员回复暂不支持附件 */}
        {!readOnly && (
          <div style={{ marginTop: "16px", padding: "12px", border: "1px solid var(--border)", borderRadius: "8px" }}>
            <div className="muted small" style={{ marginBottom: "8px" }}>
              「回复」= 追加一条消息并保持当前工单状态；「回复并解决」=
              发送同一条消息并将工单置为「已解决」（需在弹窗填写处理说明）。管理员回复暂不支持附件。
            </div>
            <textarea
              value={replyText}
              placeholder="输入回复内容，向用户补充信息或告知排查结果…"
              rows={3}
              style={{ width: "100%", boxSizing: "border-box" }}
              onChange={(e) => setReplyText(e.target.value)}
              disabled={dialogueBusy}
              aria-label="回复内容"
            />
            <div className="row row-wrap" style={{ marginTop: "8px", gap: "8px" }}>
              <button
                type="button"
                className="btn primary"
                disabled={dialogueBusy || !replyText.trim()}
                onClick={async () => {
                  setReplySubmitting(true);
                  try {
                    // 不带 issueStatusAction：服务端保持当前工单状态（旧入口传 reply 会强制置为待用户补充）
                    await api.post(`/api/admin/feedback/${detail.id}/messages`, {
                      text: replyText.trim(),
                      expectedDialogueVersion: detail.dialogueVersion,
                    });
                    setReplyText("");
                    toast(
                      "ok",
                      `已发送回复（工单状态保持「${ISSUE_STATUS_LABELS[detail.issueStatus ?? "open"] ?? detail.issueStatus ?? "新反馈"}」）`,
                    );
                    onChanged();
                    void loadDialogue(detail.id);
                  } catch (err) {
                    toast("err", err instanceof ApiError ? err.message : "发送失败");
                  } finally {
                    setReplySubmitting(false);
                  }
                }}
              >
                {replySubmitting ? "发送中…" : "回复"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={dialogueBusy || !replyText.trim()}
                title="发送同一条回复，并将工单置为「已解决」（需填写处理说明）"
                onClick={() => {
                  setResolveNote("");
                  setResolveModal({ kind: "message" });
                }}
              >
                回复并解决
              </button>
            </div>
          </div>
        )}
      </section>

      {actionErr && <InlineError message={actionErr} />}

      {/* Kaneo 撤销任务审计区：v12 起回复不再登记新撤销任务，存量记录（含 cancelled）保留展示供核对 */}
      {dialogue?.cancellation && (
        <section
          className="cancel-section"
          data-tone={CANCEL_ALERT.has(dialogue.cancellation.status) ? "warn" : "quiet"}
        >
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ minWidth: 0 }}>
              <strong
                style={{
                  color: CANCEL_ALERT.has(dialogue.cancellation.status)
                    ? "var(--warn-text, #b45309)"
                    : "var(--muted, #64748b)",
                }}
              >
                Kaneo 撤销任务：{CANCEL_STATUS_LABELS[dialogue.cancellation.status] ?? dialogue.cancellation.status}
              </strong>
              <div className="muted small" style={{ marginTop: "4px" }}>
                原任务 <code>{dialogue.cancellation.kaneo_task_id}</code> · 归档轮次{" "}
                {dialogue.cancellation.archive_round} · 尝试 {dialogue.cancellation.attempts} 次
                {dialogue.cancellation.confirmed_at &&
                  ` · 删除确认于 ${new Date(dialogue.cancellation.confirmed_at).toLocaleString()}`}
                {dialogue.cancellation.last_error && ` · 错误：${dialogue.cancellation.last_error}`}
              </div>
              <div className="muted small" style={{ marginTop: "4px" }}>
                v12 起回复不再删除 Kaneo 任务；此处仅为 v11 存量撤销任务的审计展示，行与记录保留供人工核对。
              </div>
            </div>
            {!readOnly && CANCEL_ACTIONABLE.has(dialogue.cancellation.status) && (
              <button
                type="button"
                className="btn sm"
                disabled={retryingCancel}
                onClick={async () => {
                  setRetryingCancel(true);
                  try {
                    await api.post(`/api/admin/feedback/${detail.id}/cancellation/retry`);
                    toast("ok", "已重新安排 Kaneo 撤销任务");
                    void loadDialogue(detail.id);
                  } catch (err) {
                    toast("err", err instanceof ApiError ? err.message : "重试失败");
                  } finally {
                    setRetryingCancel(false);
                  }
                }}
              >
                {retryingCancel ? "重试中…" : "立即重试撤销"}
              </button>
            )}
          </div>
        </section>
      )}

      {/* 日志附件已移至折叠分组（默认摘要、展开看文件与内容）；图片移至「原始反馈」区 */}

      {/* 恢复动作 */}
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

      {/* ---- 默认折叠分组（.section-fold）：AI 整理 → 分类与同步 → 日志 ---- */}
      {detail.processed && (
        <details className="collapsible section-fold">
          <summary>AI 整理结果</summary>
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
        </details>
      )}

      {/* 分类与同步目标：默认折叠（回收站只读展示不变） */}
      <details className="collapsible section-fold">
        <summary>分类与同步目标</summary>
        <ClassifyPanel detail={detail} readOnly={readOnly} onDirtyChange={setClassifyDirty} onAction={runOp} />
      </details>

      {/* 日志附件：默认只呈现轻量摘要，展开后查看文件与逐条内容（沿用既有预览/下载接口） */}
      {(detail.logs ?? []).length > 0 && (
        <details className="collapsible section-fold">
          <summary>
            日志附件（{(detail.logs ?? []).length} 个 · 共{" "}
            {formatBytes((detail.logs ?? []).reduce((sum, l) => sum + l.byteSize, 0))}）
          </summary>
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
        </details>
      )}

      {/* 8. 默认折叠：技术错误 + 操作记录 */}
      {(detail.lastError || (detail.audit && detail.audit.length > 0)) && (
        <details className="collapsible section-fold">
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
      {lightbox && lightbox.items.length > 0 && (
        <Modal
          title={
            lightbox.items.length > 1
              ? `图片预览（${lightbox.index + 1}/${lightbox.items.length}）`
              : (lightbox.items[lightbox.index]?.title ?? "图片预览")
          }
          onClose={() => setLightbox(null)}
          wide
        >
          <div style={{ textAlign: "center" }}>
            <img
              className="lightbox-img"
              src={lightbox.items[lightbox.index]?.url}
              alt={lightbox.items[lightbox.index]?.title ?? "图片预览"}
            />
            {lightbox.items[lightbox.index]?.meta && (
              <div className="muted small" style={{ marginTop: "8px" }}>
                {lightbox.items[lightbox.index]?.title} · {lightbox.items[lightbox.index]?.meta}
              </div>
            )}
            {lightbox.items.length > 1 && (
              <div className="row" style={{ justifyContent: "center", gap: "8px", marginTop: "8px" }}>
                <button
                  type="button"
                  className="btn sm"
                  disabled={lightbox.index === 0}
                  onClick={() => setLightbox((s) => (s ? { ...s, index: Math.max(0, s.index - 1) } : s))}
                >
                  上一张
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={lightbox.index >= lightbox.items.length - 1}
                  onClick={() =>
                    setLightbox((s) => (s ? { ...s, index: Math.min(s.items.length - 1, s.index + 1) } : s))
                  }
                >
                  下一张
                </button>
              </div>
            )}
          </div>
        </Modal>
      )}
      {resolveModal && (
        <Modal
          title={resolveModal.kind === "message" ? "回复并解决" : "标记「已解决」"}
          onClose={() => {
            if (!resolveSubmitting) setResolveModal(null);
          }}
          actions={
            <>
              <button type="button" className="btn" disabled={resolveSubmitting} onClick={() => setResolveModal(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={
                  resolveSubmitting || resolveNote.trim().length === 0 || resolveNote.length > RESOLUTION_NOTE_MAX
                }
                onClick={() => void submitResolve()}
              >
                {resolveSubmitting ? "提交中…" : resolveModal.kind === "message" ? "发送回复并解决" : "确认标记已解决"}
              </button>
            </>
          }
        >
          <p className="muted small" style={{ marginTop: 0 }}>
            {resolveModal.kind === "message"
              ? "将发送输入框中的回复，并把工单置为「已解决」（与「回复」共用同一条消息）。"
              : "仅更新工单状态，不发送新消息。"}
            标记已解决必须填写处理说明（1–2000 字），随状态变更入库并对用户可见。
          </p>
          <textarea
            value={resolveNote}
            rows={4}
            maxLength={RESOLUTION_NOTE_MAX}
            placeholder="说明处理结果，例如已修复的版本、规避方式或结论…"
            aria-label="处理说明（必填）"
            style={{ width: "100%", boxSizing: "border-box" }}
            onChange={(e) => setResolveNote(e.target.value)}
            disabled={resolveSubmitting}
          />
          <div className="muted small" style={{ textAlign: "right" }}>
            {resolveNote.trim().length}/{RESOLUTION_NOTE_MAX}
          </div>
          {resolveNote.trim().length === 0 && <p className="err small">请填写处理说明后再标记已解决。</p>}
        </Modal>
      )}
      {logPreview && (
        <Modal title={logPreview.name} onClose={() => setLogPreview(null)} wide>
          <pre className="log-pre">{logPreview.text}</pre>
        </Modal>
      )}
      {discardDialog}
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
