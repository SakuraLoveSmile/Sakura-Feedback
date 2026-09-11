import { joinApi, randomNonce } from './api';

/** 握手成功的令牌交付（契约 §Web 登录握手时序 第 4 步的 message 载荷）。 */
export interface AuthMessage {
  type: 'feedback:auth';
  nonce: string;
  accessToken: string;
  expiresAt: string;
}

export interface HandshakeTicket {
  nonce: string;
  /** 登录页 URL（window.open 与降级 `<a target="_blank">` 共用）。 */
  loginUrl: string;
}

export interface LoginHandshakeOptions {
  apiBase: string;
  appId: string;
  /** 宿主窗口 origin（location.origin），作为 cb 参数。 */
  hostOrigin: string;
  onToken(token: AuthMessage): void;
  /** 弹窗被拦截（open 返回 null）或过早关闭时回调：UI 降级显示链接。 */
  onPopupBlocked(loginUrl: string): void;
}

/**
 * 严格按契约实现 Web 登录握手：
 * window.open 弹窗 + message 监听，校验 event.origin === 服务 origin 且 type/nonce 匹配。
 * 令牌只存内存（交由持有本实例的组件保存）。
 */
export class LoginHandshake {
  private readonly opts: LoginHandshakeOptions;
  private nonce: string | null = null;
  private closedTimer: ReturnType<typeof setInterval> | null = null;
  private listener: ((ev: MessageEvent) => void) | null = null;

  constructor(opts: LoginHandshakeOptions) {
    this.opts = opts;
  }

  /** 服务自身的 origin，用于 message 来源校验。 */
  serviceOrigin(): string {
    return new URL(this.opts.apiBase, 'http://localhost').origin;
  }

  /** 开始一次握手：生成 nonce、注册 message 监听、返回登录页 URL。 */
  start(): HandshakeTicket {
    this.cancel();
    const nonce = randomNonce();
    this.nonce = nonce;
    const cb = encodeURIComponent(this.opts.hostOrigin);
    const loginUrl = `${joinApi(this.opts.apiBase, '/login')}?appId=${encodeURIComponent(this.opts.appId)}&nonce=${nonce}&cb=${cb}`;

    // 严格校验：origin 必须等于服务 origin；type/nonce 必须匹配。
    const listener = (ev: MessageEvent): void => {
      if (ev.origin !== this.serviceOrigin()) return;
      const data = ev.data as Partial<AuthMessage> | null;
      if (!data || typeof data !== 'object') return;
      if (data.type !== 'feedback:auth') return;
      if (data.nonce !== this.nonce) return;
      if (typeof data.accessToken !== 'string' || typeof data.expiresAt !== 'string') return;
      this.stopWatching();
      this.detach();
      this.opts.onToken({
        type: 'feedback:auth',
        nonce: data.nonce,
        accessToken: data.accessToken,
        expiresAt: data.expiresAt,
      });
    };
    this.listener = listener;
    window.addEventListener('message', listener);

    return { nonce, loginUrl };
  }

  /** 在 start() 之后调用：真正开窗并监测拦截/过早关闭。 */
  openPopup(ticket: HandshakeTicket): void {
    const popup = window.open(ticket.loginUrl, 'feedback_login', 'popup,width=480,height=640');
    if (!popup) {
      // 弹窗被拦截：保留 message 监听（降级链接仍可能在新标签完成握手）。
      this.opts.onPopupBlocked(ticket.loginUrl);
      return;
    }
    this.closedTimer = setInterval(() => {
      if (popup.closed) {
        this.stopWatching();
        // 若已收到令牌，listener 已 detach；否则视为“closed 过早”，
        // 保留 listener 以便降级链接的新窗口继续交付令牌。
        if (this.listener) this.opts.onPopupBlocked(ticket.loginUrl);
      }
    }, 250);
  }

  private stopWatching(): void {
    if (this.closedTimer !== null) {
      clearInterval(this.closedTimer);
      this.closedTimer = null;
    }
  }

  private detach(): void {
    if (this.listener) {
      window.removeEventListener('message', this.listener);
      this.listener = null;
    }
    this.nonce = null;
  }

  cancel(): void {
    this.stopWatching();
    this.detach();
  }
}
