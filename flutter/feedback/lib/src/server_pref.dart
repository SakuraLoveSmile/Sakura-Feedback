/// T6：自定义 Feedback 服务器地址——规范化、校验与本机偏好存储。
///
/// 覆盖偏好按「宿主存储空间（原生安全存储 / Web localStorage 源）
/// + appId + 规范化默认地址」隔离：换默认地址或换 appId 时读到的是
/// 不同槽位，绝不把 A 服务的覆盖带到 B。偏好只存服务器地址——
/// 绝不持久化草稿、密码或令牌。
library;

import 'dart:convert';

export 'server_pref_store_io.dart'
    if (dart.library.js_interop) 'server_pref_store_web.dart';

/// 服务器地址规范化结果：成功时 [base] 为规范化地址，失败时 [reason] 为可读原因。
class ServerBaseNormalization {
  const ServerBaseNormalization._(this.base, this.reason);

  /// 规范化后的地址（无末尾斜杠；失败时为 null）。
  final String? base;

  /// 校验失败原因（成功时为 null）。
  final String? reason;

  /// 是否校验通过。
  bool get ok => base != null;
}

/// 规范化用户输入的服务器地址。
///
/// 规则：去空白 → 必须 http(s) → 主机非空 → 拒绝内嵌凭据 / 查询参数 / # 片段；
/// 输出为「协议小写 + host 小写 + 非默认端口 + 路径前缀（只去末尾斜杠，
/// 支持部署路径前缀）」。
///
/// [pageIsHttps] 为 true 时拒绝 http 覆盖：HTTPS 页面发起 HTTP 请求会被
/// 浏览器按混合内容拦截，提前在校验层给出可读原因。
ServerBaseNormalization normalizeServerBase(String raw,
    {bool pageIsHttps = false}) {
  final String trimmed = raw.trim();
  if (trimmed.isEmpty) {
    return const ServerBaseNormalization._(null, '请输入服务器地址');
  }
  final Uri? uri = Uri.tryParse(trimmed);
  if (uri == null || !uri.hasScheme) {
    return const ServerBaseNormalization._(
        null, '地址格式无效（示例：https://fb.example.com 或 http://127.0.0.1:8787）');
  }
  final String scheme = uri.scheme.toLowerCase();
  if (scheme != 'http' && scheme != 'https') {
    return const ServerBaseNormalization._(
        null, '仅支持 http(s) 地址（示例：https://fb.example.com）');
  }
  if (uri.host.isEmpty) {
    return const ServerBaseNormalization._(null, '地址缺少主机名');
  }
  if (uri.userInfo.isNotEmpty) {
    return const ServerBaseNormalization._(null, '地址不能包含用户名或密码');
  }
  if (uri.hasQuery) {
    return const ServerBaseNormalization._(null, '地址不能包含查询参数');
  }
  if (uri.hasFragment) {
    return const ServerBaseNormalization._(null, '地址不能包含 # 片段');
  }
  if (pageIsHttps && scheme == 'http') {
    return const ServerBaseNormalization._(
        null, 'HTTPS 页面无法使用 HTTP 服务地址（浏览器会拦截混合内容）');
  }
  // Uri.hasPort 表示源串显式写了端口；显式默认端口（http:80 / https:443）与
  // Web URL 规范化一致地省略，保证两端产生相同的规范化地址。
  final int defaultPort = scheme == 'https' ? 443 : 80;
  if (uri.hasPort && (uri.port <= 0 || uri.port > 65535)) {
    return const ServerBaseNormalization._(null, '端口号无效');
  }
  final bool keepPort = uri.hasPort && uri.port != defaultPort;
  final String path = uri.path.replaceAll(RegExp(r'/+$'), '');
  return ServerBaseNormalization._(
    '$scheme://${uri.host.toLowerCase()}${keepPort ? ':${uri.port}' : ''}$path',
    null,
  );
}

/// 覆盖偏好存储键：
/// `feedback_widget.server_override.<base64url(规范化默认地址 + NUL + appId)>`
/// （与令牌键同一形态：确定性、无碰撞、平台安全字符集）。
///
/// 默认地址规范化失败时按其去空白原值派生——仍保证逐槽位隔离。
String serverOverrideStorageKey({
  required String appId,
  required String defaultApiBase,
}) {
  final ServerBaseNormalization def = normalizeServerBase(defaultApiBase);
  final String base = def.ok ? def.base! : defaultApiBase.trim();
  final String identity = '$base\u0000$appId';
  final String encoded =
      base64Url.encode(utf8.encode(identity)).replaceAll('=', '');
  return 'feedback_widget.server_override.$encoded';
}

/// 服务器覆盖偏好的本机存储抽象。
///
/// - 原生默认实现基于 flutter_secure_storage（与应用私有区隔离）；
/// - Web 默认实现使用 localStorage（按源隔离）；
/// - 测试可注入 [MemoryServerPrefStore] 或故障注入实现。
abstract class FeedbackServerPrefStore {
  /// 读取键值；不存在返回 null。
  Future<String?> read(String key);

  /// 写入键值。
  Future<void> write(String key, String value);

  /// 删除键。
  Future<void> delete(String key);
}

/// 纯内存偏好仓库：测试注入与不支持持久化环境的兜底。
class MemoryServerPrefStore implements FeedbackServerPrefStore {
  final Map<String, String> _data = <String, String>{};

  @override
  Future<String?> read(String key) async => _data[key];

  @override
  Future<void> write(String key, String value) async {
    _data[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    _data.remove(key);
  }
}
