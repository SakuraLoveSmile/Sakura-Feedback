/** 对外 HTTP DTO（与 docs/api.md 一致）。 */

export interface ErrorBody {
  error: { code: string; message: string };
}

export interface SubmitFeedbackRequest {
  idempotencyKey: string;
  appId: string;
  text: string;
  context?: { appVersion?: string; pageLabel?: string };
}

export interface SubmitFeedbackResponse {
  feedbackId: string;
  status: string;
  replayed?: boolean;
}

export interface FeedbackStatusResponse {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  errorSummary?: string | null;
  kaneoUrl?: string | null;
}

export interface ProcessedFeedback {
  title: string;
  sections: {
    experience: string;
    problems: string;
    suggestions: string;
    questions: string;
  };
  /**
   * 日志诊断（可选，见 docs/api.md L7）：
   * 旧记录 / 未参与日志整理的记录缺省；缺失时解析与展示都必须兼容。
   * 该字段一律由 AI 结果解析产出，不接受宿主输入。
   */
  diagnostics?: FeedbackDiagnostics;
}

export interface PublicApp {
  id: string;
  appId: string;
  name: string;
  allowedOrigins: string[];
  kaneoProjectId: string;
  kaneoColumnSlug: string;
  createdAt: string;
  updatedAt: string;
}

// =====================================================================================
// 日志（logs）契约 DTO —— 规范文本见 docs/api.md「日志（logs）契约（v2 追加）」。
// 本文件只放类型：不写运行时逻辑、不定义运行时常量（上限数值在 docs/api.md L1 逐字定稿，
// 下面用字面量类型固化，供实现者比对）。
// =====================================================================================

/** 日志来源：`auto` = 宿主 logProvider 回调自动采集；`manual` = 用户在面板手动补充。 */
export type FeedbackLogSource = "auto" | "manual";

/** 单次提交的 `logs` 部件数量上限。 */
export type MaxLogFiles = 3;
/** 单个日志部件的原始字节上限（1 MiB）。 */
export type MaxLogBytesPerFile = 1048576;
/** 全部日志部件原始字节之和上限（3 MiB）。 */
export type MaxLogsTotalBytes = 3145728;
/** multipart 请求体总字节上限（9 MiB）。 */
export type MaxMultipartBytes = 9437184;
/** 清洗后存储的安全文件名长度上限。 */
export type MaxLogFilenameChars = 255;
/** 单份日志送入 AI 的末尾码点数上限。 */
export type MaxLogTailCodepoints = 8000;
/** 全部日志送入 AI 的码点总数上限（等价于 3 × 8000）。 */
export type MaxLogsTailCodepoints = 24000;

/** `metadata.logs[i]`：与第 i 个 `logs` 部件按**部件出现顺序**一一对应（`seq = i`，0 起）。 */
export interface FeedbackLogPartMeta {
  /** 权威显示名：1..255 字符，扩展名必须在白名单内；服务端清洗后作为存储文件名。 */
  name: string;
  source: FeedbackLogSource;
}

/** 客户端内存中的一份日志字节（Web / Flutter 提交前形态；`logs` 部件体即 `bytes`）。 */
export interface FeedbackLogDraft {
  name: string;
  source: FeedbackLogSource;
  bytes: Uint8Array;
}

/** multipart 变体的 `capture` 线格式（与既有截图契约一致，命名定稿）。 */
export interface FeedbackCaptureInfoWire {
  /** 逻辑 CSS 视口尺寸。 */
  viewportWidth?: number;
  viewportHeight?: number;
  /** 最终 PNG 实际输出像素（1..65535 整数，成对出现）。 */
  pixelWidth?: number;
  pixelHeight?: number;
  capturedAt?: string;
  releasePoint?: { x: number; y: number };
}

/** `POST /api/feedback` 的 multipart `metadata` 部件 JSON（严格白名单：未知字段忽略，见既有契约）。 */
export interface SubmitFeedbackMultipartMetadata extends SubmitFeedbackRequest {
  capture?: FeedbackCaptureInfoWire;
  /** 可选；缺省或 `[]` 均表示不带日志。长度必须与 `logs` 部件数量一致。 */
  logs?: FeedbackLogPartMeta[];
}

