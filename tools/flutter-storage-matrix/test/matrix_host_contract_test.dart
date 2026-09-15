// 宿主自身的契约测试：无论矩阵停在哪一档，被固定下来的插件都必须满足
// 「组件包用到的 API 存在、行为不变」。
//
// run.sh 每档都会传 --dart-define=MATRIX_EXPECTED_SECURE_STORAGE_VERSION=<档位>，
// 这里据此断言实际解析到的插件版本就是该档；手工直接 `flutter test` 时退化为
// 只校验版本落在组件包允许的区间内。
import 'dart:io';

import 'package:feedback_storage_matrix/feedback_storage_matrix.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

/// 由 run.sh 注入的档位（未注入时为空字符串）。
const String expectedVersion =
    String.fromEnvironment('MATRIX_EXPECTED_SECURE_STORAGE_VERSION');

/// 从解析产物 pubspec.lock 里读出实际使用的插件版本（不猜版本）。
String resolvedSecureStorageVersion() {
  Directory dir = Directory.current;
  for (int i = 0; i < 5; i++) {
    final File lock = File('${dir.path}/pubspec.lock');
    if (lock.existsSync()) {
      final String text = lock.readAsStringSync();
      final RegExpMatch? match = RegExp(
        r'^  flutter_secure_storage:\n(?:.*\n)*?    version: "?([^"\n]+)"?$',
        multiLine: true,
      ).firstMatch(text);
      if (match != null) {
        return match.group(1)!;
      }
    }
    dir = dir.parent;
  }
  throw StateError('未能在 pubspec.lock 中找到 flutter_secure_storage 的版本');
}

int _compare(String left, String right) {
  List<int> parts(String value) {
    final List<int> numbers = value
        .split('.')
        .map((String chunk) => int.tryParse(chunk.replaceAll(RegExp(r'[^0-9]'), '')) ?? 0)
        .toList();
    while (numbers.length < 3) {
      numbers.add(0);
    }
    return numbers;
  }

  final List<int> a = parts(left);
  final List<int> b = parts(right);
  for (int i = 0; i < 3; i++) {
    if (a[i] != b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

void main() {
  test('宿主声明的档位与组件包约束区间一致（防止脚本与文档漂移）', () {
    expect(matrixTiers, orderedEquals(<String>['9.2.2', '10.3.1', '11.0.0']));
    expect(supportedSecureStorageRange, '>=9.2.2 <12.0.0');
  });

  test('实际解析到的插件版本就是本档固定要求', () {
    final String resolved = resolvedSecureStorageVersion();
    if (expectedVersion.isNotEmpty) {
      expect(resolved, expectedVersion,
          reason: 'run.sh 固定到 $expectedVersion，实际解析出 $resolved');
      return;
    }
    expect(_compare(resolved, '9.2.2') >= 0 && _compare(resolved, '12.0.0') < 0, isTrue,
        reason: '未注入档位时，实际解析出的 $resolved 也必须落在组件包允许区间内');
  });

  test('组件用到的插件 API（read/write/delete）在真实实现上往返正常', () async {
    // 与组件测试使用同一套夹具入口：驱动真实 FlutterSecureStorage 的内存平台实现。
    final Map<String, String> backend = <String, String>{};
    FlutterSecureStorage.setMockInitialValues(backend);
    const FlutterSecureStorage storage = FlutterSecureStorage();
    const String key = 'feedback_widget.bearer_token.matrix-probe';

    expect(await storage.read(key: key), isNull, reason: '未写入时必须返回 null');
    await storage.write(key: key, value: 'tok-matrix');
    expect(await storage.read(key: key), 'tok-matrix');
    await storage.delete(key: key);
    expect(await storage.read(key: key), isNull, reason: '删除后不得再读到');
    await storage.delete(key: key); // 幂等：登出/清理重复删除不得抛异常
    expect(backend.containsKey(key), isFalse);
  });

  test('删除一个从未写入的键不抛异常（清理路径幂等）', () async {
    final Map<String, String> backend = <String, String>{};
    FlutterSecureStorage.setMockInitialValues(backend);
    const FlutterSecureStorage storage = FlutterSecureStorage();
    await expectLater(
      storage.delete(key: 'feedback_widget.bearer_token.never-written'),
      completes,
    );
    expect(backend, isEmpty);
  });
}
