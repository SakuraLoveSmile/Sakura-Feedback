import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// 独立本地体验入口；真实 Feedback 组件连接任务专用测试服务。
/// flutter run -t lib/orb_preview.dart --dart-define=FEEDBACK_API_BASE=...
void main() => runApp(const OrbPreviewApp());

class OrbPreviewApp extends StatefulWidget {
  const OrbPreviewApp({super.key});

  @override
  State<OrbPreviewApp> createState() => _OrbPreviewAppState();
}

class _OrbPreviewAppState extends State<OrbPreviewApp> {
  final FeedbackController _controller = FeedbackController();
  bool _preparingDemo = true;
  bool _dark = false;
  String _demoStatus = '正在准备示例反馈…';

  @override
  void initState() {
    super.initState();
    _prepareDemo();
  }

  // 仅这个独立体验入口自动登录本机演示账号；正式组件没有 mock 分支。
  Future<void> _prepareDemo() async {
    final FeedbackConfig config = orbPreviewConfig;
    final Uri endpoint = Uri.parse(config.apiBase);
    if (endpoint.scheme != 'http' ||
        endpoint.host != '127.0.0.1' ||
        endpoint.port != 53947) {
      setState(() {
        _preparingDemo = false;
        _demoStatus = '当前为自定义服务，请在反馈面板中登录。';
      });
      return;
    }
    final ApiClient client = ApiClient(
      config: config,
      tokenStore: MemoryTokenStore(),
    );
    try {
      final LoginResult session = await client
          .login(
            username: 'orb-demo',
            password: 'orb-demo-local-20261102',
            clientLabel: '灵感球体验 · 示例账号',
            appId: config.appId,
          )
          .timeout(const Duration(seconds: 5));
      if (!mounted) return;
      await const FlutterSecureStorage().write(
        key: feedbackTokenStorageKey(config),
        value: session.token,
      );
      if (!mounted) return;
      setState(() => _demoStatus = '示例账号已就绪 · 打开面板后选择“我的反馈”查看。');
    } catch (_) {
      if (mounted) {
        setState(() => _demoStatus = '示例服务暂时不可用。球体与截图仍可体验，连接电脑后重新打开 App。');
      }
    } finally {
      client.dispose();
      if (mounted) setState(() => _preparingDemo = false);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_preparingDemo) {
      return const MaterialApp(
        home: Scaffold(body: Center(child: CircularProgressIndicator())),
      );
    }
    return FeedbackWidget(
      controller: _controller,
      config: orbPreviewConfigForTheme(_dark),
      child: OrbPreviewPage(
        dark: _dark,
        demoStatus: _demoStatus,
        onOpenFeedback: _controller.open,
        onToggleTheme: () => setState(() => _dark = !_dark),
      ),
    );
  }
}

FeedbackConfig get orbPreviewConfig => orbPreviewConfigForTheme(false);

FeedbackConfig orbPreviewConfigForTheme(bool dark) => FeedbackConfig(
  const String.fromEnvironment(
    'FEEDBACK_API_BASE',
    defaultValue: 'http://127.0.0.1:53947',
  ),
  'com.example.orb-liquid',
  appName: '液态灵感球本地体验',
  appVersion: '0.6.0',
  pageLabel: '灵感球',
  theme: dark ? FeedbackThemeMode.dark : FeedbackThemeMode.light,
  launcherMode: FeedbackLauncherMode.orb,
  captureMode: FeedbackCaptureMode.viewport,
  launcherBottom: '42%',
);

class OrbPreviewPage extends StatelessWidget {
  const OrbPreviewPage({
    super.key,
    this.dark = false,
    this.demoStatus,
    this.onOpenFeedback,
    this.onToggleTheme,
  });
  final bool dark;
  final String? demoStatus;
  final VoidCallback? onOpenFeedback;
  final VoidCallback? onToggleTheme;

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: '灵感球 · 反馈流程',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      colorScheme: ColorScheme.fromSeed(
        seedColor: const Color(0xff0071e3),
        brightness: dark ? Brightness.dark : Brightness.light,
      ),
      scaffoldBackgroundColor: dark
          ? const Color(0xff191b24)
          : const Color(0xfff3f4fa),
      useMaterial3: true,
    ),
    home: Scaffold(
      appBar: AppBar(
        title: const Text('把灵感留在此刻'),
        actions: <Widget>[
          if (onToggleTheme != null)
            IconButton(
              tooltip: dark ? '切换浅色' : '切换深色',
              onPressed: onToggleTheme,
              icon: Icon(
                dark ? Icons.light_mode_outlined : Icons.dark_mode_outlined,
              ),
            ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(24, 28, 24, 96),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            const Text(
              '每一个体验，\n都值得被看见。',
              style: TextStyle(fontSize: 32, height: 1.3),
            ),
            const SizedBox(height: 12),
            const Text('拖动灵感球到想记录的位置，松手调整截图，继续填写反馈。'),
            const SizedBox(height: 12),
            const Text(
              '也可以打开反馈面板右上角的设置，选择双指长按、三指上滑或双指双击。手势先唤醒球，拖动球后再截图。闲置后可选择贴边或小把手。',
            ),
            if (onOpenFeedback != null) ...<Widget>[
              const SizedBox(height: 20),
              FilledButton.tonalIcon(
                onPressed: onOpenFeedback,
                icon: const Icon(Icons.forum_outlined),
                label: const Text('打开反馈面板 · 查看示例'),
              ),
              const SizedBox(height: 8),
              Text(
                demoStatus ?? '在“我的反馈”中查看示例记录。',
                style: const TextStyle(fontSize: 12, height: 1.5),
              ),
            ],
            const SizedBox(height: 28),
            Card(
              elevation: 0,
              color: dark ? const Color(0xff242631) : const Color(0xfffcfcff),
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    const Text('让细节更清晰', style: TextStyle(fontSize: 17)),
                    const SizedBox(height: 16),
                    const Text(
                      'Aa Bb 0123456789\n灵感，从这里开始',
                      style: TextStyle(fontSize: 23, height: 1.6),
                    ),
                    const SizedBox(height: 16),
                    Row(
                      children: <Widget>[
                        for (final Color color in <Color>[
                          const Color(0xff0071e3),
                          const Color(0xff5e36d7),
                          const Color(0xfff2b94b),
                          const Color(0xff38ad87),
                        ])
                          Expanded(child: Container(height: 12, color: color)),
                      ],
                    ),
                    const SizedBox(height: 16),
                    const Text('移动、转弯、停下，再选中想留下的片段。'),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 24),
            FeedbackCaptureMask(
              child: ColoredBox(
                color: dark ? const Color(0xff423950) : const Color(0xffe7dcfb),
                child: const Padding(
                  padding: EdgeInsets.all(16),
                  child: Text('遮挡测试内容：PRIVATE-ORB-TEST'),
                ),
              ),
            ),
            const SizedBox(height: 24),
            const Text(
              '本地体验页使用实际 Feedback 组件。提交仅进入本任务的隔离测试环境。',
              style: TextStyle(fontSize: 12, color: Colors.grey),
            ),
          ],
        ),
      ),
    ),
  );
}
