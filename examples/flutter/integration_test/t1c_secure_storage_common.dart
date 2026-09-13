// T1-C 默认安全存储验收 · 公共设施（探针 / 真实接收观察 / 结果文件 / 握手）。
//
// 目标：验证组件**默认入口**（不注入 tokenStore，直接使用
// `SecureFeedbackTokenStore` + flutter_secure_storage 默认 Data Protection
// Keychain）的真实写入、读取与应用重启恢复。现有
// t1_native_lifecycle_test.dart 注入 MemoryTokenStore，只验证流程，
// 不作为默认存储验收，也不证明 Keychain 或重启恢复。
//
// 统一执行入口（唯一推荐）：`python3 e2e/run_t1c_default_storage.py`
// —— 由执行器自行启动**本轮专用**服务（独立数据目录/随机管理员/空闲端口）、
// 登记本轮应用与账号，并生成 runId 与全部参数（经 `--dart-define-from-file`
// 注入 0600 参数文件）。手工运行单个阶段必须提供同一组 defines，否则按执行
// 前置错误判 FAIL。
//
// 验收依据（T1-C1）：**以服务端真实接收为准**——阶段内观察到一次
// `POST /api/feedback` 返回 201、带非空 feedbackId、且不是幂等重放，才算
// 提交成功。隔离服务不配置 AI / Kaneo，后台归档失败不影响"已接收"这一事实，
// 因此不再等待 `feedback-continue`（已归档界面）。观察器经组件已有
// `httpClient` 注入点接入，底层使用正常客户端，**不伪造响应、不主动提交、
// 不替组件重试**；读取响应流后必须以相同状态、头与字节交还组件，且只记录
// 反馈 POST 的状态 / 反馈 ID / 重放标记，不记录凭据、请求头或正文。
//
// 结果协议（与 `e2e/t1c_executor_lib.py` 完全一致，**不混用大小写**）：
//   {"runId","phase":"1"|"2","verdict":"PASS"|"FAIL"|"BLOCKED",
//    "reason","blockedCause"?,"cleanupError"?,
//    "identity":{"appId","username"},"checks":[{"name","verdict",...}],
//    "acceptance":{"httpStatus","feedbackId","replayed"},
//    "cleanup":{"probeCleared":bool,...}}
// - PASS 要求必需检查项（probe / tokenPersisted / acceptance / …）齐全且
//   全部 PASS，且强制清理项均为 true；
// - BLOCKED 只在**可明确识别** OSStatus -34018（errSecMissingEntitlement）
//   时写入 `blockedCause: "missing-entitlement"`；
// - 只要清理失败（cleanupError 非空），整体就是 FAIL —— 即使主错误是 -34018。
//
// 隔离策略（只清理本轮身份数据）：存储键由 (apiBase, appId) 派生，
// appId 为本轮专用的 `t1c-<runId>`；探针另用 `<appId>.probe.<runId>`
// 独立槽位。不得读写已有用户凭据。
import 'dart:convert';
import 'dart:io';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/platform_io.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

/// 管理员凭据只经 `--dart-define` 注入（本地 .env），源码不写入凭据字面量。
/// 两阶段测试进程不需要管理员权限——应用登记与账号都由执行器预检创建。
const String kAdminUser = String.fromEnvironment('FEEDBACK_ADMIN_USER');
const String kAdminPass = String.fromEnvironment('FEEDBACK_ADMIN_PASSWORD');

/// dart-define 注入的本轮参数（执行器与两阶段必须完全一致）。
const String kRunId = String.fromEnvironment('T1C_RUN_ID');
const String kTestAppId = String.fromEnvironment('T1C_APP_ID');
const String kTestUser = String.fromEnvironment('T1C_TEST_USERNAME');
const String kTestPass = String.fromEnvironment('T1C_TEST_PASSWORD');
const String kServiceUrl = String.fromEnvironment('T1C_SERVICE_URL');
const String kResultFile = String.fromEnvironment('T1C_RESULT_FILE');
const String kPhase1File = String.fromEnvironment('T1C_PHASE1_FILE');
const String kHandshakeFile = String.fromEnvironment('T1C_HANDSHAKE_FILE');

/// 阶段结论。
enum T1cVerdict { pass, fail, blocked }

/// 线上契约只使用大写（Python 判定库同样只接受大写；小写按 FAIL 处理）。
extension T1cVerdictWire on T1cVerdict {
  String get wire => switch (this) {
        T1cVerdict.pass => 'PASS',
        T1cVerdict.fail => 'FAIL',
        T1cVerdict.blocked => 'BLOCKED',
      };
}

