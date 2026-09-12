import 'dart:typed_data' show Uint8List;
import 'dart:ui' show Offset;

/// 宿主交给反馈组件的一份日志文件：文件名 + 原始字节。
///
/// 组件按契约要求校验（扩展名白名单 / ≤ 1 MiB / 严格 UTF-8），校验与提交都
/// 只使用 [bytes]，绝不解码后重新编码，保证提交字节与宿主导出一致。
///
/// 宿主负责在把日志交给组件**之前**去除凭据等敏感内容（契约 §0）。
class FeedbackLogFile {
  /// 构造一份日志文件。
  const FeedbackLogFile({required this.name, required this.bytes});

  /// 文件名（含扩展名；仅接受 `.log` / `.txt` / `.json` / `.jsonl`）。
  final String name;

  /// 文件原始字节。
  final Uint8List bytes;
}

/// 日志提供者回调：返回宿主当前的日志文件列表。
///
/// 每份**新草稿首次打开**面板时调用一次（3 秒超时，超时/失败不阻塞提交）。
typedef FeedbackLogProvider = Future<List<FeedbackLogFile>> Function();

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

  /// 宿主日志提供者；省略时面板只显示「手动添加日志」入口。
  ///
  /// 新草稿首次打开面板时调用一次（3 秒超时）；重新打开已有草稿不重新采集，
  /// 用户移除后也不自动补回。采集失败/超时不影响截图与描述的提交。
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