/** 服务端持久化后的日志元数据（仅存在于鉴权后的管理接口 JSON 里，绝不包含公开 URL）。 */
export interface FeedbackLogMeta {
  /** 服务端生成的日志 id（`randomUUID()`）；`archive_data_json.logs` 的键即此值。 */
  id: string;
  feedbackId: string;
  /** 0 起的序号，与提交时 `metadata.logs` 下标、`logs` 部件顺序、归档顺序严格一致。 */
  seq: number;
  /** 服务端清洗后的安全文件名。 */
  filename: string;
  source: FeedbackLogSource;
  byteSize: number;
  sha256: string;
  createdAt: string;
  /**
   * 按 L7「末尾 8000 码点」规则该份日志**是否会**被截取：
   * 依据已落库字节 + L7 解码规则（严格 UTF-8、剥单个 BOM）计算，
   * 与它是否真的送过 AI 无关（客观属性，可持久化，须与 L7 一致且可回读）。
   */
  truncated: boolean;
  /** 该份日志按 L7 解码规则得到的总 Unicode 码点数（= `Array.from(text).length`）。 */
  totalCodepoints: number;
  /**
   * 该份日志在「归档存档数据 V2」（`archive_data_json` L8）中的附件确认进度，
   * 是 L9 `allAttachmentsConfirmed`（唯一权威判定）按 `logId` 拆开的**展示投影**
   * （从 archive_data_json 派生，不另立第二套判定、不用截图状态推测）。
   */
  archiveState: FeedbackLogArchiveState;
}

/**
 * 单份日志的归档确认进度（`LogMeta.archiveState`）：
 * - `confirmed`：该日志 `asset.url` 非空 **且** `comment.outcome === "confirmed"`；
 * - `partial`：V2 的 `logs[logId]` 下已有 upload/asset/comment 任一记录，但未达 confirmed；
 * - `not_started`：V2 中该 `logId` 无任何记录（含记录仍为 V1 的旧数据）。
 */
export type FeedbackLogArchiveState = "not_started" | "partial" | "confirmed";

/** `GET /api/admin/feedback/:id/logs` 响应；`logs` 按 `seq` 升序（0..n-1）。 */
export interface FeedbackLogListResponse {
  logs: FeedbackLogMeta[];
}

/** 管理列表项追加字段（无日志为 0，不得缺省）。 */
export interface AdminFeedbackLogCount {
  logCount: number;
}

/** 管理详情追加字段（`logs` 恒为数组，按 `seq` 升序；无日志为 `[]`）。 */
export interface AdminFeedbackLogDetail {
  logCount: number;
  logs: FeedbackLogMeta[];
}

/** 日志校验失败的错误码（HTTP 400，见 docs/api.md L3）。 */
export type InvalidLogCode = "invalid_log";

// ---------- AI：日志输入与诊断（L7） ----------

/**
 * 送入 AI 的单份日志。由 worker 从**已落库字节**构造，绝不重新向宿主索取。
 * 顺序即 `seq` 升序；`tail` 为解码后文本的末尾至多 8000 个 Unicode 码点。
 */
export interface AiLogInput {
  seq: number;
  filename: string;
  source: FeedbackLogSource;
  sha256: string;
  byteSize: number;
  /** 末尾 ≤8000 码点的文本（BOM 已剥离，`<`/`>` 已替换为全角）。 */
  tail: string;
  /** 原始文本是否因 8000 码点上限被截取。 */
  truncated: boolean;
  /** 原始文本总码点数（截取前）。 */
  totalCodepoints: number;
  /** 实际送入提示词的码点数。 */
  includedCodepoints: number;
}

/** 模型摘录自日志原文，未逐字校验；**不得改写**。 */
export interface LogEvidenceItem {
  /** 必须携带且属于本次提供的日志序号集合（0 起，与 metadata.logs 下标一致）；缺失或越界的条目在解析时丢弃。 */
  seq: number;
  /** 展示字段：日志文件名，**允许重名**，不参与归属判定（归属只看 seq）。 */
  filename: string;
  /** 日志原文片段，1..500 码点。 */
  quote: string;
}

/** 推测：可能原因，**必须标注不确定**（置信度只允许 low/medium）。 */
export interface LogSpeculationItem {
  hypothesis: string;
  confidence: "low" | "medium";
  /** 该推测依赖的证据摘要（可选）。 */
  basedOn?: string;
}

/**
 * 日志诊断。`logEvidence` 与 `possibleCauses` 分属两个字段：
 * 证据与推测在任何展示层（管理页、Kaneo 任务描述）都必须可区分，禁止混用同一字段。
 */
export interface FeedbackDiagnostics {
  /** 模型摘录自日志原文，未逐字校验。 */
  logEvidence: LogEvidenceItem[];
  /** 由证据推断的可能原因（未证实，必须带 confidence）。 */
  possibleCauses: LogSpeculationItem[];
}
