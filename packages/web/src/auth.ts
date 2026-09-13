import { ApiError } from './api';

/**
 * 令牌登录使用的客户端标签（后台会话列表据此辨识来源）。
 * 形如 `web:<appId>`，长度受服务端 100 字符上限约束。
 */
export function webClientLabel(appId: string): string {
  return `web:${appId}`.slice(0, 100);
}

/** 登录失败提示（可安全展示）。区分凭据错误、来源未允许、限流与网络异常。 */
export function loginErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'invalid_credentials':
        return '用户名或密码错误';
      case 'rate_limited':
        return '尝试过于频繁，请稍后再试';
      case 'origin_not_allowed':
        return '当前页面来源未被该应用允许登录，请联系管理员';
      case 'unknown_app':
        return '应用未在服务端登记（请检查 app-id 配置）';
      default:
        return err.message;
    }
  }
  return '网络异常，登录失败，请稍后重试';
}
