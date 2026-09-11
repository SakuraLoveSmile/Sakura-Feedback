import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' show Offset;

/// 单份日志附件的数据模型。
class FeedbackLogPart {
  const FeedbackLogPart({
    required this.name,
    required this.bytes,
  });

  /// 原始文件名（如 app.log）。
  final String name;

  /// 日志原始内容字节。
  final Uint8List bytes;
}

/// 日志提供器回调类型：返回 0 到多份日志文件。
typedef FeedbackLogProvider = FutureOr<List<FeedbackLogPart>> Function();

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
  })  : assert(apiBase.trim().isNotEmpty, 'apiBase 不能为空'),
        assert(appId.trim().isNotEmpty, 'appId 不能为空'),
        assert(_isHttpUrl(apiBase), 'apiBase 必须是 http(s) 地址'),
        apiBase = _normalize(apiBase),
        appId = appId.trim();

  /// Feedback 服务地址（无末尾斜杠）。
  final String apiBase;

  /// 服务端登记的软件标识。
  final String appId;

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

  /// 日志提供器回调。返回文件名与日志字节（Uint8List）。
  /// 未配置时仅展示手动添加附件入口。
  final FeedbackLogProvider? logProvider;

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

