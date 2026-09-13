// Web 平台实现：令牌仅存内存（刷新后需重新登录；服务侧会话仍可撤销）。
// 登录与原生端一致，走面板内用户名/密码表单（POST /api/auth/login + clientLabel + appId），
// 不再打开任何登录窗口。
import 'config.dart';
import 'token_store.dart';

/// Web 默认仓库：仅内存。
///
/// 内存仓库不跨服务持久化，故无需按 [config] 派生存储键；参数与原生实现
/// 保持一致，便于同一调用点（[createDefaultTokenStore]）条件导入。
FeedbackTokenStore createDefaultTokenStore(FeedbackConfig config) =>
    MemoryTokenStore();
