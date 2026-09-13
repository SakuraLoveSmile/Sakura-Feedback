// T1 补修 · macOS 原生端到端验证（真实 macOS 应用进程 + 真实 Feedback 服务）。
//
// 运行：
//   cd examples/flutter
//   /Users/sakurasep/flutter/bin/flutter test integration_test/t1_native_lifecycle_test.dart -d macos
//
// 为什么用集成测试而不是合成鼠标/键盘：macOS 上合成输入受系统输入法状态影响，
// 无法稳定把密码键入密码框（实测同一套 CGEvent 注入对输入区/用户名字段有效、
// 对密码框无效）。集成测试在**真实 macOS 应用进程内**驱动同一套 Flutter 组件
// （真实嵌入器、真实 Timer、真实 HTTP 到真实服务端），只是把令牌仓库换成
// MemoryTokenStore——见下方「令牌仓库」说明。
//
// 令牌仓库说明（诚实标注）：示例默认使用 flutter_secure_storage（Keychain）。
// 本机没有 Apple 开发者签名身份，示例为 ad-hoc 签名（TeamIdentifier 未设置），
// Keychain 写入必然返回 errSecMissingEntitlement (-34018)（已用探针实测）。
// 因此本测试注入 MemoryTokenStore 以便验证**流程**；原生 Keychain 持久化
// 在本环境未验证（见 VERIFICATION.md 的 BLOCKED 条目）。
// ⚠️ 命名澄清：本测试是「内存令牌仓库流程验证」，**不作为默认安全存储的
// 验收入口**；默认存储的写入 / 重启恢复验收见 t1c_secure_storage_write_test.dart
// 与 t1c_secure_storage_recovery_test.dart（带探针；签名环境就绪后由统一入口 `e2e/run_t1c_default_storage.py` 执行默认存储验收）。
import 'dart:convert';
import 'dart:io';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

const String kService = 'http://localhost:8787';
const String kAppId = 'com.example.demo';
// 管理员凭据经 `--dart-define` 注入（本地 .env），源码不写入凭据字面量。
const String kAdminUser = String.fromEnvironment('FEEDBACK_ADMIN_USER');
const String kAdminPass = String.fromEnvironment('FEEDBACK_ADMIN_PASSWORD');
const String kUserPass = 'mac-native-pw-1';

/// 极简带 Cookie 的 HTTP 客户端（管理员接口需要会话 Cookie）。
class AdminApi {
  AdminApi(this._client);

  final HttpClient _client;
  String? _cookie;

  Future<(int, Map<String, Object?>)> call(
    String method,
    String path, [
    Object? body,
  ]) async {
    final HttpClientRequest req = await _client.openUrl(
      method,
      Uri.parse('$kService$path'),
    );
    req.headers.contentType = ContentType.json;
    if (_cookie != null) req.headers.set('cookie', _cookie!);
    if (body != null) req.write(jsonEncode(body));
    final HttpClientResponse res = await req.close();
    final List<String> setCookies = res.headers['set-cookie'] ?? <String>[];
    if (setCookies.isNotEmpty) {
      _cookie = setCookies.map((String c) => c.split(';').first).join('; ');
    }
    final String text = await res.transform(utf8.decoder).join();
    final Object? decoded = text.isEmpty ? null : jsonDecode(text);
    return (
      res.statusCode,
      decoded is Map ? decoded.cast<String, Object?>() : <String, Object?>{},
    );
  }
}

/// 宿主：与 examples/flutter 的 main.dart 同构（同一个组件、同一份配置），
/// 仅把令牌仓库换成内存实现以便在本机（无签名身份）跑通流程。
Widget buildHost(FeedbackController controller, FeedbackTokenStore store) {
  return MaterialApp(
    home: FeedbackWidget(
      config: FeedbackConfig(
        kService,
        kAppId,
        appVersion: '1.0.0',
        pageLabel: 'home',
        side: FeedbackSide.right,
        launcherMode: FeedbackLauncherMode.orb,
        captureMode: FeedbackCaptureMode.off,
      ),
      controller: controller,
      tokenStore: store,
      child: const Scaffold(body: Center(child: Text('宿主内容'))),
    ),
  );
}

String? quotaText(WidgetTester tester) {
  final Finder f = find.byKey(const Key('feedback-quota'));
  if (f.evaluate().isEmpty) return null;
  return tester.widget<Text>(f).data;
}

