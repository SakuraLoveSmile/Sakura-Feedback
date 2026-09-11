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