/// 唯一允许判 BLOCKED 的原因标识。
const String kBlockedCauseMissingEntitlement = 'missing-entitlement';

/// 必需检查项名称（与 `e2e/t1c_executor_lib.py` 的 REQUIRED_CHECKS 一致）。
const String kCheckProbe = 'probe';
const String kCheckTokenPersisted = 'tokenPersisted';
const String kCheckPhase1Record = 'phase1Record';
const String kCheckTokenRestored = 'tokenRestored';
const String kCheckIdentityRestored = 'identityRestored';
const String kCheckAcceptance = 'acceptance';
const String kCheckCleanup = 'cleanup';

/// 单项/整体检查结论。[cleanupError] 独立记录清理失败，不覆盖主原因。
class T1cCheck {
  const T1cCheck(this.verdict, this.reason, {this.cleanupError, this.blockedCause});

  final T1cVerdict verdict;
  final String reason;
  final String? cleanupError;
  final String? blockedCause;

  bool get pass => verdict == T1cVerdict.pass;

  Map<String, Object?> toJson() => <String, Object?>{
        'verdict': verdict.wire,
        'reason': reason,
        'cleanupError': ?cleanupError,
        'blockedCause': ?blockedCause,
      };

  /// 作为 `checks` 数组中的一个条目。
  Map<String, Object?> toCheckJson(String name) =>
      <String, Object?>{'name': name, ...toJson()};
}

/// 探针结果：结论 + 是否已确认清理完成（供 `cleanup.probeCleared` 使用）。
class T1cProbeOutcome {
  const T1cProbeOutcome(this.check, {required this.cleared, this.clearedBy});

  final T1cCheck check;
  final bool cleared;
  final String? clearedBy;
}

/// 截断并脱敏错误文本：不回显存储值，只保留错误码与消息骨架。
String sanitizeErrorText(String raw) {
  final String oneLine = raw.replaceAll('\n', ' ').trim();
  return oneLine.length <= 300 ? oneLine : '${oneLine.substring(0, 300)}…';
}

// ------------------------------------------------------------------ 真实接收观察

/// 一次反馈提交的接收观察记录。**只**记录状态、反馈 ID 与重放标记。
class AcceptanceRecord {
  const AcceptanceRecord({
    required this.httpStatus,
    required this.feedbackId,
    required this.replayed,
    this.timedOut = false,
    this.submissionCount = 0,
  });

  const AcceptanceRecord.timeout(this.submissionCount)
      : httpStatus = 0,
        feedbackId = null,
        replayed = false,
        timedOut = true;

  final int httpStatus;
  final String? feedbackId;
  final bool replayed;
  final bool timedOut;

  /// 本阶段观察到的 `POST /api/feedback` 次数（要求恰好一次）。
  final int submissionCount;

  Map<String, Object?> toJson() => <String, Object?>{
        'httpStatus': httpStatus,
        'feedbackId': feedbackId,
        'replayed': replayed,
      };
}

/// 真实 HTTP 转发观察器。
///
/// 底层是正常客户端：请求原样转发，响应原样交还（读取响应流后以相同状态、
/// 头与字节重建），不伪造、不重试、不主动提交。只对
/// `POST /api/feedback` 记录接收结果。
class AcceptanceObserver extends http.BaseClient {
  AcceptanceObserver([http.Client? inner]) : _inner = inner ?? http.Client();

  final http.Client _inner;
  final List<AcceptanceRecord> submissions = <AcceptanceRecord>[];

  int get submissionCount => submissions.length;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final bool isFeedbackPost =
        request.method == 'POST' && request.url.path.endsWith('/api/feedback');
    final http.StreamedResponse response = await _inner.send(request);
    if (!isFeedbackPost) return response;

    // 必须完整读走响应体才能观察；随后以相同状态/头/字节交还组件。
    final Uint8List bytes = await response.stream.toBytes();
    int status = response.statusCode;
    String? feedbackId;
    bool replayed = false;
    try {
      final Object? decoded = jsonDecode(utf8.decode(bytes, allowMalformed: true));
      if (decoded is Map) {
        final Object? id = decoded['feedbackId'];
        if (id is String) feedbackId = id;
        replayed = decoded['replayed'] == true;
      }
    } catch (_) {
      // 解析失败只影响观察结果；组件仍拿到原样字节，由组件自己判定。
    }
    submissions.add(AcceptanceRecord(
      httpStatus: status,
      feedbackId: feedbackId,
      replayed: replayed,
    ));
    return http.StreamedResponse(
      Stream<List<int>>.value(bytes),
      status,
      contentLength: bytes.length,
      request: response.request,
      headers: response.headers,
      isRedirect: response.isRedirect,
      persistentConnection: response.persistentConnection,
      reasonPhrase: response.reasonPhrase,
    );
  }

  @override
  void close() => _inner.close();
}

