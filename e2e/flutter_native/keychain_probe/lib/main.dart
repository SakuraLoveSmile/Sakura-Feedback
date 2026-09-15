// T3 verifier 独立原生验收探针 App（真实 macOS / iOS / Android 进程）。
//
// 两种运行方式：
//  1) `--dart-define=PHASE=<阶段>`（Android 走这条路）：启动即跑阶段、写结构化
//     JSON 到应用 cache 目录，然后退出进程——配合 `adb install -r` 可真实验证
//     「进程重启后读取」与逐档升级（9→10→11）迁移。
//  2) 无 PHASE：显示可点按的界面，便于在真实设备上人工体验。
// ignore_for_file: implementation_imports
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:keychain_probe/probe.dart';

const String kPhase = String.fromEnvironment('PHASE');
const String kExpect = String.fromEnvironment('EXPECT', defaultValue: 'entitled');
const String kTag = String.fromEnvironment('TAG', defaultValue: 'headless');
const String kToken =
    String.fromEnvironment('TOKEN', defaultValue: 'token-native');
const String kPlaintextRoot = String.fromEnvironment('PLAINTEXT_ROOT');
const int kPostDelayMs = int.fromEnvironment('POST_DELAY_MS');

/// 入口：有 PHASE 时以无界面方式跑探针阶段并退出。
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (kPhase.isNotEmpty) {
    final ProbeResult r = await runProbePhase(
      tag: kTag,
      phase: kPhase,
      expect: kExpect,
      token: kToken,
      plaintextRoot: kPlaintextRoot,
      postDelayMs: kPostDelayMs,
    );
    final String verdict = await emitResult(r);
    stdout.writeln('PROBE_VERDICT $verdict');
    await stdout.flush();
    exit(verdict == 'PASS' ? 0 : 1);
  }
  runApp(const ProbeApp());
}

/// 探针 App 根。
class ProbeApp extends StatelessWidget {
  /// 构造根组件。
  const ProbeApp({super.key});

  @override
  Widget build(BuildContext context) => const MaterialApp(
        title: 'Keychain 探针',
        home: ProbeHome(),
      );
}

/// 探针首页：四个按钮对应 roundtrip / write / read / delete。
class ProbeHome extends StatefulWidget {
  /// 构造首页。
  const ProbeHome({super.key});

  @override
  State<ProbeHome> createState() => _ProbeHomeState();
}

class _ProbeHomeState extends State<ProbeHome> {
  String _log = '(未运行)';

  Future<void> _run(String action) async {
    final ProbeResult r = await runProbePhase(
      tag: 'manual',
      phase: action,
      expect: 'entitled',
      token: 'token-manual',
    );
    final String verdict = await emitResult(r);
    if (!mounted) return;
    setState(() => _log = '$action → $verdict\n'
        '${finalizeResult(r)}\n');
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Keychain 探针')),
        body: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text('存储键：${probeStore().storageKey}',
                  style: const TextStyle(fontSize: 12)),
              const SizedBox(height: 12),
              for (final String action in <String>[
                'roundtrip',
                'write',
                'read',
                'delete',
              ])
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: FilledButton(
                    onPressed: () => _run(action),
                    child: Text(action),
                  ),
                ),
              const SizedBox(height: 12),
              Expanded(
                child: SingleChildScrollView(
                  child: Text(_log, style: const TextStyle(fontSize: 12)),
                ),
              ),
            ],
          ),
        ),
      );
}
