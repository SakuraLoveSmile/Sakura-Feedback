// T1-C · 兜底清理入口：阶段崩溃、无法自行清理时由执行器调起。
//
// 只清理**本轮身份**的存储槽位（令牌键 + 探针键），不触碰任何既有用户凭据，
// 也不回显令牌值。结果为结构化 JSON（verdict 大写，phase 为 "cleanup"），
// 执行器按 `evaluate_cleanup` 判定：tokenCleared / probeCleared 必须为 true
// 且不得有 cleanupError，否则按残留未清理处理并报告残留键身份。
//
// 由 `e2e/run_t1c_default_storage.py` 调起，参数经 --dart-define 注入。
import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/platform_io.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 't1c_secure_storage_common.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('T1-C 兜底清理：删除本轮令牌与探针键（受本轮身份约束）',
      (WidgetTester tester) async {
    final Map<String, String>? identity =
        loadRunIdentity(needHandshakeFile: false);
    if (identity == null) {
      fail('执行前置错误：缺少 --dart-define 本轮参数'
          '（T1C_RUN_ID/T1C_APP_ID/T1C_TEST_USERNAME/T1C_SERVICE_URL/'
          'T1C_RESULT_FILE）——请使用统一执行入口');
    }
    final String runId = identity['runId']!;
    final String appId = identity['appId']!;
    final String username = identity['username']!;
    final String serviceUrl = identity['serviceUrl']!;

    bool tokenCleared = false;
    bool probeCleared = false;
    String? cleanupError;

    // 令牌键（本轮 appId + 本轮服务地址派生的独立槽位）
    try {
      final SecureFeedbackTokenStore store = SecureFeedbackTokenStore(
        config: runConfig(serviceUrl, appId),
      );
      await store.clear();
      final String? leftover = await store.read();
      tokenCleared = leftover == null || leftover.isEmpty;
      if (!tokenCleared) {
        cleanupError = '本轮令牌键清理后仍读到非空值（长度 ${leftover.length}）';
      }
    } catch (e) {
      cleanupError = '本轮令牌键清理失败：${sanitizeErrorText(e.toString())}';
    }

    // 探针键（本轮独立 `<appId>.probe.<runId>` 槽位）
    try {
      final SecureFeedbackTokenStore probe = SecureFeedbackTokenStore(
        config: FeedbackConfig(serviceUrl, '$appId.probe.$runId'),
      );
      await probe.clear();
      final String? leftover = await probe.read();
      probeCleared = leftover == null || leftover.isEmpty;
      if (!probeCleared) {
        cleanupError ??= '本轮探针键清理后仍读到非空值（长度 ${leftover.length}）';
      }
    } catch (e) {
      cleanupError ??= '本轮探针键清理失败：${sanitizeErrorText(e.toString())}';
    }

    final bool ok = tokenCleared && probeCleared && cleanupError == null;
    final T1cCheck overall = ok
        ? const T1cCheck(T1cVerdict.pass, '本轮令牌键与探针键已清理')
        : T1cCheck(
            T1cVerdict.fail,
            '兜底清理未完成：令牌=${tokenCleared ? '已清' : '未确认'}；'
            '探针=${probeCleared ? '已清' : '未确认'}；${cleanupError ?? ''}',
            cleanupError: cleanupError,
          );

    await writePhaseResult(
      identity['resultFile']!,
      'cleanup',
      overall,
      runId: runId,
      appId: appId,
      username: username,
      checks: <Map<String, Object?>>[
        T1cCheck(
          tokenCleared ? T1cVerdict.pass : T1cVerdict.fail,
          tokenCleared ? '本轮令牌键已清空' : '本轮令牌键未确认清空',
        ).toCheckJson('tokenCleared'),
        T1cCheck(
          probeCleared ? T1cVerdict.pass : T1cVerdict.fail,
          probeCleared ? '本轮探针键已清空' : '本轮探针键未确认清空',
        ).toCheckJson('probeCleared'),
      ],
      cleanup: <String, Object?>{
        'tokenCleared': tokenCleared,
        'probeCleared': probeCleared,
      },
    );

    if (!overall.pass) fail('FAIL：${overall.reason}');
  });
}
