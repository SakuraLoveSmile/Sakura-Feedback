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

/**
 * 基于日志的诊断（可选；旧结果可能缺失，读取方必须容忍）。
 * 三个字段分别承载事实证据、可能原因与明确标注的推测，绝不把日志直接当成已证实根因。
 */
export interface FeedbackDiagnostics {
  /** 日志中可直接读到的事实（可引用原文片段）。 */
  logEvidence: string;
  /** 由日志与用户描述推出的可能原因（未证实）。 */
  possibleCauses: string;
  /** 无法由日志证实、明确标注为推测的部分。 */
  speculation: string;
}

export interface ProcessedFeedback {
  title: string;
  sections: {
    experience: string;
    problems: string;
    suggestions: string;
    questions: string;
  };
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