/// 纯函数：把接收观察结果判成结构化结论。
T1cCheck classifyAcceptance(AcceptanceRecord record) {
  if (record.timedOut) {
    return T1cCheck(
      T1cVerdict.fail,
      '等待服务端接收超时：30 秒内未观察到反馈提交'
      '（已观察到 ${record.submissionCount} 次）',
    );
  }
  if (record.submissionCount > 1) {
    return T1cCheck(
      T1cVerdict.fail,
      '本阶段观察到 ${record.submissionCount} 次反馈提交（要求恰好一次）',
    );
  }
  // 重放判定优先于状态码：服务端对幂等重放返回 200 replayed:true，
  // 不能把它误报成普通的"未接收"。
  if (record.replayed) {
    return T1cCheck(
      T1cVerdict.fail,
      '反馈提交为幂等重放（replayed:true，HTTP ${record.httpStatus}）'
      '——重放不算新的接收',
    );
  }
  if (record.httpStatus != 201) {
    return T1cCheck(
      T1cVerdict.fail,
      '反馈提交未被接收：HTTP ${record.httpStatus}（要求 201）',
    );
  }
  final String? id = record.feedbackId;
  if (id == null || id.isEmpty) {
    return const T1cCheck(
      T1cVerdict.fail,
      '服务端返回 201 但缺少 feedbackId——证据不足不得判接收',
    );
  }
  return T1cCheck(T1cVerdict.pass, '服务端已接收：HTTP 201，feedbackId=$id');
}

/// 等待一次服务端接收（至多 [timeout]）。观察到首条后再多等
/// [duplicateWindow] 以确认没有重复提交。
Future<AcceptanceRecord> waitForAcceptance(
  WidgetTester tester,
  AcceptanceObserver observer, {
  Duration timeout = const Duration(seconds: 30),
  Duration duplicateWindow = const Duration(seconds: 3),
  String what = '服务端接收',
}) async {
  final DateTime deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    if (observer.submissionCount > 0) break;
    await tester.pump(const Duration(milliseconds: 200));
  }
  if (observer.submissionCount == 0) {
    return const AcceptanceRecord.timeout(0);
  }
  final DateTime dupEnd = DateTime.now().add(duplicateWindow);
  while (DateTime.now().isBefore(dupEnd)) {
    await tester.pump(const Duration(milliseconds: 200));
  }
  final AcceptanceRecord first = observer.submissions.first;
  return AcceptanceRecord(
    httpStatus: first.httpStatus,
    feedbackId: first.feedbackId,
    replayed: first.replayed,
    submissionCount: observer.submissionCount,
  );
}

// ------------------------------------------------------------------ 判定纯函数

/// 纯函数：把探针/预检捕获的原始错误分类为结构化结论。
///
/// - 仅当 [error] 是 PlatformException 且 code/message/details 中**可明确
///   识别** OSStatus -34018（errSecMissingEntitlement）→ BLOCKED，并写入
///   `blockedCause`；
/// - 其他 PlatformException / 任意未知异常 → FAIL（保留实际错误码与脱敏
///   消息，不伪装成签名问题）；
/// - [readBack] 为 null 或与 [expectValue] 不一致 → FAIL（不回显内容，
///   只比较长度）；
/// - **[cleanupError] 非空时整体一律 FAIL**（探针清理失败判 FAIL），主原因与
///   清理原因都保留。
T1cCheck classifyStorageFailure({
  required Object? error,
  required String? readBack,
  required String expectValue,
  String? cleanupError,
}) {
  T1cCheck main;
  if (error != null) {
    if (error is PlatformException) {
      final String text = sanitizeErrorText(
        '${error.code} | ${error.message ?? ''} | ${error.details ?? ''}',
      );
      if (text.contains('-34018') || text.contains('errSecMissingEntitlement')) {
        main = const T1cCheck(
          T1cVerdict.blocked,
          '默认 Data Protection Keychain 不可写：缺少 entitlement '
          '（OSStatus -34018 / errSecMissingEntitlement）——需有效 Apple 签名'
          '身份 + Keychain Sharing 后执行默认存储验收',
          blockedCause: kBlockedCauseMissingEntitlement,
        );
      } else {
        main = T1cCheck(
          T1cVerdict.fail,
          '平台安全存储错误（非已知签名阻塞，不得转 BLOCKED）：$text',
        );
      }
    } else {
      main = T1cCheck(
        T1cVerdict.fail,
        '未知错误（非 PlatformException，不得转 BLOCKED）：'
        '${error.runtimeType}: ${sanitizeErrorText(error.toString())}',
      );
    }
  } else if (readBack == null) {
    main = const T1cCheck(T1cVerdict.fail, '探针写入后读取为空（令牌丢失）');
  } else if (readBack != expectValue) {
    main = T1cCheck(
      T1cVerdict.fail,
      '探针写入后读取不一致：期望长度 ${expectValue.length}，'
      '实际长度 ${readBack.length}（内容不回显）',
    );
  } else {
    main = const T1cCheck(T1cVerdict.pass, '探针写入并读回一致');
  }
  if (cleanupError != null) {
    final String detail = sanitizeErrorText(cleanupError);
    return T1cCheck(
      T1cVerdict.fail,
      main.pass
          ? '探针本身通过，但清理失败：$detail'
          : '${main.reason}｜清理失败：$detail（两个原因都保留，整体判 FAIL）',
      cleanupError: detail,
    );
  }
  return main;
}

