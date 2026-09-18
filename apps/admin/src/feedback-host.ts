import type { FeedbackWidget } from "@feedback/web";
import { ApiError, type AppItem, api } from "./api";

/**
 * 管理后台自持反馈组件的宿主会话编排：
 * 内嵌的 <feedback-widget> 不携带 Cookie（组件跨源安全模型要求 Bearer），
 * 这里用后台自身的管理员 Cookie 会话调 `POST /api/auth/handshake` 换握手令牌，
 * 注入组件并按令牌寿命周期续注——管理员无需在组件内二次登录。
 *
 * 握手要求软件已登记且当前来源在 allowedOrigins 内：本模块会自动登记
 * `com.feedback.admin`（缺失则创建、缺当前 origin 则补进白名单），
 * 登记动作与软件管理页的手工操作等价、全部走管理员会话留痕。
 *
 * 任何一步失败（未登录、网络、权限）组件都回退为面板内自登录，不影响后台功能。
 */

const ADMIN_APP_ID = "com.feedback.admin";
const ADMIN_APP_NAME = "Feedback 管理后台";
/** 失败重试间隔；成功续注按 expiresIn 的 60% 并夹在 [1min, 10min]（默认 TTL 15min）。 */
const RETRY_MS = 60_000;
const MIN_REFRESH_MS = 60_000;
const MAX_REFRESH_MS = 10 * 60_000;

interface HandshakeResponse {
  accessToken: string;
  /** 秒。 */
  expiresIn: number;
  /** ISO 时间串。 */
  expiresAt: string;
}

export function startFeedbackHostSession(widget: FeedbackWidget): () => void {
  const origin = window.location.origin;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const schedule = (ms: number) => {
    if (!stopped) timer = setTimeout(() => void tick(), ms);
  };

  const handshake = () => api.post<HandshakeResponse>("/api/auth/handshake", { appId: ADMIN_APP_ID, origin });

  const ensureAdminApp = async () => {
    const { apps } = await api.get<{ apps: AppItem[] }>("/api/admin/apps");
    const existing = apps.find((a) => a.appId === ADMIN_APP_ID);
    if (!existing) {
      // 并发创建（两个后台页签同时跑）返回 app_exists：下一轮握手自然成功，不视为失败。
      await api
        .post("/api/admin/apps", { appId: ADMIN_APP_ID, name: ADMIN_APP_NAME, allowedOrigins: [origin] })
        .catch((e: unknown) => {
          if (!(e instanceof ApiError && e.code === "app_exists")) throw e;
        });
      return;
    }
    if (existing.allowedOrigins.includes(origin)) return;
    await addAllowedOrigin(existing);
  };

  /** 已登记但缺当前访问来源（换域名 / 端口 / IP 访问）：补进白名单。PUT 为全量保存语义。 */
  const addAllowedOrigin = async (app: AppItem) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const fresh =
        attempt === 0
          ? app
          : (await api.get<{ apps: AppItem[] }>("/api/admin/apps")).apps.find((a) => a.appId === ADMIN_APP_ID);
      if (!fresh || fresh.allowedOrigins.includes(origin)) return;
      try {
        await api.put(`/api/admin/apps/${fresh.id}`, {
          name: fresh.name,
          allowedOrigins: [...fresh.allowedOrigins, origin],
          kaneoProjectId: fresh.kaneoProjectId,
          kaneoColumnSlug: fresh.kaneoColumnSlug,
          kaneoColumnId: fresh.defaults.columnId,
          kaneoLabelIds: fresh.defaults.labelIds,
          kaneoAssigneeId: fresh.defaults.assigneeId,
          kaneoAssigneeName: fresh.defaults.assigneeName,
          expectedRuleVersion: fresh.ruleVersion,
        });
        return;
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "version_conflict")) throw e;
      }
    }
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const res = await handshake();
      widget.adoptSession({ accessToken: res.accessToken, expiresAt: res.expiresAt });
      // expiresIn 异常（NaN 会被 setTimeout 当 0 形成紧循环）时按默认 TTL 兜底。
      const ttlMs = Number.isFinite(res.expiresIn) ? res.expiresIn * 1000 : 15 * 60_000;
      schedule(Math.min(Math.max(ttlMs * 0.6, MIN_REFRESH_MS), MAX_REFRESH_MS));
    } catch (e) {
      let wait = RETRY_MS;
      if (e instanceof ApiError && e.code === "unknown_app") {
        try {
          await ensureAdminApp();
          wait = 0; // 登记完成立即重试握手，尽快进入无缝态
        } catch {
          /* 预登记失败走常规重试 */
        }
      }
      schedule(wait);
    }
  };

  void tick();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    widget.dropSession();
  };
}