/// 轮询等待（真实时间；集成测试下 pump 推进真实时钟）。
Future<void> waitFor(
  WidgetTester tester,
  bool Function() cond, {
  Duration timeout = const Duration(seconds: 60),
  String what = '条件',
}) async {
  final DateTime end = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(end)) {
    if (cond()) return;
    await tester.pump(const Duration(milliseconds: 200));
  }
  final List<String> texts = tester
      .widgetList<Text>(find.byType(Text))
      .map((Text w) => w.data ?? '')
      .where((String t) => t.isNotEmpty)
      .toList();
  fail('等待超时：$what ｜ 当前可见文本：$texts');
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  late AdminApi api;
  late String user;
  late String userId;

  setUpAll(() async {
    api = AdminApi(HttpClient());
    final (int s, Map<String, Object?> _) = await api.call(
      'POST',
      '/api/auth/login',
      <String, Object?>{'username': kAdminUser, 'password': kAdminPass},
    );
    expect(s, 200, reason: '管理员登录（服务必须已启动并配置）');
    user = 'mac-${DateTime.now().millisecondsSinceEpoch}';
    final (int cs, Map<String, Object?> created) = await api.call(
      'POST',
      '/api/admin/users',
      <String, Object?>{'username': user, 'password': kUserPass, 'dailyLimit': 1},
    );
    expect(cs, 201, reason: '创建测试账号');
    userId = created['id']! as String;
  });

  Future<int> remaining() async {
    final (int s, Map<String, Object?> d) = await api.call('GET', '/api/admin/users');
    expect(s, 200);
    final Map<String, Object?> u = (d['users']! as List<Object?>)
        .cast<Map<String, Object?>>()
        .firstWhere((Map<String, Object?> x) => x['id'] == userId);
    return u['remaining']! as int;
  }

  Future<void> setLimit(int limit) async {
    final (int s, Map<String, Object?> _) = await api.call(
      'PATCH',
      '/api/admin/users/$userId',
      <String, Object?>{'dailyLimit': limit},
    );
    expect(s, 200);
  }

  testWidgets('T1 macOS 原生（内存令牌仓库流程验证，非默认存储验收）：面板内登录 → 提交 → 额度用尽 → 调额恢复 → 重开刷新额度',
      (WidgetTester tester) async {
    await setLimit(1);
    final FeedbackController controller = FeedbackController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(buildHost(controller, MemoryTokenStore()));
    await tester.pump(const Duration(seconds: 1));

    // ---- 1) 灵感球打开面板（真实 macOS 应用内的真实点击） ----
    await tester.tap(find.byKey(const Key('feedback-orb')));
    await tester.pump(const Duration(milliseconds: 800));
    expect(controller.isOpen, isTrue, reason: '面板已打开');
    expect(find.byKey(const Key('feedback-input')), findsOneWidget,
        reason: '未登录也可继续编辑');
    expect(find.byKey(const Key('feedback-login-username')), findsNothing,
        reason: '登录表单按需展开，不自动出现');

    // ---- 2) 草稿 → 主按钮 → 面板内登录表单 ----
    await tester.enterText(find.byKey(const Key('feedback-input')), 'macOS 原生 T1 验证');
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.byKey(const Key('feedback-submit')));
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.byKey(const Key('feedback-login-username')), findsOneWidget,
        reason: '未登录点提交：在当前面板展开登录表单（不打开窗口）');

    // ---- 3) 原位登录 + 自动提交一次 ----
    await tester.enterText(find.byKey(const Key('feedback-login-username')), user);
    await tester.enterText(find.byKey(const Key('feedback-login-password')), kUserPass);
    await tester.pump(const Duration(milliseconds: 200));
    await tester.tap(find.byKey(const Key('feedback-login-submit')));
    await waitFor(
      tester,
      () => find.byKey(const Key('feedback-login-form')).evaluate().isEmpty,
      timeout: const Duration(seconds: 30),
      what: '登录成功（面板内登录表单收起）',
    );
    await waitFor(
      tester,
      () => find.byKey(const Key('feedback-continue')).evaluate().isNotEmpty,
      what: '登录后自动提交并归档',
    );
    expect(await remaining(), 0, reason: '额度上限 1，提交一次后服务端剩余 0');

    // ---- 4) 额度用尽：新提交被禁用（草稿保留） ----
    await tester.tap(find.byKey(const Key('feedback-continue')));
    await tester.pump(const Duration(milliseconds: 600));
    await tester.enterText(find.byKey(const Key('feedback-input')), '额度用尽时应被拦下');
    await tester.pump(const Duration(milliseconds: 300));
    expect(quotaText(tester), contains('今日剩余 0 次'), reason: '额度展示为 0');
    expect(
      tester.widget<FilledButton>(find.byKey(const Key('feedback-submit'))).onPressed,
      isNull,
      reason: '额度用尽：新提交按钮禁用',
    );

    // ---- 5) 后台调高额度 → 面板不重开，等 30 秒轮询后恢复提交 ----
    await setLimit(3);
    await waitFor(
      tester,
      () =>
          tester.widget<FilledButton>(find.byKey(const Key('feedback-submit'))).onPressed !=
          null,
      timeout: const Duration(seconds: 60),
      what: '额度轮询（≤30s）后新提交恢复可用',
    );
    expect(quotaText(tester), contains('今日剩余 2 次'),
        reason: '调额后剩余 2（上限 3 − 已用 1），面板未重开即刷新');
    await tester.tap(find.byKey(const Key('feedback-submit')));
    await waitFor(
      tester,
      () => find.byKey(const Key('feedback-continue')).evaluate().isNotEmpty,
      what: '调额后第二次提交成功归档',
    );
    expect(await remaining(), 1, reason: '第二次提交后剩余 1');

    // ---- 6) 关闭 → 改额 → 重新打开：立即重新查询额度 ----
    // 先回到撰写视图（额度行只在撰写视图渲染），再关闭 / 重开。
    await tester.tap(find.byKey(const Key('feedback-continue')));
    await tester.pump(const Duration(milliseconds: 500));
    await setLimit(7);
    await tester.tap(find.byKey(const Key('feedback-close')));
    await tester.pump(const Duration(milliseconds: 800));
    expect(controller.isOpen, isFalse, reason: '面板已关闭');
    await tester.tap(find.byKey(const Key('feedback-orb')));
    await tester.pump(const Duration(milliseconds: 500));
    await waitFor(
      tester,
      () => (quotaText(tester) ?? '').contains('今日剩余 5 次'),
      timeout: const Duration(seconds: 30),
      what: '重新打开后额度刷新为 7 − 已用 2 = 5',
    );
  });
}
