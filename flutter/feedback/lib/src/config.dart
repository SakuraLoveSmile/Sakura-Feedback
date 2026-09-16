import 'dart:ui' show Offset;

import 'api_client.dart' show FeedbackFilePicker, FeedbackLogProvider;

/// 悬浮按钮停靠的侧边。
enum FeedbackSide {
  /// 左侧。
  left,

  /// 右侧。
  right,
}

/// 呼出入口展现模式。
enum FeedbackLauncherMode {
  /// 经典侧边悬浮按钮。
  tab,

  /// 灵感球（支持拖拽指出问题与视口截图）。
  orb,
}

/// 截图捕获模式。
enum FeedbackCaptureMode {
  /// 关闭截图。
  off,

  /// 呼出时捕获当前视口完整截图。
  viewport,
}

/// 反馈组件的主题模式。
enum FeedbackThemeMode {
  /// 跟随宿主/系统模式。
  system,

  /// 浅色模式。
  light,

  /// 深色模式。
  dark,
}

/// `FeedbackWidget` 的连接与展示配置。
///
/// [apiBase] 为 Feedback 服务地址（如 `https://fb.example.com`），
/// [appId] 为服务端登记的软件标识。两者必填。
///
/// [appVersion] 与 [pageLabel] 仅在显式传入时随提交体上报，
/// 组件绝不自动抓取宿主信息。
class FeedbackConfig {
  /// 构造配置。[apiBase] 末尾的 `/` 会被去除。
  FeedbackConfig(
    String apiBase,
    String appId, {
    String? appName,
    this.appVersion,
    this.pageLabel,
    this.side = FeedbackSide.right,
    this.position,
    this.theme = FeedbackThemeMode.system,
    this.showLauncher = true,
    this.launcherBottom = '25%',
    this.launcherMode = FeedbackLauncherMode.tab,
    this.captureMode = FeedbackCaptureMode.off,
    this.logProvider,
    this.filePicker,
  })  : assert(apiBase.trim().isNotEmpty, 'apiBase 不能为空'),
        assert(appId.trim().isNotEmpty, 'appId 不能为空'),
        assert(_isHttpUrl(apiBase), 'apiBase 必须是 http(s) 地址'),
        apiBase = _normalize(apiBase),
        appId = appId.trim(),
        appName = normalizeAppName(appName);

  /// Feedback 服务地址（无末尾斜杠）。
  final String apiBase;

  /// 服务端登记的软件标识。
  final String appId;

  /// 可选的软件显示名称，随提交上报。
  ///
  /// 服务端只在**管理员尚未设置名称**（首次自动发现的软件）时采用；
  /// 管理员在后台设置过名称后，这里上报的值不会覆盖它。
  final String? appName;

  /// 随提交上报的应用版本（仅显式传入时携带）。
  final String? appVersion;

  /// 随提交上报的页面标识（仅显式传入时携带）。
  final String? pageLabel;

  /// 悬浮按钮停靠侧，同时决定宽屏抽屉展开方向。
  final FeedbackSide side;

  /// 悬浮按钮距屏幕停靠侧与底边的间距（显式传入时优先于 [launcherBottom]）。
  final Offset? position;

  /// 主题模式，默认跟随系统。
  final FeedbackThemeMode theme;

  /// 是否显示内置侧边入口，默认显示。
  final bool showLauncher;

  /// 侧边入口距可用区域底部的位置，默认 '25%'，支持百分比或像素值。
  final String launcherBottom;

  /// 呼出入口展现模式，默认经典标签 [FeedbackLauncherMode.tab]。
  final FeedbackLauncherMode launcherMode;

  /// 截图捕获模式，默认关闭 [FeedbackCaptureMode.off]。
  final FeedbackCaptureMode captureMode;

  /// 自动日志采集提供者（可选）。
  final FeedbackLogProvider? logProvider;

  /// 手动日志文件选择器（可选）。
  final FeedbackFilePicker? filePicker;

  static String _normalize(String base) {
    var b = base.trim();
    while (b.endsWith('/')) {
      b = b.substring(0, b.length - 1);
    }
    return b;
  }

  static bool _isHttpUrl(String base) {
    final Uri? uri = Uri.tryParse(base.trim());
    return uri != null &&
        (uri.scheme == 'http' || uri.scheme == 'https') &&
        uri.host.isNotEmpty;
  }
}

/// 归一化可选的软件名称：去空白、空串视为未提供、截断到 100 字符（与服务端上限一致）。
String? normalizeAppName(String? raw) {
  if (raw == null) return null;
  final String t = raw.trim();
  if (t.isEmpty) return null;
  return t.length > 100 ? t.substring(0, 100) : t;
}

