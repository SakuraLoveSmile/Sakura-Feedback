import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';

import 'details_page.dart';
import 'home_page.dart';
import 'host_logs.dart';

const String feedbackApiBase = String.fromEnvironment(
  'FEEDBACK_API_BASE',
  defaultValue: 'http://localhost:8787',
);
const String feedbackAppId = String.fromEnvironment(
  'FEEDBACK_APP_ID',
  defaultValue: 'com.example.demo',
);

void main() {
  // 宿主日志：真实应用在这里初始化自己的日志系统（本示例用内存环形缓冲）。
  hostLogs.info('示例应用启动');
  runApp(const FeedbackExampleApp());
}

/// 应用根：持有 [FeedbackController]，并把 [FeedbackWidget] 挂在 Navigator 之上。
///
/// 三个关键结构（也是本示例要演示的重点）：
/// 1. 控制器由**应用根**拥有，只在根的 `dispose()` 里释放——任何路由都能用同一个实例；
/// 2. 组件通过 `MaterialApp.builder` 包裹 **Navigator 子树**，而不是某个页面的
///    child：push/pop 路由不会重建组件，灵感球在任何路由下都在场，
///    草稿与登录令牌也不会因为导航而丢失；
/// 3. 配置显式声明 `launcherMode: orb` 与 `captureMode: viewport`
///    （组件默认是 `tab` / `off`，升级不改变旧宿主行为）。
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

  late final NavigatorObserver _routeObserver =
      _RouteLabelObserver(_syncPageLabel);

  void _syncPageLabel(Route<dynamic>? route) {
    final String? name = route?.settings.name;
    // 对话框等匿名路由（name == null）不改变 pageLabel。
    if (name == null || name == _pageLabel.value) return;
    _pageLabel.value = name;
    // 顺手写一条宿主日志：下次打开反馈面板时会被自动采集进 host-app.log。
    hostLogs.info('路由切换 → $name');
  }

  @override
  void dispose() {
    // 根 State 负责释放根持有的资源。
    _pageLabel.dispose();
    _feedback.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
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
        DetailsPage.routeName: (BuildContext context) => const DetailsPage(),
      },
      // builder 收到的 child 就是应用自己的 Navigator 子树。把组件包在它外面，
      // 灵感球与面板就与当前路由无关了。
      builder: (BuildContext context, Widget? child) {
        return ValueListenableBuilder<String>(
          valueListenable: _pageLabel,
          builder: (BuildContext context, String pageLabel, Widget? _) {
            // 为什么这里还要一个"宿主外层 Navigator"？
            // 面板里的 TextField 需要 Overlay 祖先才能建立选择浮层，截图放大
            // 预览用的 showDialog() 也需要 Navigator/Overlay 祖先（见
            // flutter/feedback 的 FeedbackPanel）。而应用自己的 Navigator 在
            // 组件**之下**（child），祖先查找只向上走，所以补一个只承载组件、
            // 不做任何页面跳转的外层 Navigator：它同时提供 Overlay 与
            // Navigator 祖先，且因为它位于应用 Navigator 之上，push/pop 路由
            // 依旧不会重建组件。
            return Navigator(
              onGenerateRoute: (RouteSettings settings) => PageRouteBuilder<void>(
                settings: settings,
                // 外层路由只承载组件，不需要转场动画。
                transitionDuration: Duration.zero,
                reverseTransitionDuration: Duration.zero,
                pageBuilder: (BuildContext context, Animation<double> animation,
                        Animation<double> secondaryAnimation) =>
                    _buildFeedbackLayer(child, pageLabel),
              ),
            );
          },
        );
      },
    );
  }

  /// 组件本体：包裹应用 Navigator 子树（[child]）。
  Widget _buildFeedbackLayer(Widget? child, String pageLabel) {
    return FeedbackWidget(
      config: FeedbackConfig(
        // 可通过 --dart-define=FEEDBACK_API_BASE/FEEDBACK_APP_ID 覆盖。
        feedbackApiBase,
        feedbackAppId,
        appVersion: '1.0.0',
        pageLabel: pageLabel,
        side: FeedbackSide.right,
        // 显式声明：灵感球（可拖拽落点）+ 呼出时截取当前应用视口。
        launcherMode: FeedbackLauncherMode.orb,
        captureMode: FeedbackCaptureMode.viewport,
        // 宿主日志：新草稿首次打开面板时自动采集一次（3 秒超时），
        // 失败/超时只提示、不阻塞截图与描述提交。
        // 宿主的导出方法自己负责脱敏（见 host_logs.dart）。
        logProvider: hostLogs.export,
      ),
      controller: _feedback,
      child: child ?? const SizedBox.shrink(),
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
