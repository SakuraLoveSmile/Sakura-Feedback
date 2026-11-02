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

/// 把主机名中的国际化域名（IDN，如中文域名）标签转成 ASCII/punycode。
///
/// Dart 的 [Uri] 不会像浏览器 `URL` 那样把 Unicode 主机名转成 punycode，
/// 而是百分号编码（例如 `反馈.中国` → `%E5%8F%8D...%E4%B8%AD%E5%9B%BD`），
/// 直接用于 `http` 请求会得到无法解析的主机名。这里按 IDNA（UTS46）的常用
/// 子集处理：全角 ASCII（`ａ`、`．`、`－` 等）映射为 ASCII，`。`（U+3002）、
/// `｡`（U+FF61）视为 `.`；ASCII 标签统一小写；含非 ASCII 字符的标签按
/// RFC 3492 编码为 `xn--...`。
///
/// 空白 / 控制字符与 URL 主机禁用字符会导致返回 null（调用方按地址无效处理）。
String? idnHostToAscii(String host) {
  final StringBuffer mapped = StringBuffer();
  for (final int rune in host.runes) {
    if (rune >= 0xFF01 && rune <= 0xFF5E) {
      // UTS46：全角 ASCII 变体映射为 ASCII（含全角句点 ． 与连字符 －）。
      mapped.writeCharCode(rune - 0xFEE0);
    } else if (rune == 0x3002 || rune == 0xFF61) {
      // 。 / ｡ → .
      mapped.writeCharCode(0x2E);
    } else {
      mapped.writeCharCode(rune);
    }
  }
  final List<String> labels = mapped.toString().split('.');
  final StringBuffer out = StringBuffer();
  for (int i = 0; i < labels.length; i++) {
    if (i > 0) out.write('.');
    final String label = labels[i];
    if (label.isEmpty) continue; // 保留根点与空标签，与浏览器 URL 行为一致
    final String? ascii = _idnLabelToAscii(label);
    if (ascii == null) return null;
    out.write(ascii);
  }
  return out.toString();
}

/// URL 主机名中不允许出现的 ASCII 字符（空白 / 控制字符另判）。
const Set<int> _invalidHostChars = <int>{
  0x22, // "
  0x23, // #
  0x25, // %
  0x2F, // /
  0x3A, // :
  0x3C, // <
  0x3E, // >
  0x3F, // ?
  0x40, // @
  0x5B, // [
  0x5C, // \
  0x5D, // ]
  0x5E, // ^
  0x60, // `
  0x7B, // {
  0x7C, // |
  0x7D, // }
};

/// 单个主机标签 → ASCII：ASCII 标签只小写；非 ASCII 标签做 punycode。
String? _idnLabelToAscii(String label) {
  for (final int rune in label.runes) {
    if (rune <= 0x20 || rune == 0x7F || _invalidHostChars.contains(rune)) {
      return null;
    }
  }
  final String lower = label.toLowerCase();
  if (lower.codeUnits.every((int c) => c <= 0x7F)) return lower;
  final String encoded = 'xn--${_punycodeEncode(lower)}';
  // RFC 1035 标签上限（punycode 后的 ASCII 长度）。
  return encoded.length <= 63 ? encoded : null;
}

/// RFC 3492 punycode 编码（输入为非纯 ASCII 的单个标签）。
String _punycodeEncode(String label) {
  const int base = 36;
  const int tMin = 1;
  const int tMax = 26;
  final List<int> codePoints = label.runes.toList();
  final StringBuffer output = StringBuffer();
  int basicCount = 0;
  for (final int cp in codePoints) {
    if (cp < 0x80) {
      output.writeCharCode(cp);
      basicCount++;
    }
  }
  int handled = basicCount;
  if (basicCount > 0) output.writeCharCode(0x2D); // '-'
  int n = 0x80;
  int delta = 0;
  int bias = 72;
  while (handled < codePoints.length) {
    int next = 0x7FFFFFFF;
    for (final int cp in codePoints) {
      if (cp >= n && cp < next) next = cp;
    }
    delta += (next - n) * (handled + 1);
    n = next;
    for (final int cp in codePoints) {
      if (cp < n) {
        delta++;
      } else if (cp == n) {
        int q = delta;
        for (int k = base;; k += base) {
          final int t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
          if (q < t) break;
          output.writeCharCode(_punyDigit(t + (q - t) % (base - t)));
          q = (q - t) ~/ (base - t);
        }
        output.writeCharCode(_punyDigit(q));
        bias = _punyAdapt(delta, handled + 1, handled == basicCount);
        delta = 0;
        handled++;
      }
    }
    delta++;
    n++;
  }
  return output.toString();
}

int _punyAdapt(int delta, int numPoints, bool firstTime) {
  delta = firstTime ? delta ~/ 700 : delta ~/ 2;
  delta += delta ~/ numPoints;
  int k = 0;
  while (delta > 455) {
    delta ~/= 35;
    k += 36;
  }
  // skew = 38；k + (base - tMin + 1) * delta / (delta + skew)
  return k + (36 * delta) ~/ (delta + 38);
}

int _punyDigit(int d) => d < 26 ? 0x61 + d : 0x30 + d - 26;

/// 把 [Uri.host] 转成实际可用于请求的 ASCII 主机名。
///
/// - 纯 ASCII：沿用原有「主机小写」规则，不改写其它形态；
/// - 含中文等非 ASCII 字符：先还原 [Uri] 的百分号编码，再按 IDNA 转成
///   punycode（与浏览器 `URL` 的输出一致）；
/// - 非法主机名返回 null，由调用方按地址无效处理。
String? asciiHostOfUriHost(String rawHost) {
  if (rawHost.isEmpty) return rawHost;
  String decoded = rawHost;
  if (rawHost.contains('%')) {
    try {
      decoded = Uri.decodeComponent(rawHost);
    } catch (_) {
      return null;
    }
  }
  if (!decoded.runes.any((int r) => r > 0x7F)) return rawHost.toLowerCase();
  return idnHostToAscii(decoded);
}

/// 规范化用户输入的服务器地址。
///
/// 规则：去空白 → 必须 http(s) → 主机非空（中文等 IDN 主机转为 punycode）
/// → 拒绝内嵌凭据 / 查询参数 / # 片段；输出为「协议小写 + host 小写 +
/// 非默认端口 + 路径前缀（只去末尾斜杠，支持部署路径前缀）」。
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
  // 中文等国际化域名必须转成 ASCII/punycode 才能用于请求与比较；非法主机名
  // 按地址格式无效处理（与 Web 端 URL 解析失败时的提示一致）。
  final String? asciiHost = asciiHostOfUriHost(uri.host);
  if (asciiHost == null) {
    return const ServerBaseNormalization._(
        null, '地址格式无效（示例：https://fb.example.com 或 http://127.0.0.1:8787）');
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
    '$scheme://$asciiHost${keepPort ? ':${uri.port}' : ''}$path',
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
