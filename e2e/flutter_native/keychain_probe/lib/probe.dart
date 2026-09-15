// T3 verifier 独立原生探针的探针逻辑（真实平台通道，不使用任何 mock）。
//
// 走的是组件在原生平台的真实存储路径：`package:feedback_widget/src/platform_io.dart`
// 的 SecureFeedbackTokenStore（与 FeedbackWidget 默认仓库同一实现）。
// 同时模拟宿主自己的凭据（音乐服务器密码 + 第三方令牌），用于验证清理不越界。
//
// ignore_for_file: implementation_imports
import 'dart:convert';
import 'dart:io';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/platform_io.dart';
import 'package:flutter/services.dart' show PlatformException;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// 探针使用的服务身份（决定派生存储键）。
const String kProbeApiBase = 'https://feedback.probe.test';
const String kProbeAppId = 'com.feedbackverify.keychainprobe';

/// 宿主自己的凭据键（模拟音乐客户端）。
const String kMusicPasswordKey = 'music_subsonic_password';
const String kThirdPartyTokenKey = 'third_party.access_token';
const String kMusicPasswordValue = 'music-secret-t3';
const String kThirdPartyValue = 'third-party-token-t3';

/// 组件真实使用的令牌仓库实例。
SecureFeedbackTokenStore probeStore() => SecureFeedbackTokenStore(
      config: FeedbackConfig(kProbeApiBase, kProbeAppId),
    );

/// 直接拿插件实例（用于宿主凭据与"delete 是否真删"的观察）。
const FlutterSecureStorage kStorage = FlutterSecureStorage();

/// 一次探针运行的结构化结果。
class ProbeResult {
  ProbeResult(this.tag, this.phase, this.expect);

  final String tag;
  final String phase;
  final String expect;
  final Map<String, Object?> fields = <String, Object?>{};

  /// 记录一个观察值。
  void put(String key, Object? value) => fields[key] = value;

  /// 记录一次异常（code / message 原样保留）。
  void putError(String key, Object error) {
    if (error is PlatformException) {
      fields['${key}.error'] = 'PlatformException';
      fields['${key}.code'] = error.code;
      fields['${key}.message'] = error.message;
      fields['${key}.details'] = error.details?.toString();
    } else {
      fields['${key}.error'] = error.runtimeType.toString();
      fields['${key}.message'] = error.toString();
    }
  }

  Map<String, Object?> toJson({required String verdict}) => <String, Object?>{
        'tag': tag,
        'phase': phase,
        'expect': expect,
        'verdict': verdict,
        'platform': Platform.operatingSystem,
        'tokenKey': probeStore().storageKey,
        'fields': fields,
      };

  /// 落盘 + 打印，保证即使测试进程被杀也有产物。
  Future<String> emit({required String verdict}) async {
    final Map<String, Object?> json = toJson(verdict: verdict);
    final String encoded = const JsonEncoder.withIndent('  ').convert(json);
    stdout.writeln('PROBE_RESULT ${jsonEncode(json)}');
    try {
      final File f = File('${Directory.systemTemp.path}/probe-$tag.json');
      await f.writeAsString(encoded);
      stdout.writeln('PROBE_FILE ${f.path}');
      return f.path;
    } catch (error) {
      stdout.writeln('PROBE_FILE_ERROR $error');
      return '';
    }
  }
}

/// 探测宿主凭据是否仍然可读。
Future<void> recordHostCredentials(ProbeResult r) async {
  Object? musicErr;
  Object? thirdErr;
  String? music;
  String? third;
  try {
    music = await kStorage.read(key: kMusicPasswordKey);
  } catch (error) {
    musicErr = error;
  }
  try {
    third = await kStorage.read(key: kThirdPartyTokenKey);
  } catch (error) {
    thirdErr = error;
  }
  r.put('host.musicPassword.read', music);
  r.put('host.thirdPartyToken.read', third);
  if (musicErr != null) r.putError('host.musicPassword', musicErr);
  if (thirdErr != null) r.putError('host.thirdPartyToken', thirdErr);
}

/// 写入宿主自己的凭据（只在缺失时写，避免覆盖真实用户数据——探针用的是独立 bundle id）。
Future<void> seedHostCredentials(ProbeResult r) async {
  await kStorage.write(key: kMusicPasswordKey, value: kMusicPasswordValue);
  await kStorage.write(key: kThirdPartyTokenKey, value: kThirdPartyValue);
  r.put('host.seeded', true);
}

