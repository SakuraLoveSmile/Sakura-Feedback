// T1-C · 阶段 2/2：应用真实重启后，从默认安全存储恢复会话并成功提交（以服务端接收为准）。
//
// 与阶段 1（t1c_secure_storage_write_test.dart）配对：由统一执行器
// `e2e/run_t1c_default_storage.py` 在第一阶段明确 PASS、且应用进程退出被
// 确认后调起（两次 `flutter test -d macos` 之间即一次真实的应用重启）。
// 本阶段**不注入 tokenStore、不输入账号密码**——会话必须完全来自真实
// Data Protection Keychain 中的持久化令牌；身份须属于本轮测试账号。
//
// 验收依据（T1-C1）：服务端真实接收——阶段内恰好一次 `POST /api/feedback`
// 返回 201、带非空 feedbackId、且非幂等重放。经组件已有 `httpClient` 注入点
// 挂真实 HTTP 转发观察器（不伪造响应、不主动提交、不替组件重试）；隔离服务
// 不配置 AI / Kaneo，后台归档失败不影响"已接收"，因此**不再等待
// `feedback-continue`（已归档界面）**。
//
// 结论协议与阶段 1 相同：结构化结果文件 verdict 为唯一判定依据，
// 只使用大写 PASS / FAIL / BLOCKED，phase 为字符串 "2"。
//
// 前置顺序：**先检查第一阶段记录与身份**，记录无效立即 FAIL 且不读取存储；
// 记录有效但默认存储中读不到令牌 → FAIL「重启后凭据丢失」，禁止跳过。
//
// 收尾（finally）：本阶段结束（无论成败）都尝试清理本轮令牌与探针键，
// 清理未完成时写入 cleanupError（执行器按 FAIL 处理），并报告残留键身份。
import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/platform_io.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 't1c_secure_storage_common.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('T1-C 默认存储（阶段 2/2 恢复）：重启后从真实安全存储恢复会话 → 服务端接收 → 清理本轮身份',
      (WidgetTester tester) async {
    final Map<String, String>? identity =
        loadRunIdentity(needPhase1File: true);
    if (identity == null) {
      fail('执行前置错误：缺少 --dart-define 本轮参数'
          '（T1C_RUN_ID/T1C_APP_ID/T1C_TEST_USERNAME/T1C_TEST_PASSWORD/'
          'T1C_SERVICE_URL/T1C_RESULT_FILE/T1C_PHASE1_FILE/T1C_HANDSHAKE_FILE）'
          '——请使用统一执行入口');
    }
    final String runId = identity['runId']!;
    final String appId = identity['appId']!;
    final String username = identity['username']!;
    final String serviceUrl = identity['serviceUrl']!;
    final FeedbackConfig config = runConfig(serviceUrl, appId);
    final SecureFeedbackTokenStore store = SecureFeedbackTokenStore(config: config);
    final List<Map<String, Object?>> checks = <Map<String, Object?>>[];

    T1cCheck overall = const T1cCheck(T1cVerdict.fail, '阶段 2 未执行完成');
    AcceptanceRecord acceptance = const AcceptanceRecord.timeout(0);
    bool probeCleared = false;
    String? probeClearedBy;
    bool tokenCleared = false;
    String? tokenClearedBy;
    String? teardownCleanupError;

    try {
      await writeHandshake(identity['handshakeFile']!, runId, '2');

      // ---- 前置 1：第一阶段成功记录必须存在且属于本轮（身份完全一致）----
      final Map<String, Object?>? record =
          readPhase1Result(identity['phase1File']!);
      final bool recordValid =
          phase1RecordValid(record, runId, appId, username);
      checks.add(T1cCheck(
        recordValid ? T1cVerdict.pass : T1cVerdict.fail,
        recordValid
            ? '第一阶段成功记录有效且身份匹配'
            : '第一阶段成功记录缺失、损坏、verdict 非 PASS 或身份不匹配'
              '（执行前置错误，不读取存储）',
      ).toCheckJson(kCheckPhase1Record));

      if (!recordValid) {
        // 失败立即返回：不继续读取存储、不推断任何令牌状态
        overall = const T1cCheck(
          T1cVerdict.fail,
          '执行前置错误：第一阶段成功记录无效（缺失/损坏/runId 或身份不匹配）'
          '——不读取存储',
        );
      } else {
        // ---- 前置 2：探针按同一规则判定（环境中途变化时不得转 PASS）----
        final T1cProbeOutcome probe =
            await probeSecureStorageWritable(serviceUrl, runId);
        probeCleared = probe.cleared;
        probeClearedBy = probe.clearedBy;
        checks.add(probe.check.toCheckJson(kCheckProbe));

        if (!probe.check.pass) {
          overall = probe.check;
        } else {
          // ---- 前置 3：记录有效但默认存储中无令牌 → FAIL「重启后凭据丢失」----
          final String? persisted = await store.read();
          final T1cCheck restorePrecheck = classifyRestorePrecheck(
              phase1RecordValid: true, storedToken: persisted);
          checks.add(restorePrecheck.toCheckJson(kCheckTokenRestored));

          if (!restorePrecheck.pass) {
            overall = restorePrecheck;
          } else {
            final AcceptanceObserver observer = AcceptanceObserver();
            addTearDown(observer.close);
            final FeedbackController controller = FeedbackController();
            addTearDown(controller.dispose);
            await tester
                .pumpWidget(buildHost(controller, config, httpClient: observer));
            await tester.pump(const Duration(seconds: 1));

            // ---- 不做任何登录操作：会话必须从真实安全存储恢复 ----
            await tester.tap(find.byKey(const Key('feedback-orb')));
            await tester.pump(const Duration(milliseconds: 800));
            expect(controller.isOpen, isTrue);
            await waitFor(
              tester,
              () => find.textContaining(username).evaluate().isNotEmpty,
              what: '未登录操作的前提下从默认安全存储恢复会话，'
                  '且界面账号为本轮测试账号',
            );
            checks.add(const T1cCheck(T1cVerdict.pass,
                    '恢复会话身份与本轮测试账号一致（撰写区账号行核对）')
                .toCheckJson(kCheckIdentityRestored));

            // ---- 恢复的会话真实可用：提交并由服务端确认接收 ----
            await tester.enterText(
                find.byKey(const Key('feedback-input')), 'T1-C 重启恢复后提交验证');
            await tester.pump(const Duration(milliseconds: 300));
            await tester.tap(find.byKey(const Key('feedback-submit')));
            acceptance = await waitForAcceptance(tester, observer);
            final T1cCheck acceptanceCheck = classifyAcceptance(acceptance);
            checks.add(acceptanceCheck.toCheckJson(kCheckAcceptance));

            if (!acceptanceCheck.pass) {
              overall = acceptanceCheck;
            } else {
              overall = const T1cCheck(T1cVerdict.pass,
                  '阶段 2 通过：重启恢复会话 + 身份一致 + 服务端已接收');
            }
          }
        }
      }
    } catch (e) {
      overall = T1cCheck(
        T1cVerdict.fail,
        '阶段 2 未预期异常：${sanitizeErrorText(e.toString())}',
      );
    } finally {
      // ---- 本阶段结束（无论成败）都要尝试清理本轮令牌与探针键 ----
      try {
        await store.clear();
        final String? leftover = await store.read();
        tokenCleared = leftover == null || leftover.isEmpty;
        tokenClearedBy = 'delete+read-null';
        if (!tokenCleared) {
          teardownCleanupError = '本轮令牌存储键清理后仍读到非空值'
              '（长度 ${leftover.length}）';
        }
      } catch (e) {
        teardownCleanupError = '本轮令牌存储键清理失败：'
            '${sanitizeErrorText(e.toString())}';
      }
      final String? combinedCleanupError =
          teardownCleanupError ?? overall.cleanupError;
      if (combinedCleanupError != null) {
        overall = T1cCheck(
          T1cVerdict.fail,
          '${overall.reason}｜收尾清理失败：$combinedCleanupError'
          '（两个原因都保留，清理失败不得判 PASS/BLOCKED）',
          cleanupError: combinedCleanupError,
        );
      }
      checks.add(T1cCheck(
        tokenCleared && probeCleared ? T1cVerdict.pass : T1cVerdict.fail,
        tokenCleared && probeCleared
            ? '本轮令牌与探针键已清理（账号禁用由执行器负责）'
            : '清理未完成：令牌=${tokenCleared ? '已清' : '未确认'}'
              '；探针=${probeCleared ? '已清' : '未确认'}'
              '；${combinedCleanupError ?? '（记录残留身份，不判 PASS）'}',
        cleanupError: combinedCleanupError,
      ).toCheckJson(kCheckCleanup));
      await writePhaseResult(
        identity['resultFile']!,
        '2',
        overall,
        runId: runId,
        appId: appId,
        username: username,
        checks: checks,
        acceptance: acceptance.toJson(),
        cleanup: <String, Object?>{
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
