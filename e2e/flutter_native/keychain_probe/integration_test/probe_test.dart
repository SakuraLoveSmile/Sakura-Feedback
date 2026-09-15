// T3 verifier 独立原生验收探针（integration_test 入口：macOS / iOS）。
//
// 真实应用进程 + 真实平台通道，无 mock：
//   cd e2e/flutter_native/work/<variant>/keychain_probe
//   flutter test integration_test/probe_test.dart -d macos --dart-define=PHASE=write ...
//
// 阶段与期望见 lib/probe.dart 的 runProbePhase。
// Android 不使用本入口（`flutter test` 会在跑完后卸载应用，跨档数据无法保留），
// 改为构建真实 APK + adb 安装/启动，见 run_native.sh 的 android-* 子命令。
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:keychain_probe/probe.dart';

const String kPhase = String.fromEnvironment('PHASE', defaultValue: 'roundtrip');
const String kExpect = String.fromEnvironment('EXPECT', defaultValue: 'entitled');
const String kTag = String.fromEnvironment('TAG', defaultValue: 'native');
const String kToken =
    String.fromEnvironment('TOKEN', defaultValue: 'token-native');
const String kPlaintextRoot = String.fromEnvironment('PLAINTEXT_ROOT');

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('原生安全存储探针 [$kTag/$kPhase/$kExpect]',
      (WidgetTester tester) async {
    final ProbeResult r = await runProbePhase(
      tag: kTag,
      phase: kPhase,
      expect: kExpect,
      token: kToken,
      plaintextRoot: kPlaintextRoot,
    );
    final String verdict = await emitResult(r);
    stdout.writeln('PROBE_VERDICT $verdict');
    expect(verdict, 'PASS',
        reason: '探针判定：$verdict（见 PROBE_RESULT 结构化输出）');
  });
}