/// 检查应用沙盒/容器内是否存在令牌明文（安全存储不得出现明文回退）。
Future<void> scanForPlaintextToken(
    ProbeResult r, String token, List<String> roots) async {
  final List<String> hits = <String>[];
  int scanned = 0;
  for (final String root in roots) {
    final Directory dir = Directory(root);
    if (!dir.existsSync()) continue;
    try {
      await for (final FileSystemEntity entity
          in dir.list(recursive: true, followLinks: false)) {
        if (entity is! File) continue;
        final String base = entity.uri.pathSegments.isEmpty
            ? ''
            : entity.uri.pathSegments.last;
        // 探针自己的结构化产物里必然含令牌字面量，不算明文回退。
        if (base.startsWith('probe-') && base.endsWith('.json')) continue;
        if (entity.path.contains('/Library/Caches/') &&
            entity.path.endsWith('.dill')) {
          continue;
        }
        scanned++;
        if (entity.lengthSync() > 8 * 1024 * 1024) continue;
        try {
          if (entity.readAsStringSync().contains(token)) hits.add(entity.path);
        } catch (_) {
          // 二进制文件读不成字符串：跳过（不计为命中）
        }
      }
    } catch (_) {
      // 权限不可读的子树跳过
    }
  }
  r.put('plaintext.scannedFiles', scanned);
  r.put('plaintext.hits', hits);
}

