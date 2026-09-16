/** 对外 HTTP DTO（与 docs/api.md 一致）。 */

export interface ErrorBody {
  error: { code: string; message: string };
}

export interface SubmitFeedbackRequest {
  idempotencyKey: string;
  appId: string;
  /** 可选：组件上报的软件名称（未提供时显示 appId；绝不覆盖管理员已设置的名称）。 */
  appName?: string;
  text: string;
  context?: { appVersion?: string; pageLabel?: string };
}

export interface SubmitFeedbackResponse {
  feedbackId: string;
  status: string;
  replayed?: boolean;
  /** T4：等待配置 / 等待来源确认 / 等待人工归档 / 已排队。旧组件可忽略。 */
  collectionState?: CollectionState;
}

export interface FeedbackStatusResponse {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  errorSummary?: string | null;
  kaneoUrl?: string | null;
  collectionState?: CollectionState;
}

export interface ProcessedFeedback {
  title: string;
  sections: {
    experience: string;
    problems: string;
    suggestions: string;
    questions: string;
  };
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
  /** ---- v7：先接收后配置 / 自动归档规则 ---- */
  /** 名称来源：admin=管理员设置（客户端不可覆盖），client=组件上报。 */
  nameSource: "client" | "admin";
  /** 配置状态：pending=待配置（自动发现），configured=管理员已配置。 */
  configStatus: "pending" | "configured";
  archiveMode: "manual" | "automatic";
  /** 规则版本：默认目标或归档模式变化时自增，用于并发与页面过期检查。 */
  ruleVersion: number;
  /** 默认归档目标（自动归档规则来源）。 */
  defaults: {
    projectId: string;
    columnId: string;
    columnSlug: string;
    labelIds: string[];
    assigneeId: string | null;
    assigneeName: string | null;
  };
  /** 规则是否完整（项目 + 列 + ≥1 工作区标签）。 */
  ruleComplete: boolean;
  autoEnabledAt: string | null;
  autoEnabledBy: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  /** 后台列表用统计。 */
  pendingSources: number;
  confirmedSources: number;
  waitingFeedbacks: number;
}

/** 软件来源（待确认 / 已确认）。 */
export interface PublicAppSource {
  origin: string;
  kind: "browser" | "native";
  status: "pending" | "confirmed";
  firstSeenAt: string;
  lastSeenAt: string;
  confirmedAt: string | null;
  confirmedBy: string | null;
}

/** T4：组件侧展示的收集状态。 */
export type CollectionState =
  | "waiting_configuration"
  | "waiting_source_confirmation"
  | "waiting_manual_archive"
  | "queued";
