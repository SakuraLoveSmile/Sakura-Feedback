// T1-C · 阶段 1/2：默认安全存储真实写入 + 跨实例读取 + 登录后提交（以服务端接收为准）。
//
// **不注入 tokenStore**：面板登录的令牌经组件默认
// SecureFeedbackTokenStore 写入真实 Data Protection Keychain。
// 本阶段由统一执行器 `e2e/run_t1c_default_storage.py` 调起：
// runId / 测试身份 / 结果文件 / 握手文件路径经 --dart-define 注入，
// 两阶段参数一致；账号与应用登记都由执行器在本轮专用服务上预先创建。
//
// 验收依据（T1-C1）：**服务端真实接收**。经组件已有 `httpClient` 注入点挂
// 一个真实 HTTP 转发观察器（底层正常客户端，不伪造响应、不主动提交、不替
// 组件重试、不注入 tokenStore）：阶段内恰好一次 `POST /api/feedback` 返回
// 201、带非空 feedbackId、且 `replayed` 不为 true 才算提交成功。隔离服务不
// 配置 AI / Kaneo，后台归档失败不影响"已接收"，因此**不再等待
// `feedback-continue`（已归档界面）**。
//
// 结论协议：结构化结果文件（T1C_RESULT_FILE）的 verdict 是唯一判定依据，
// 进程退出码只作旁证（BLOCKED → skip → exit 0；FAIL → fail() → exit 1）；
// verdict 只使用大写 PASS / FAIL / BLOCKED，phase 为字符串 "1"。
//
// 收尾（finally）：
// - 阶段 1 **成功**：令牌按设计保留给第二阶段的重启恢复验证
//   （cleanup.tokenCleared=false）；
// - 阶段 1 失败：尝试清理本轮令牌与探针键，并如实写入清理结论；
// - 无论如何都写入结构化结果文件（缺证据 = 执行器判 FAIL）。
import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/platform_io.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 't1c_secure_storage_common.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('T1-C 默认存储（阶段 1/2 写入）：面板登录 → 真实 Keychain 写入 → 跨实例读取 → 服务端接收',
      (WidgetTester tester) async {
    final Map<String, String>? identity = loadRunIdentity();
    if (identity == null) {
      // 参数缺失无法写结果文件：按执行前置错误直接失败（执行器按缺文件判 FAIL）。
      fail('执行前置错误：缺少 --dart-define 本轮参数'
          '（T1C_RUN_ID/T1C_APP_ID/T1C_TEST_USERNAME/T1C_TEST_PASSWORD/'
          'T1C_SERVICE_URL/T1C_RESULT_FILE/T1C_HANDSHAKE_FILE）——请使用统一执行入口');
    }
    final String runId = identity['runId']!;
    final String appId = identity['appId']!;
    final String username = identity['username']!;
    final String serviceUrl = identity['serviceUrl']!;
    final FeedbackConfig config = runConfig(serviceUrl, appId);
    final SecureFeedbackTokenStore store = SecureFeedbackTokenStore(config: config);
    final List<Map<String, Object?>> checks = <Map<String, Object?>>[];

    T1cCheck overall = const T1cCheck(T1cVerdict.fail, '阶段 1 未执行完成');
    AcceptanceRecord acceptance = const AcceptanceRecord.timeout(0);
    bool succeeded = false;
    bool loginAttempted = false;
    bool probeCleared = false;
    String? probeClearedBy;
    bool tokenCleared = false;
    String? tokenClearedBy;
    String? teardownCleanupError;

    try {
      // 结构化握手：执行器据此核验并管理本轮应用进程，并定位 .app 采集签名证据
      await writeHandshake(identity['handshakeFile']!, runId, '1');

      // ---- 探针：只有可识别的 -34018 才 BLOCKED；其余一律 FAIL ----
      final T1cProbeOutcome probe =
          await probeSecureStorageWritable(serviceUrl, runId);
      probeCleared = probe.cleared;
      probeClearedBy = probe.clearedBy;
      checks.add(probe.check.toCheckJson(kCheckProbe));

      if (!probe.check.pass) {
        overall = probe.check;
      } else {
        final AcceptanceObserver observer = AcceptanceObserver();
        addTearDown(observer.close);
        final FeedbackController controller = FeedbackController();
        addTearDown(controller.dispose);
        await tester
            .pumpWidget(buildHost(controller, config, httpClient: observer));
        await tester.pump(const Duration(seconds: 1));

        // ---- 面板内登录（默认安全存储写入令牌；账号由执行器预检创建）----
        loginAttempted = true;
        await tester.tap(find.byKey(const Key('feedback-orb')));
        await tester.pump(const Duration(milliseconds: 800));
        expect(controller.isOpen, isTrue);
        await tester.enterText(
            find.byKey(const Key('feedback-input')), 'T1-C 默认存储写入阶段验证');
        await tester.pump(const Duration(milliseconds: 300));
        await tester.tap(find.byKey(const Key('feedback-submit')));
        await tester.pump(const Duration(milliseconds: 600));
        expect(find.byKey(const Key('feedback-login-username')), findsOneWidget);
        await tester.enterText(
            find.byKey(const Key('feedback-login-username')), username);
        await tester.enterText(
            find.byKey(const Key('feedback-login-password')), identity['password']!);
        await tester.pump(const Duration(milliseconds: 200));
        await tester.tap(find.byKey(const Key('feedback-login-submit')));
        await waitFor(
          tester,
          () => find.byKey(const Key('feedback-login-form')).evaluate().isEmpty,
          timeout: const Duration(seconds: 30),
          what: '面板内登录成功（真实安全存储写入完成）',
        );

        // ---- 跨实例验证真实持久化：新建仓库实例从默认安全存储读回非空令牌 ----
        final SecureFeedbackTokenStore fresh =
            SecureFeedbackTokenStore(config: config);
        final String? stored = await fresh.read();
        final T1cCheck tokenCheck = T1cCheck(
          stored != null && stored.isNotEmpty ? T1cVerdict.pass : T1cVerdict.fail,
          stored != null && stored.isNotEmpty
              ? '跨实例读到非空令牌（内容不回显）'
              : '登录后跨实例读取令牌为空',
        );
        checks.add(tokenCheck.toCheckJson(kCheckTokenPersisted));

        // ---- 服务端真实接收（登录后自动续交一次）----
        acceptance = await waitForAcceptance(tester, observer);
        final T1cCheck acceptanceCheck = classifyAcceptance(acceptance);
        checks.add(acceptanceCheck.toCheckJson(kCheckAcceptance));

        if (!tokenCheck.pass) {
          overall = tokenCheck;
        } else if (!acceptanceCheck.pass) {
          overall = acceptanceCheck;
        } else {
          overall = const T1cCheck(
              T1cVerdict.pass, '阶段 1 通过：真实写入 + 跨实例读取 + 服务端已接收');
          succeeded = true;
        }
      }
    } catch (e) {
      overall = T1cCheck(
        T1cVerdict.fail,
        '阶段 1 未预期异常：${sanitizeErrorText(e.toString())}',
      );
      succeeded = false;
    } finally {
      if (succeeded) {
        // 令牌必须留给第二阶段的重启恢复验证
        tokenCleared = false;
        tokenClearedBy = 'retained-for-phase2';
      } else if (!loginAttempted) {
        // 尚未登录就失败：本轮从未写出令牌，无残留（可证明，非推断）
        tokenCleared = true;
        tokenClearedBy = 'never-written';
      } else {
        try {
          await store.clear();
          final String? leftover = await store.read();
          tokenCleared = leftover == null || leftover.isEmpty;
          tokenClearedBy = 'delete+read-null';
          if (!tokenCleared) {
            teardownCleanupError = '第一阶段失败后清理令牌：读取仍非空'
                '（长度 ${leftover.length}）';
          }
        } catch (e) {
          teardownCleanupError = '第一阶段失败后清理令牌失败：'
              '${sanitizeErrorText(e.toString())}';
        }
      }
      final String? combinedCleanupError =
          teardownCleanupError ?? overall.cleanupError;
      if (combinedCleanupError != null) {
        // 只要清理失败，整体就是 FAIL——即使主错误是可识别的 -34018
        overall = T1cCheck(
          T1cVerdict.fail,
          '${overall.reason}｜收尾清理失败：$combinedCleanupError'
          '（两个原因都保留，清理失败不得判 PASS/BLOCKED）',
          cleanupError: combinedCleanupError,
        );
      }
      await writePhaseResult(
        identity['resultFile']!,
        '1',
        overall,
        runId: runId,
        appId: appId,
        username: username,
        checks: checks,
        acceptance: acceptance.toJson(),
        cleanup: <String, Object?>{
          // 阶段 1 是否已确认清空本轮令牌键（PASS 时按设计为 false，留给阶段 2）
          'tokenCleared': tokenCleared,
          'probeCleared': probeCleared,
          'tokenClearedBy': ?tokenClearedBy,
          'probeClearedBy': ?probeClearedBy,
        },
      );
    }

    if (!overall.pass) {
      if (overall.verdict == T1cVerdict.blocked) {
        markTestSkipped('BLOCKED：${overall.reason}');
      } else {
        fail('FAIL：${overall.reason}');
      }
    }
  });
}
