import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'details_page.dart';
import 'home_page.dart';

void main() => runApp(const FeedbackExampleApp());

/// 应用根：持有 [FeedbackController]，并把 [FeedbackWidget] 挂在
/// **MaterialApp 外侧**（v12 推荐挂载）。
///
/// 三个关键结构（也是本示例要演示的重点）：
/// 1. 控制器由**应用根**拥有，只在根的 `dispose()` 里释放——任何路由都能用同一个实例；
/// 2. 组件**包在 MaterialApp 外侧**：截图边界提升到根 Navigator/Overlay 之上，
///    `useRootNavigator: true` 的根弹窗（`showDialog` / `showModalBottomSheet`
///    默认）也进入截图；面板与灵感球仍在截图边界之外。
///    （旧的 `MaterialApp.builder` 包裹方式仍可运行，但根弹窗不入图——
///    截图只覆盖应用自己的 Navigator 子树。）
/// 3. 配置显式声明 `launcherMode: orb` 与 `captureMode: viewport`
///    （组件默认是 `tab` / `off`，升级不会改变旧宿主行为）。
class FeedbackExampleApp extends StatefulWidget {
  const FeedbackExampleApp({super.key});

  @override
  State<FeedbackExampleApp> createState() => _FeedbackExampleAppState();
}

class _FeedbackExampleAppState extends State<FeedbackExampleApp> {
  /// 主动呼出接口：由应用根拥有，在 [dispose] 中释放。
  final FeedbackController _feedback = FeedbackController();

  /// pageLabel 必须由宿主显式传入（组件绝不自动抓取页面信息）。
  /// 这里跟随命名路由变化，演示宿主把"当前页面"交给组件的常见做法。
  final ValueNotifier<String> _pageLabel =
      ValueNotifier<String>(HomePage.routeName);

  /// v12 诊断日志：内存记录器 + http.Client 包装（T4 三步接入示例）。
  ///
  /// ① 创建 [FeedbackDiagnosticsRecorder]；
  /// ② 用 [FeedbackHttpClient] 包装宿主自己的 http.Client（只记白名单字段：
  ///    事件/错误码/状态码/耗时/pageLabel，绝不记录正文、凭据或完整 URL）；
  /// ③ 把 `recorder.provide` 交给 [FeedbackConfig.logProvider]，随反馈提交；
  ///    可选 [FeedbackExceptionCapture.install] 捕获未处理异常（保留宿主处理）。
  final FeedbackDiagnosticsRecorder _diagnostics =
      FeedbackDiagnosticsRecorder();

  /// 示例用包装过的 http.Client（宿主自身请求走它，诊断自动入缓冲）。
  /// 注意：组件自己的请求不经过它——两者独立，互不干扰。
  late final FeedbackHttpClient _http =
      FeedbackHttpClient(http.Client(), _diagnostics, pageLabel: 'example');

  late final NavigatorObserver _routeObserver =
      _RouteLabelObserver(_syncPageLabel);

  void _syncPageLabel(Route<dynamic>? route) {
    final String? name = route?.settings.name;
    // 对话框等匿名路由（name == null）不改变 pageLabel。
    if (name == null || name == _pageLabel.value) return;
    _pageLabel.value = name;
  }

  @override
  void dispose() {
    // 根 State 负责释放根持有的资源。
    _pageLabel.dispose();
    _feedback.dispose();
    _http.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // v12 挂载：组件包在 MaterialApp 外侧——截图边界包含根 Navigator 弹窗。
    // 组件构造签名不变；面板所需的环境（主题/媒体查询/导航兜底）由组件自备。
    return FeedbackWidget(
      config: FeedbackConfig(
        // 改为你自己的 Feedback 服务地址与服务端登记的 appId。
        'http://localhost:8787',
        'com.example.demo',
        appVersion: '1.0.0',
        pageLabel: _pageLabel.value,
        side: FeedbackSide.right,
        // 显式声明：灵感球（可拖拽落点）+ 呼出时截取当前应用视口。
        launcherMode: FeedbackLauncherMode.orb,
        captureMode: FeedbackCaptureMode.viewport,
        // v12 诊断日志三步接入之③：把记录器产出接给 logProvider。
        logProvider: () => _diagnostics.provide(),
      ),
      controller: _feedback,
      // pageLabel 需要跟随路由变化：用 ValueListenableBuilder 局部重建配置。
      child: ValueListenableBuilder<String>(
        valueListenable: _pageLabel,
        builder: (BuildContext context, String pageLabel, Widget? _) {
          return MaterialApp(
            title: 'feedback_widget 示例',
            theme: ThemeData(
              colorSchemeSeed: Colors.indigo,
              useMaterial3: true,
            ),
            navigatorObservers: <NavigatorObserver>[_routeObserver],
            initialRoute: HomePage.routeName,
            routes: <String, WidgetBuilder>{
              HomePage.routeName: (BuildContext context) =>
                  HomePage(controller: _feedback),
              DetailsPage.routeName: (BuildContext context) =>
                  const DetailsPage(),
            },
          );
        },
      ),
    );
  }
}

/// 把当前命名路由同步给 [ValueNotifier]：宿主显式告知组件"现在在哪一页"。
class _RouteLabelObserver extends NavigatorObserver {
  _RouteLabelObserver(this.onRouteChanged);

  final void Function(Route<dynamic>? route) onRouteChanged;

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    onRouteChanged(route);
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    onRouteChanged(previousRoute);
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    onRouteChanged(newRoute);
  }
}