/// 执行一个探针阶段并返回结果（macOS/iOS 走 integration_test，Android 走真实
/// 安装的 APK 进程；两条路径调用同一份逻辑）。
///
/// [phase]：write / read / delete / roundtrip / errorprobe
/// [expect]：entitled（存储可用）/ denied（存储不可用，必须显式失败）
Future<ProbeResult> runProbePhase({
  required String tag,
  required String phase,
  required String expect,
  required String token,
  String plaintextRoot = '',
  int postDelayMs = 0,
}) async {
  final SecureFeedbackTokenStore store = probeStore();
  final ProbeResult r = ProbeResult(tag, phase, expect);
  final List<String> roots = plaintextRoot.isEmpty
      ? <String>[]
      : plaintextRoot.split(',').where((String s) => s.isNotEmpty).toList();

  if (expect == 'denied') {
    // 存储不可用：写入必须显式失败，不得静默降级或明文回退。
    try {
      await store.write(token);
      r.put('write.threw', false);
    } catch (error) {
      r.put('write.threw', true);
      r.putError('write', error);
    }
    try {
      r.put('read.afterFailedWrite', await store.read());
      r.put('read.threw', false);
    } catch (error) {
      r.put('read.threw', true);
      r.putError('read', error);
    }
    await recordHostCredentials(r);
    if (roots.isNotEmpty) await scanForPlaintextToken(r, token, roots);
    final String blob = <Object?>[
      r.fields['write.code'],
      r.fields['write.details'],
      r.fields['write.message'],
    ].join(' ');
    final bool threw = r.fields['write.threw'] == true;
    // 真实 macOS 沙盒缺 entitlement 时，插件把 errSecMissingEntitlement
    // 包成 PlatformException：code="Unexpected security result code"、
    // details="-34018"、message 里带 "A required entitlement is not present"。
    r.put('verdictReason', 'writeThrew=$threw codeBlob=$blob');
    return r..put('_verdict', (threw && blob.contains('-34018')) ? 'PASS' : 'REVIEW');
  }

  if (phase == 'write') {
    await store.write(token);
    final String? back = await store.read();
    r.put('written', token);
    r.put('readBack', back);
    await seedHostCredentials(r);
    await recordHostCredentials(r);
    if (roots.isNotEmpty) await scanForPlaintextToken(r, token, roots);
    if (postDelayMs > 0) {
      // 让 Android SharedPreferences 的异步写盘（apply()）有机会完成：
      // 探针进程随后会退出，不等就会留下未落盘的假象。
      await Future<void>.delayed(Duration(milliseconds: postDelayMs));
      r.put('afterWriteDelayedMs', postDelayMs);
      r.put('readBackDelayed', await store.read());
      await recordHostCredentials(r);
    }
    final bool ok = back == token &&
        (postDelayMs == 0 || r.fields['readBackDelayed'] == token);
    return r..put('_verdict', ok ? 'PASS' : 'FAIL');
  }
  if (phase == 'cleanup') {
    // 清理探针自己写入的测试数据（只删本探针的键：令牌键 + 两个模拟宿主凭据键），
    // 不触碰任何其它 Keychain 条目。
    await store.clear();
    await kStorage.delete(key: kMusicPasswordKey);
    await kStorage.delete(key: kThirdPartyTokenKey);
    final List<String> left = <String>[];
    if (await store.read() != null) left.add(store.storageKey);
    if (await kStorage.read(key: kMusicPasswordKey) != null) {
      left.add(kMusicPasswordKey);
    }
    if (await kStorage.read(key: kThirdPartyTokenKey) != null) {
      left.add(kThirdPartyTokenKey);
    }
    await Future<void>.delayed(const Duration(milliseconds: 1500));
    r.put('remainingKeys', left);
    return r..put('_verdict', left.isEmpty ? 'PASS' : 'FAIL');
  }
  if (phase == 'absent') {
    // 耐久性复核：新进程启动后令牌必须**读不到**（删除已落盘）。
    final String? back = await store.read();
    final String? raw = await kStorage.read(key: store.storageKey);
    r.put('expected', 'null');
    r.put('readBack', back);
    r.put('rawReadBack', raw);
    await recordHostCredentials(r);
    return r..put('_verdict', (back == null && raw == null) ? 'PASS' : 'FAIL');
  }
  if (phase == 'read') {
    final String? back = await store.read();
    r.put('expected', token);
    r.put('readBack', back);
    await recordHostCredentials(r);
    return r..put('_verdict', back == token ? 'PASS' : 'FAIL');
  }
  if (phase == 'delete') {
    final String? before = await store.read();
    r.put('beforeDelete', before);
    await store.clear();
    final String? after = await store.read();
    final String? raw = await kStorage.read(key: store.storageKey);
    r.put('afterDelete', after);
    r.put('rawAfterDelete', raw);
    if (postDelayMs > 0) {
      // 用于区分「delete 真的没落盘」与「apply() 异步写盘还没刷完进程就被杀」：
      // 删除后先停留，让 SharedPreferences 的异步写盘有机会完成。
      await Future<void>.delayed(Duration(milliseconds: postDelayMs));
      r.put('afterDeleteDelayedMs', postDelayMs);
      r.put('afterDeleteDelayed', await store.read());
    }
    await recordHostCredentials(r);
    final bool delayedOk = postDelayMs == 0 ||
        r.fields['afterDeleteDelayed'] == null;
    return r
      ..put('_verdict',
          (before == token && after == null && raw == null && delayedOk)
              ? 'PASS'
              : 'FAIL');
  }

  // roundtrip：一次启动内 写 → 读 → 删 + 宿主凭据共存 + 明文扫描
  final String? initial = await store.read();
  r.put('initial', initial);
  await seedHostCredentials(r);
  await store.write(token);
  final String? back = await store.read();
  r.put('readBack', back);
  await recordHostCredentials(r);
  await store.clear();
  final String? after = await store.read();
  final String? raw = await kStorage.read(key: store.storageKey);
  r.put('afterDelete', after);
  r.put('rawAfterDelete', raw);
  await store.clear(); // 重复删除幂等
  await recordHostCredentials(r);
  if (postDelayMs > 0) {
    await Future<void>.delayed(Duration(milliseconds: postDelayMs));
    r.put('afterRoundtripDelayedMs', postDelayMs);
    r.put('afterDeleteDelayed', await store.read());
  }
  if (roots.isNotEmpty) await scanForPlaintextToken(r, token, roots);
  final bool pass = initial == null &&
      back == token &&
      after == null &&
      raw == null &&
      (postDelayMs == 0 || r.fields['afterDeleteDelayed'] == null) &&
      r.fields['host.musicPassword.read'] == kMusicPasswordValue &&
      r.fields['host.thirdPartyToken.read'] == kThirdPartyValue;
  return r..put('_verdict', pass ? 'PASS' : 'FAIL');
}

/// 组装最终 JSON（verdict 由 runProbePhase 判定）。
Map<String, Object?> finalizeResult(ProbeResult r) {
  final String verdict = (r.fields.remove('_verdict') as String?) ?? 'FAIL';
  return r.toJson(verdict: verdict);
}

/// 落盘 + 打印，返回判定结果（PASS / FAIL / REVIEW）。
///
/// 同时打印 `PROBE_RESULT` 单行 JSON 与 `PROBE_FILE <path>`，便于执行器采集；
/// Android 上 systemTemp 是应用 cache 目录，可用 `adb shell run-as` 取回。
Future<String> emitResult(ProbeResult r) async {
  final Map<String, Object?> json = finalizeResult(r);
  final String verdict = json['verdict']! as String;
  stdout.writeln('PROBE_RESULT ${jsonEncode(json)}');
  final File f = File('${Directory.systemTemp.path}/probe-${r.tag}.json');
  await f.writeAsString(const JsonEncoder.withIndent('  ').convert(json));
  stdout.writeln('PROBE_FILE ${f.path}');
  return verdict;
}
