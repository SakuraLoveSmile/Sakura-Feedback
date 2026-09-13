// T1-C 验收机制自身测试：探针错误分类与恢复前置判定的全部规则分支。
//
// 对应 VERIFICATION.md 第 9 轮机制表（与 `e2e/t1c_executor_lib.py` 同一契约）：
// - 可识别的 -34018 → BLOCKED（唯一允许的阻塞分类，并写入 blockedCause）；
// - 其他平台异常 / 未知异常 → FAIL（不伪装成签名问题）；
// - 写后读取为空 / 不一致 → FAIL；
// - 清理失败独立记录，不覆盖主原因；**只要清理失败，整体就是 FAIL**，
//   即使主错误是可识别的 -34018 也一样；
// - 结果 verdict 只使用大写 PASS / FAIL / BLOCKED；
// - 成功记录有效但存储无令牌 → FAIL「重启后凭据丢失」。
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../integration_test/t1c_secure_storage_common.dart';

void main() {
  group('classifyStorageFailure（T1-C 探针分类规则）', () {
    test('可识别的 -34018（message 携带）→ BLOCKED，保留实际错误信息并标注原因', () {
      final T1cCheck c = classifyStorageFailure(
        error: PlatformException(
          code: 'ss_write_failed',
          message: 'A required entitlement is not present. (-34018)',
        ),
        readBack: null,
        expectValue: '__t1c_probe__',
      );
      expect(c.verdict, T1cVerdict.blocked);
      expect(c.reason, contains('-34018'));
      expect(c.cleanupError, isNull);
      expect(c.blockedCause, kBlockedCauseMissingEntitlement);
    });

    test('可识别的 errSecMissingEntitlement（details 携带）→ BLOCKED', () {
      final T1cCheck c = classifyStorageFailure(
        error: PlatformException(
          code: 'unexpected_error',
          message: 'Keychain write failed',
          details: 'Error Domain=NSOSStatusErrorDomain Code=errSecMissingEntitlement',
        ),
        readBack: null,
        expectValue: '__t1c_probe__',
      );
      expect(c.verdict, T1cVerdict.blocked);
      expect(c.blockedCause, kBlockedCauseMissingEntitlement);
    });

    test('其他平台异常 → FAIL，保留实际错误码，不伪装成签名问题', () {
      final T1cCheck c = classifyStorageFailure(
        error: PlatformException(
          code: 'ss_error',
          message: 'errSecAuthFailed (-25293)',
        ),
        readBack: null,
        expectValue: '__t1c_probe__',
      );
      expect(c.verdict, T1cVerdict.fail);
      expect(c.reason, contains('ss_error'));
      expect(c.reason, startsWith('平台安全存储错误（非已知签名阻塞'));
      expect(c.blockedCause, isNull);
    });

    test('非 PlatformException 的未知错误 → FAIL', () {
      final T1cCheck c = classifyStorageFailure(
        error: StateError('MissingPluginException 形态之外的网络态错误'),
        readBack: null,
        expectValue: '__t1c_probe__',
      );
      expect(c.verdict, T1cVerdict.fail);
      expect(c.reason, contains('未知错误'));
    });

    test('写后读取为空 → FAIL', () {
      final T1cCheck c = classifyStorageFailure(
        error: null,
        readBack: null,
        expectValue: '__t1c_probe__',
      );
      expect(c.verdict, T1cVerdict.fail);
      expect(c.reason, contains('读取为空'));
    });

    test('写后读取不一致 → FAIL（不回显内容，只比较长度）', () {
      final T1cCheck c = classifyStorageFailure(
        error: null,
        readBack: 'other-value-totally-different',
        expectValue: '__t1c_probe__',
      );
      expect(c.verdict, T1cVerdict.fail);
      expect(c.reason, contains('不一致'));
      expect(c.reason, contains('长度'));
      expect(c.reason, isNot(contains('other-value')));
    });

    test('写入读回一致 → PASS', () {
      final T1cCheck c = classifyStorageFailure(
        error: null,
        readBack: '__t1c_probe__',
        expectValue: '__t1c_probe__',
      );
      expect(c.verdict, T1cVerdict.pass);
    });

    test('探针通过但清理失败 → 整体 FAIL，清理错误独立记录', () {
      final T1cCheck c = classifyStorageFailure(
        error: null,
        readBack: '__t1c_probe__',
        expectValue: '__t1c_probe__',
        cleanupError: 'clear 抛出 PlatformException(ss_error)',
      );
      expect(c.verdict, T1cVerdict.fail);
      expect(c.reason, contains('清理失败'));
      expect(c.cleanupError, contains('ss_error'));
    });

    test('主失败与清理失败同时存在 → 两者都记录，不以清理异常覆盖原原因', () {
      final T1cCheck c = classifyStorageFailure(
        error: PlatformException(code: 'ss_error', message: 'write boom'),
        readBack: null,
        expectValue: '__t1c_probe__',
        cleanupError: 'cleanup boom',
      );
      expect(c.verdict, T1cVerdict.fail);
      expect(c.reason, contains('write boom'));
      expect(c.cleanupError, contains('cleanup boom'));
    });

    test('可识别的 -34018 同时清理失败 → 不得判 BLOCKED，两个原因都保留', () {
      final T1cCheck c = classifyStorageFailure(
        error: PlatformException(
          code: 'ss_write_failed',
          message: 'A required entitlement is not present. (-34018)',
        ),
        readBack: null,
        expectValue: '__t1c_probe__',
        cleanupError: 'PlatformException(-34018) 删除探针键失败',
      );
      expect(c.verdict, T1cVerdict.fail);
      expect(c.verdict, isNot(T1cVerdict.blocked));
      expect(c.reason, contains('-34018'));
      expect(c.reason, contains('清理失败'));
      expect(c.cleanupError, contains('删除探针键失败'));
      expect(c.blockedCause, isNull);
    });
  });

  group('结果协议（线上只使用大写）', () {
    test('T1cCheck.toJson 输出大写 verdict 与 blockedCause', () {
      const T1cCheck blocked = T1cCheck(
        T1cVerdict.blocked,
        '阻塞',
        blockedCause: kBlockedCauseMissingEntitlement,
      );
      final Map<String, Object?> json = blocked.toJson();
      expect(json['verdict'], 'BLOCKED');
      expect(json['blockedCause'], kBlockedCauseMissingEntitlement);

      const T1cCheck pass = T1cCheck(T1cVerdict.pass, '通过');
      expect(pass.toJson()['verdict'], 'PASS');
      expect(pass.toJson().containsKey('blockedCause'), isFalse);

      const T1cCheck fail = T1cCheck(T1cVerdict.fail, '失败', cleanupError: 'boom');
      expect(fail.toJson()['verdict'], 'FAIL');
      expect(fail.toJson()['cleanupError'], 'boom');
    });

    test('检查项条目带机器可读 name', () {
      const T1cCheck c = T1cCheck(T1cVerdict.pass, 'ok');
      final Map<String, Object?> item = c.toCheckJson(kCheckProbe);
      expect(item['name'], 'probe');
      expect(item['verdict'], 'PASS');
    });
  });

  group('phase1RecordValid（恢复阶段前置）', () {
    Map<String, Object?> record({
      String runId = 'r1',
      String phase = '1',
      String verdict = 'PASS',
      String appId = 'a1',
      String username = 'u1',
    }) =>
        <String, Object?>{
          'runId': runId,
          'phase': phase,
          'verdict': verdict,
          'identity': <String, Object?>{'appId': appId, 'username': username},
        };

    test('身份、阶段、verdict 全一致 → true', () {
      expect(phase1RecordValid(record(), 'r1', 'a1', 'u1'), isTrue);
    });

    test('verdict 非 PASS（含小写历史值） → false', () {
      expect(phase1RecordValid(record(verdict: 'BLOCKED'), 'r1', 'a1', 'u1'), isFalse);
      expect(phase1RecordValid(record(verdict: 'pass'), 'r1', 'a1', 'u1'), isFalse);
    });

    test('runId / phase / 身份不一致或记录缺失 → false', () {
      expect(phase1RecordValid(record(runId: 'other'), 'r1', 'a1', 'u1'), isFalse);
      expect(phase1RecordValid(record(phase: '2'), 'r1', 'a1', 'u1'), isFalse);
      expect(phase1RecordValid(record(appId: 'x'), 'r1', 'a1', 'u1'), isFalse);
      expect(phase1RecordValid(null, 'r1', 'a1', 'u1'), isFalse);
    });
  });

  group('classifyRestorePrecheck（恢复阶段前置规则）', () {
    test('记录有效但存储无令牌 → FAIL「重启后凭据丢失」，禁止跳过', () {
      final T1cCheck c = classifyRestorePrecheck(
        phase1RecordValid: true,
        storedToken: null,
      );
      expect(c.verdict, T1cVerdict.fail);
      expect(c.reason, contains('重启后凭据丢失'));
    });

    test('记录有效但令牌为空串 → FAIL「重启后凭据丢失」', () {
      final T1cCheck c = classifyRestorePrecheck(
        phase1RecordValid: true,
        storedToken: '',
      );
      expect(c.verdict, T1cVerdict.fail);
      expect(c.reason, contains('重启后凭据丢失'));
    });

    test('记录无效（runId 不匹配 / 缺失）→ FAIL 执行前置错误', () {
      final T1cCheck c = classifyRestorePrecheck(
        phase1RecordValid: false,
        storedToken: 'some-token',
      );
      expect(c.verdict, T1cVerdict.fail);
      expect(c.reason, contains('执行前置错误'));
    });

    test('记录有效且有令牌 → PASS', () {
      final T1cCheck c = classifyRestorePrecheck(
        phase1RecordValid: true,
        storedToken: 'tok',
      );
      expect(c.verdict, T1cVerdict.pass);
    });
  });

  group('sanitizeErrorText（脱敏）', () {
    test('折叠换行并截断超长文本', () {
      final String out = sanitizeErrorText('a\nb\n${'x' * 500}');
      expect(out.contains('\n'), isFalse);
      expect(out.length, lessThan(310));
      expect(out.endsWith('…'), isTrue);
    });
  });
}