/// 纯函数：恢复阶段前置检查——成功记录有效但默认存储中无令牌时，
/// 必须 FAIL「重启后凭据丢失」，禁止跳过。
T1cCheck classifyRestorePrecheck({
  required bool phase1RecordValid,
  required String? storedToken,
}) {
  if (!phase1RecordValid) {
    return const T1cCheck(
      T1cVerdict.fail,
      '执行前置错误：第一阶段成功记录缺失、损坏或 runId 不匹配',
    );
  }
  if (storedToken == null || storedToken.isEmpty) {
    return const T1cCheck(
      T1cVerdict.fail,
      '重启后凭据丢失：第一阶段成功记录有效，但默认安全存储中读不到令牌',
    );
  }
  return const T1cCheck(T1cVerdict.pass, '成功记录与持久化令牌均有效');
}

// ------------------------------------------------------------------ 运行参数与身份

/// 读取本轮 dart-define 参数；任一缺失返回 null（调用方按执行前置错误 FAIL）。
Map<String, String>? loadRunIdentity({
  bool needPhase1File = false,
  bool needHandshakeFile = true,
}) {
  final Map<String, String> defs = <String, String>{
    'runId': kRunId,
    'appId': kTestAppId,
    'username': kTestUser,
    'password': kTestPass,
    'serviceUrl': kServiceUrl,
    'resultFile': kResultFile,
    if (needPhase1File) 'phase1File': kPhase1File,
    if (needHandshakeFile) 'handshakeFile': kHandshakeFile,
  };
  if (defs.values.any((String v) => v.isEmpty)) return null;
  return defs;
}

/// 本轮隔离配置（存储键由 apiBase+appId 派生，appId 为本轮专用）。
///
/// 呼出入口必须与示例一致：阶段测试点击的是 `feedback-orb`，而
/// `launcherMode` 默认是 `tab`（经典标签），不设成 orb 就找不到该入口。
/// 截图能力与验收目标无关，保持关闭（与原生流程集成测试一致）。
FeedbackConfig runConfig(String serviceUrl, String appId) => FeedbackConfig(
      serviceUrl,
      appId,
      appVersion: '1.0.0',
      pageLabel: 't1c-acceptance',
      side: FeedbackSide.right,
      launcherMode: FeedbackLauncherMode.orb,
      captureMode: FeedbackCaptureMode.off,
    );

/// 结构化握手：执行器据此拿到**本轮应用进程 PID 与实际可执行路径**，
/// 核验所属用户、可执行路径与启动时间后才允许管理该进程，并据此定位 `.app`
/// 采集该阶段签名证据。缺少本记录时执行器判「退出无法确认」。
Future<void> writeHandshake(String path, String runId, String phase) async {
  final File file = File(path);
  await file.parent.create(recursive: true);
  await file.writeAsString(
    const JsonEncoder.withIndent('  ').convert(<String, Object?>{
      'runId': runId,
      'phase': phase,
      'pid': pid,
      'exePath': Platform.resolvedExecutable,
      'writtenAt': DateTime.now().toUtc().toIso8601String(),
    }),
  );
}

