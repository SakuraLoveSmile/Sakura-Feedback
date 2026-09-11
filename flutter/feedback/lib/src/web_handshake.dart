/// Web 登录握手的结果（契约「Web 登录握手时序」第 1–5 步）。
class WebHandshakeResult {
  /// 握手成功，拿到短期访问令牌。
  const WebHandshakeResult.ok(String this.accessToken, {this.expiresAt})
      : success = true,
        popupBlocked = false,
        error = null;

  /// 弹窗被浏览器拦截：宿主应展示普通按钮入口由用户主动重试。
  const WebHandshakeResult.blocked()
      : success = false,
        popupBlocked = true,
        accessToken = null,
        expiresAt = null,
        error = null;

  /// 其它失败（用户关闭窗口 / 超时 / 校验不过）。
  const WebHandshakeResult.fail(String this.error)
      : success = false,
        popupBlocked = false,
        accessToken = null,
        expiresAt = null;

  /// 是否拿到了令牌。
  final bool success;

  /// 弹窗是否被拦截。
  final bool popupBlocked;

  /// 短期访问令牌（仅内存）。
  final String? accessToken;

  /// 令牌过期时间（若握手消息携带）。
  final DateTime? expiresAt;

  /// 失败原因（可安全展示给用户）。
  final String? error;
}