/// 探针：默认安全存储真实可写性（本轮独立 `.probe.<runId>` 槽位，试后即清）。
///
/// 只有可识别的 -34018 才是 BLOCKED；清理失败（cleanupError 非空）一律 FAIL。
/// `cleared` 只有在**能证明不存在残留**时才为 true：
/// - 删除成功且随后读取为空；或
/// - 删除失败但本轮写入从未成功、且再次读取确认为空（无法证明则不得推断）。
Future<T1cProbeOutcome> probeSecureStorageWritable(
    String serviceUrl, String runId) async {
  const String probeValue = '__t1c_probe__';
  final SecureFeedbackTokenStore probe = SecureFeedbackTokenStore(
    config: FeedbackConfig(serviceUrl, '$kTestAppId.probe.$runId'),
  );
  Object? error;
  String? readBack;
  bool writeCompleted = false;
  bool cleared = false;
  String? clearedBy;
  String? cleanupError;
  try {
    await probe.write(probeValue);
    writeCompleted = true;
    readBack = await probe.read();
  } catch (e) {
    error = e;
  }
  try {
    await probe.clear();
    final String? leftover = await probe.read();
    if (leftover == null || leftover.isEmpty) {
      cleared = true;
      clearedBy = 'delete+read-null';
    } else {
      cleanupError = '探针清理后仍读到非空值（长度 ${leftover.length}）';
    }
  } catch (e) {
    final String first = sanitizeErrorText(e.toString());
    try {
      final String? leftover = await probe.read();
      if (!writeCompleted && (leftover == null || leftover.isEmpty)) {
        // 本轮从未成功写入该独立槽位，且再次读取确认为空 → 可记录清理完成
        cleared = true;
        clearedBy = 'write-never-succeeded+read-null';
      } else {
        cleanupError = first;
      }
    } catch (e2) {
      cleanupError = '$first｜二次读取失败：${sanitizeErrorText(e2.toString())}';
    }
  }
  final T1cCheck check = classifyStorageFailure(
    error: error,
    readBack: readBack,
    expectValue: probeValue,
    cleanupError: cleanupError,
  );
  return T1cProbeOutcome(check, cleared: cleared, clearedBy: clearedBy);
}

/// 写阶段结果文件（JSON；只含运行标识、测试身份与检查结论，不含令牌/口令）。
Future<void> writePhaseResult(
  String path,
  String phase,
  T1cCheck overall, {
  required String runId,
  required String appId,
  required String username,
  List<Map<String, Object?>> checks = const <Map<String, Object?>>[],
  Map<String, Object?>? acceptance,
  Map<String, Object?> cleanup = const <String, Object?>{},
}) async {
  final File file = File(path);
  await file.parent.create(recursive: true);
  final Map<String, Object?> body = <String, Object?>{
    'runId': runId,
    'phase': phase,
    'verdict': overall.verdict.wire,
    'reason': overall.reason,
    'identity': <String, Object?>{'appId': appId, 'username': username},
    'checks': checks,
    'cleanup': cleanup,
    'finishedAt': DateTime.now().toUtc().toIso8601String(),
  };
  if (acceptance != null) body['acceptance'] = acceptance;
  if (overall.cleanupError != null) body['cleanupError'] = overall.cleanupError;
  if (overall.verdict == T1cVerdict.blocked) {
    // 只有明确识别到阻塞原因才写入；缺失时执行器按 FAIL 处理（fail-closed）
    final String? cause = overall.blockedCause;
    if (cause != null) body['blockedCause'] = cause;
  }
  await file.writeAsString(const JsonEncoder.withIndent('  ').convert(body));
}

/// 读取第一阶段结果文件（恢复阶段前置）。解析失败返回 null（调用方 FAIL）。
Map<String, Object?>? readPhase1Result(String path) {
  try {
    final Object? decoded = jsonDecode(File(path).readAsStringSync());
    return decoded is Map<String, Object?> ? decoded : null;
  } catch (_) {
    return null;
  }
}

/// 第一阶段成功记录必须同时满足：runId 一致、phase == "1"、verdict == "PASS"、
/// 身份与本轮完全一致。
bool phase1RecordValid(Map<String, Object?>? record, String runId, String appId,
    String username) {
  if (record == null) return false;
  if (record['runId'] != runId || record['phase'] != '1') return false;
  if (record['verdict'] != 'PASS') return false;
  final Object? identity = record['identity'];
  if (identity is! Map) return false;
  return identity['appId'] == appId && identity['username'] == username;
}

// ------------------------------------------------------------------ 宿主与等待

/// 宿主：与示例 main.dart 同构，但**不注入 tokenStore**——面板使用组件
/// 默认 `SecureFeedbackTokenStore`（T1-C 验收对象）。
///
/// [httpClient] 只用于挂载真实 HTTP 转发观察器（不改变请求/响应内容）。
Widget buildHost(
  FeedbackController controller,
  FeedbackConfig config, {
  http.Client? httpClient,
}) {
  return MaterialApp(
    home: FeedbackWidget(
      config: config,
      controller: controller,
      httpClient: httpClient,
      child: const Scaffold(body: Center(child: Text('宿主内容'))),
    ),
  );
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
