import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'panel_harness.dart';

/// 按 host 把请求路由到不同 [PanelServer]（双服务 A/B 测试）。
http.Client routedClient(Map<String, PanelServer> byHost) =>
    MockClient((http.Request request) async {
      final PanelServer? server = byHost[request.url.host];
      if (server == null) {
        return jsonResponse({
          'error': {'code': 'no_route', 'message': request.url.host}
        }, 404);
      }
      return server.handle(request);
    });

/// 读取挂起的偏好仓库：模拟慢存储，验证「就绪前不启动依赖服务器的请求」。
class DelayedPrefStore implements FeedbackServerPrefStore {
  final Completer<String?> _readCompleter = Completer<String?>();
  final Map<String, String> _data = <String, String>{};

  /// 放行挂起的读取。
  void completeRead([String? value]) => _readCompleter.complete(value);

  @override
  Future<String?> read(String key) => _readCompleter.future;

  @override
  Future<void> write(String key, String value) async {
    _data[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    _data.remove(key);
  }
}

/// 写入挂起的偏好仓库：模拟保存操作跨越宿主身份切换。
class DelayedWritePrefStore implements FeedbackServerPrefStore {
  final Completer<void> writeGate = Completer<void>();
  final Map<String, String> data = <String, String>{};
  String? pendingKey;
  String? pendingValue;

  void completeWrite() => writeGate.complete();

  @override
  Future<String?> read(String key) async => data[key];

  @override
  Future<void> write(String key, String value) async {
    pendingKey = key;
    pendingValue = value;
    await writeGate.future;
    data[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    await writeGate.future;
    data.remove(key);
  }
}

/// 每次写入独立放行：验证同一偏好键不会并行落盘造成旧值回写。
class OrderedWritePrefStore implements FeedbackServerPrefStore {
  final Map<String, String> data = <String, String>{};
  final List<Completer<void>> gates = <Completer<void>>[];
  final List<String> pendingValues = <String>[];

  void completeWrite(int index) => gates[index].complete();

  @override
  Future<String?> read(String key) async => data[key];

  @override
  Future<void> write(String key, String value) async {
    final Completer<void> gate = Completer<void>();
    gates.add(gate);
    pendingValues.add(value);
    await gate.future;
    data[key] = value;
  }

  @override
  Future<void> delete(String key) async {}
}

/// 写入必然失败的偏好仓库：模拟安全存储不可用（仅本次生效路径）。
class FailingPrefStore implements FeedbackServerPrefStore {
  final Map<String, String> _data = <String, String>{};

  /// 写 / 删调用次数。
  int writeAttempts = 0;

  @override
  Future<String?> read(String key) async => _data[key];

  @override
  Future<void> write(String key, String value) async {
    writeAttempts++;
    throw StateError('storage unavailable');
  }

  @override
  Future<void> delete(String key) async {
    writeAttempts++;
    throw StateError('storage unavailable');
  }
}

/// 按服务身份派生的内存令牌仓库表：验证不同服务读到各自槽位。
class PerIdentityTokenStores {
  final Map<String, MemoryTokenStore> stores = <String, MemoryTokenStore>{};

  FeedbackTokenStore call(FeedbackConfig config) => stores.putIfAbsent(
        feedbackTokenStorageKey(config),
        () => MemoryTokenStore(),
      );

  MemoryTokenStore forConfig(FeedbackConfig config) => stores.putIfAbsent(
      feedbackTokenStorageKey(config), () => MemoryTokenStore());
}

void main() {
  const Key input = Key('feedback-input');
  const Key settingsGear = Key('feedback-settings');
  const Key serverInput = Key('feedback-server-input');
  const Key serverSave = Key('feedback-server-save');
  const Key serverDefault = Key('feedback-server-default');
  const Key confirmOk = Key('feedback-server-confirm-ok');
  const Key confirmCancel = Key('feedback-server-confirm-cancel');

  FeedbackConfig cfgA([String appId = 'com.example.app']) =>
      FeedbackConfig('https://a.test', appId);

  group('normalizeServerBase', () {
    test('规范化：去空白 / 去末尾斜杠 / 保留路径前缀 / 去默认端口', () {
      expect(
          normalizeServerBase('  https://FB.test/  ').base, 'https://fb.test');
      expect(
          normalizeServerBase('https://fb.test:443/').base, 'https://fb.test');
      expect(normalizeServerBase('http://fb.test:80').base, 'http://fb.test');
      expect(normalizeServerBase('http://fb.test:8787/api/').base,
          'http://fb.test:8787/api');
      expect(normalizeServerBase('https://fb.test:8443/x/').base,
          'https://fb.test:8443/x');
    });

    test('拒绝：缺少主机 / 非 http(s) / 内嵌凭据 / 查询 / 片段', () {
      expect(normalizeServerBase('').ok, isFalse);
      expect(normalizeServerBase('ftp://fb.test').ok, isFalse);
      expect(normalizeServerBase('https://').ok, isFalse);
      expect(normalizeServerBase('notaurl').ok, isFalse);
      expect(normalizeServerBase('https://u:p@fb.test').ok, isFalse);
      expect(normalizeServerBase('https://fb.test?x=1').ok, isFalse);
      expect(normalizeServerBase('https://fb.test#frag').ok, isFalse);
    });

    test('HTTPS 页面拒绝 HTTP 覆盖（混合内容）', () {
      expect(
          normalizeServerBase('http://fb.test', pageIsHttps: true).ok, isFalse);
      expect(
          normalizeServerBase('https://fb.test', pageIsHttps: true).ok, isTrue);
      // 非 HTTPS 页面（原生）不限制。
      expect(normalizeServerBase('http://fb.test').ok, isTrue);
    });
  });

  group('serverOverrideStorageKey', () {
    test('按 appId 与规范化默认地址隔离；确定性可复现', () {
      final String k1 = serverOverrideStorageKey(
          appId: 'com.example.app', defaultApiBase: 'https://a.test/');
      final String k2 = serverOverrideStorageKey(
          appId: 'com.example.app', defaultApiBase: 'https://a.test');
      expect(k1, k2); // 默认地址规范化后一致（末尾斜杠无关）
      final String k3 = serverOverrideStorageKey(
          appId: 'com.example.app', defaultApiBase: 'https://b.test');
      expect(k3, isNot(k1));
      final String k4 = serverOverrideStorageKey(
          appId: 'com.example.other', defaultApiBase: 'https://a.test');
      expect(k4, isNot(k1));
      expect(k1, startsWith('feedback_widget.server_override.'));
      // 平台安全字符集（Keychain / localStorage 通用）。
      expect(k1, matches(RegExp(r'^[A-Za-z0-9._-]+$')));
    });
  });

  group('面板服务器设置', () {
    testWidgets('设置视图：地址输入 / 当前有效地址 / 保存 / 恢复默认（未登录可进入）', (tester) async {
      final PanelServer server = PanelServer();
      await pumpPanel(
        tester,
        server: server,
        tokenStore: MemoryTokenStore(),
      );
      expect(find.byKey(input), findsOneWidget); // 未登录撰写视图
      await tester.tap(find.byKey(settingsGear));
      await tester.pump();
      expect(find.byKey(serverInput), findsOneWidget);
      expect(find.byKey(serverSave), findsOneWidget);
      expect(find.byKey(serverDefault), findsOneWidget);
      expect(find.textContaining('https://svc.test'), findsWidgets);
      // 返回主视图。
      await tester.tap(find.byKey(const Key('feedback-settings-back')));
      await tester.pump();
      expect(find.byKey(input), findsOneWidget);
      await teardownPanel(tester);
    });

    testWidgets('非法地址显示校验错误，不发出请求', (tester) async {
      final PanelServer server = PanelServer();
      await pumpPanel(
        tester,
        server: server,
        tokenStore: MemoryTokenStore(),
      );
      await tester.tap(find.byKey(settingsGear));
      await tester.pump();
      await tester.enterText(find.byKey(serverInput), 'https://u:p@b.test');
      await tester.tap(find.byKey(serverSave));
      await tester.pump();
      expect(find.textContaining('不能包含用户名或密码'), findsOneWidget);
      expect(server.requests, isEmpty); // 校验失败不探测不切换
      await teardownPanel(tester);
    });

    testWidgets('保存自定义地址：生效 + 持久化 + 探测 /healthz 提示连通', (tester) async {
      final PanelServer serverA = PanelServer();
      final PanelServer serverB = PanelServer();
      serverB.respond('GET /healthz', {'ok': true});
      final MemoryServerPrefStore prefs = MemoryServerPrefStore();
      await tester.binding.setSurfaceSize(const Size(1000, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(MaterialApp(
        home: FeedbackPanel(
          config: cfgA(),
          tokenStore: MemoryTokenStore(),
          serverPrefStore: prefs,
          httpClient: routedClient(
              <String, PanelServer>{'a.test': serverA, 'b.test': serverB}),
        ),
      ));
      await tester.pump();
      await tester.pump();

      await tester.tap(find.byKey(settingsGear));
      await tester.pump();
      await tester.enterText(find.byKey(serverInput), 'https://b.test/');
      await tester.tap(find.byKey(serverSave));
      await tester.pump();
      await tester.pump();

      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
      expect(panel.effectiveApiBase, 'https://b.test');
      expect(panel.serverOverride, 'https://b.test');
      // 已持久化到正确槽位。
      final String key = serverOverrideStorageKey(
          appId: 'com.example.app', defaultApiBase: 'https://a.test');
      expect(await prefs.read(key), 'https://b.test');
      // 保存后探测 B 的 /healthz 并提示连通。
      expect(serverB.count('GET /healthz'), 1);
      expect(find.textContaining('服务连接正常'), findsOneWidget);
      await teardownPanel(tester);
    });

    testWidgets('持久化失败：本次会话生效并提示「仅本次生效」', (tester) async {
      final PanelServer serverA = PanelServer();
      final PanelServer serverB = PanelServer();
      serverB.respond('GET /healthz', {'ok': true});
      final FailingPrefStore prefs = FailingPrefStore();
      await tester.binding.setSurfaceSize(const Size(1000, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(MaterialApp(
        home: FeedbackPanel(
          config: cfgA(),
          tokenStore: MemoryTokenStore(),
          serverPrefStore: prefs,
          httpClient: routedClient(
              <String, PanelServer>{'a.test': serverA, 'b.test': serverB}),
        ),
      ));
      await tester.pump();
      await tester.pump();

      await tester.tap(find.byKey(settingsGear));
      await tester.pump();
      await tester.enterText(find.byKey(serverInput), 'https://b.test');
      await tester.tap(find.byKey(serverSave));
      await tester.pump();
      await tester.pump();

      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
      expect(panel.effectiveApiBase, 'https://b.test'); // 本次会话生效
      expect(prefs.writeAttempts, greaterThan(0));
      expect(find.textContaining('仅本次生效'), findsOneWidget);
      await teardownPanel(tester);
    });

    testWidgets('重启恢复：保存的覆盖在下次挂载时生效，请求直达覆盖服务', (tester) async {
      final PanelServer serverA = PanelServer();
      final PanelServer serverB = PanelServer();
      serverA.respond('GET /api/auth/session', sessionJson(quotaJson()));
      serverB.respond('GET /api/auth/session', sessionJson(quotaJson()));
      final MemoryServerPrefStore prefs = MemoryServerPrefStore();
      final String key = serverOverrideStorageKey(
          appId: 'com.example.app', defaultApiBase: 'https://a.test');
      await prefs.write(key, 'https://b.test');
      final PerIdentityTokenStores tokenStores = PerIdentityTokenStores();
      tokenStores.forConfig(cfgA()); // A 槽位（留空）
      await tokenStores
          .forConfig(cfgA().copyWith(apiBase: 'https://b.test'))
          .write('token-b'); // B 已有登录

      await tester.binding.setSurfaceSize(const Size(1000, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(MaterialApp(
        home: FeedbackPanel(
          config: cfgA(),
          tokenStoreFactory: tokenStores.call,
          serverPrefStore: prefs,
          httpClient: routedClient(
              <String, PanelServer>{'a.test': serverA, 'b.test': serverB}),
        ),
      ));
      await tester.pump();
      await tester.pump();
      await tester.pump();

      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
      expect(panel.effectiveApiBase, 'https://b.test');
      // 恢复的是 B 身份自己的令牌：session 请求发往 B 且带 token-b。
      expect(serverB.count('GET /api/auth/session'), 1);
      expect(
        serverB.lastMatching('GET /api/auth/session').headers['authorization'],
        'Bearer token-b',
      );
      expect(serverA.count('GET /api/auth/session'), 0); // A 收不到 B 的会话
      // 已按 B 令牌恢复登录态：撰写视图显示账号额度行。
      expect(find.byKey(const Key('feedback-quota')), findsOneWidget);
      await teardownPanel(tester);
    });

    testWidgets('有草稿时异址保存需确认；取消保留草稿', (tester) async {
      final PanelServer serverA = PanelServer();
      final PanelServer serverB = PanelServer();
      serverB.respond('GET /healthz', {'ok': true});
      final MemoryServerPrefStore prefs = MemoryServerPrefStore();
      await tester.binding.setSurfaceSize(const Size(1000, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(MaterialApp(
        home: FeedbackPanel(
          config: cfgA(),
          tokenStore: MemoryTokenStore(),
          serverPrefStore: prefs,
          httpClient: routedClient(
              <String, PanelServer>{'a.test': serverA, 'b.test': serverB}),
        ),
      ));
      await tester.pump();
      await tester.pump();
      await tester.enterText(find.byKey(input), '写到一半的草稿');
      await tester.pump();

      await tester.tap(find.byKey(settingsGear));
      await tester.pump();
      await tester.enterText(find.byKey(serverInput), 'https://b.test');
      await tester.tap(find.byKey(serverSave));
      await tester.pump();
      // 确认框出现：说明草稿将被清空。
      expect(find.byKey(const Key('feedback-server-confirm')), findsOneWidget);
      await tester.tap(find.byKey(confirmCancel));
      await tester.pump();
      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
      expect(panel.effectiveApiBase, 'https://a.test'); // 未切换
      expect(panel.hasDraft, isTrue); // 草稿保留
      expect(serverB.requests, isEmpty);
      await teardownPanel(tester);
    });

    testWidgets('确认切换：清空草稿 / 截图 / 日志 / 任务态并改用新地址', (tester) async {
      final PanelServer serverA = PanelServer();
      final PanelServer serverB = PanelServer();
      serverB.respond('GET /healthz', {'ok': true});
      final MemoryServerPrefStore prefs = MemoryServerPrefStore();
      final Uint8List png = base64Decode(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
      await tester.binding.setSurfaceSize(const Size(1000, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(MaterialApp(
        home: FeedbackPanel(
          config: cfgA(),
          tokenStore: MemoryTokenStore(),
          serverPrefStore: prefs,
          httpClient: routedClient(
              <String, PanelServer>{'a.test': serverA, 'b.test': serverB}),
        ),
      ));
      await tester.pump();
      await tester.pump();
      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
      await tester.enterText(find.byKey(input), '草稿');
      panel.setScreenshot(png, const FeedbackCaptureInfo(capturedAt: 't'));
      panel.addLog(FeedbackLogFile(
          filename: 'a.log',
          bytes: Uint8List.fromList(utf8.encode('log')),
          source: 'manual'));
      await tester.pump();

      await tester.tap(find.byKey(settingsGear));
      await tester.pump();
      await tester.enterText(find.byKey(serverInput), 'https://b.test');
      await tester.tap(find.byKey(serverSave));
      await tester.pump();
      await tester.tap(find.byKey(confirmOk));
      await tester.pump();
      await tester.pump();

      expect(panel.effectiveApiBase, 'https://b.test');
      expect(panel.hasDraft, isFalse);
      expect(panel.hasScreenshot, isFalse);
      expect(panel.hasLogs, isFalse);
      await teardownPanel(tester);
    });

    testWidgets('相同规范化地址保存：不确认、不重置、只持久化', (tester) async {
      final PanelServer serverA = PanelServer();
      serverA.respond('GET /healthz', {'ok': true});
      await tester.binding.setSurfaceSize(const Size(1000, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(MaterialApp(
        home: FeedbackPanel(
          config: cfgA(),
          tokenStore: MemoryTokenStore(),
          serverPrefStore: MemoryServerPrefStore(),
          httpClient: routedClient(<String, PanelServer>{'a.test': serverA}),
        ),
      ));
      await tester.pump();
      await tester.pump();
      await tester.enterText(find.byKey(input), '草稿不能被清');
      await tester.pump();

      await tester.tap(find.byKey(settingsGear));
      await tester.pump();
      // 带末尾斜杠与大写 host —— 规范化后等于默认地址。
      await tester.enterText(find.byKey(serverInput), ' https://A.test/ ');
      await tester.tap(find.byKey(serverSave));
      await tester.pump();
      await tester.pump();

      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
      expect(find.byKey(const Key('feedback-server-confirm')), findsNothing);
      expect(panel.hasDraft, isTrue); // 草稿保留
      expect(panel.serverOverride, isNull); // 同默认地址 → 不产生覆盖
      expect(find.textContaining('已保存'), findsWidgets);
      await teardownPanel(tester);
    });

    testWidgets('恢复默认：删除覆盖并切回宿主默认地址', (tester) async {
      final PanelServer serverA = PanelServer();
      serverA.respond('GET /healthz', {'ok': true});
      final MemoryServerPrefStore prefs = MemoryServerPrefStore();
      final String key = serverOverrideStorageKey(
          appId: 'com.example.app', defaultApiBase: 'https://a.test');
      await prefs.write(key, 'https://b.test');
      await tester.binding.setSurfaceSize(const Size(1000, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(MaterialApp(
        home: FeedbackPanel(
          config: cfgA(),
          tokenStore: MemoryTokenStore(),
          serverPrefStore: prefs,
          httpClient: routedClient(<String, PanelServer>{'a.test': serverA}),
        ),
      ));
      await tester.pump();
      await tester.pump();
      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
      expect(panel.effectiveApiBase, 'https://b.test'); // 覆盖已加载

      await tester.tap(find.byKey(settingsGear));
      await tester.pump();
      await tester.tap(find.byKey(serverDefault));
      await tester.pump();
      await tester.pump();

      expect(panel.effectiveApiBase, 'https://a.test');
      expect(panel.serverOverride, isNull);
      expect(await prefs.read(key), isNull); // 覆盖键已删除
      await teardownPanel(tester);
    });

    testWidgets('偏好加载完成前不启动依赖服务器的请求', (tester) async {
      final PanelServer serverA = PanelServer();
      serverA.respond('GET /api/auth/session', sessionJson(quotaJson()));
      final DelayedPrefStore prefs = DelayedPrefStore();
      final PerIdentityTokenStores tokenStores = PerIdentityTokenStores();
      tokenStores.forConfig(cfgA()).write('token-a'); // 默认身份已登录
      await tester.binding.setSurfaceSize(const Size(1000, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(MaterialApp(
        home: FeedbackPanel(
          config: cfgA(),
          tokenStoreFactory: tokenStores.call,
          serverPrefStore: prefs,
          httpClient: routedClient(<String, PanelServer>{'a.test': serverA}),
        ),
      ));
      await tester.pump();
      await tester.pump();
      // 偏好读取仍挂起：任何依赖服务器的请求都不得发出。
      expect(serverA.requests, isEmpty);
      expect(find.byKey(input), findsNothing); // 加载占位

      prefs.completeRead(null);
      await tester.pump();
      await tester.pump();
      // 就绪后才恢复会话（token-a 生效 → session 请求发往 A）。
      expect(serverA.count('GET /api/auth/session'), 1);
      expect(find.byKey(input), findsOneWidget);
      await teardownPanel(tester);
    });

    testWidgets('挂起的保存跨越宿主身份变化后不得覆盖新身份', (tester) async {
      final DelayedWritePrefStore prefs = DelayedWritePrefStore();
      final PanelServer serverA = PanelServer();
      final PanelServer serverB = PanelServer();
      await tester.binding.setSurfaceSize(const Size(1000, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(MaterialApp(
        home: FeedbackPanel(
          config: cfgA(),
          tokenStore: MemoryTokenStore(),
          serverPrefStore: prefs,
          httpClient: routedClient(
              <String, PanelServer>{'a.test': serverA, 'b.test': serverB}),
        ),
      ));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(settingsGear));
      await tester.pump();
      await tester.enterText(find.byKey(serverInput), 'https://b.test');
      await tester.tap(find.byKey(serverSave));
      await tester.pump();
      expect(prefs.pendingValue, 'https://b.test');

      // 宿主同时切换 appId：旧保存仍在写入旧槽位，但不得应用到新面板。
      await tester.pumpWidget(MaterialApp(
        home: FeedbackPanel(
          config: cfgA('com.example.new'),
          tokenStore: MemoryTokenStore(),
          serverPrefStore: prefs,
          httpClient: routedClient(
              <String, PanelServer>{'a.test': serverA, 'b.test': serverB}),
        ),
      ));
      await tester.pump();
      prefs.completeWrite();
      await tester.pump();
      await tester.pump();
      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
      expect(panel.effectiveApiBase, 'https://a.test');
      expect(panel.serverOverride, isNull);
      await teardownPanel(tester);
    });

    testWidgets('同一偏好键的连续保存按顺序落盘', (tester) async {
      final OrderedWritePrefStore prefs = OrderedWritePrefStore();
      final PanelServer server = PanelServer();
      await tester.binding.setSurfaceSize(const Size(1000, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(MaterialApp(
        home: FeedbackPanel(
          config: cfgA(),
          tokenStore: MemoryTokenStore(),
          serverPrefStore: prefs,
          httpClient: routedClient(<String, PanelServer>{'a.test': server}),
        ),
      ));
      await tester.pump();
      await tester.pump();

      await tester.tap(find.byKey(settingsGear));
      await tester.pump();
      await tester.enterText(find.byKey(serverInput), 'https://b.test');
      await tester.tap(find.byKey(serverSave));
      await tester.pump();
      expect(prefs.pendingValues, <String>['https://b.test']);

      // 关闭会使第一笔操作失效，但不应让第二笔绕过同键队列。
      await tester.tap(find.byKey(const Key('feedback-settings-back')));
      await tester.pump();
      await tester.tap(find.byKey(settingsGear));
      await tester.pump();
      await tester.enterText(find.byKey(serverInput), 'https://c.test');
      await tester.tap(find.byKey(serverSave));
      await tester.pump();
      expect(prefs.pendingValues, <String>['https://b.test']);

      prefs.completeWrite(0);
      await tester.pump();
      await tester.pump();
      expect(prefs.pendingValues, <String>['https://b.test', 'https://c.test']);
      prefs.completeWrite(1);
      await tester.pump();
      await tester.pump();
      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
      expect(panel.effectiveApiBase, 'https://c.test');
      expect(prefs.data.values, contains('https://c.test'));
      await teardownPanel(tester);
    });

    testWidgets('旧服务迟到的提交结果不得影响新身份状态', (tester) async {
      final PanelServer serverA = PanelServer();
      final PanelServer serverB = PanelServer();
      serverB.respond('GET /healthz', {'ok': true});
      // A 的提交响应挂起（模拟慢服务）。
      final Completer<http.Response> submitGate = Completer<http.Response>();
      serverA.on('POST /api/feedback', (request) => submitGate.future);
      serverA.respond('GET /api/auth/session', sessionJson(quotaJson()));
      final MemoryServerPrefStore prefs = MemoryServerPrefStore();
      final PerIdentityTokenStores tokenStores = PerIdentityTokenStores();
      tokenStores.forConfig(cfgA()).write('token-a');
      await tester.binding.setSurfaceSize(const Size(1000, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(MaterialApp(
        home: FeedbackPanel(
          config: cfgA(),
          tokenStoreFactory: tokenStores.call,
          serverPrefStore: prefs,
          httpClient: routedClient(
              <String, PanelServer>{'a.test': serverA, 'b.test': serverB}),
        ),
      ));
      await tester.pump();
      await tester.pump();
      await tester.pump(); // session 恢复完成
      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
      expect(find.byKey(const Key('feedback-quota')), findsOneWidget);

      await tester.enterText(find.byKey(input), '发往 A 的反馈');
      await tester.pump(); // 让提交按钮拿到新草稿的启用态
      await tester.tap(find.byKey(const Key('feedback-submit')));
      await tester.pump();
      expect(serverA.count('POST /api/feedback'), 1); // 提交在途

      // 提交结果未确认时切换：确认框说明旧服务器可能已接收。
      await tester.tap(find.byKey(settingsGear));
      await tester.pump();
      await tester.enterText(find.byKey(serverInput), 'https://b.test');
      await tester.tap(find.byKey(serverSave));
      await tester.pump();
      expect(find.textContaining('旧服务器可能已接收'), findsOneWidget);
      await tester.tap(find.byKey(confirmOk));
      await tester.pump();
      await tester.pump();

      expect(panel.effectiveApiBase, 'https://b.test');
      expect(panel.hasDraft, isFalse);
      expect(panel.stage, FeedbackStage.compose);

      // A 的迟到结果到达：不得进入任务态 / 不得自动向 B 重发。
      submitGate.complete(
          jsonResponse({'feedbackId': 'f-a', 'status': 'received'}, 201));
      await tester.pump();
      await tester.pump();
      expect(panel.stage, FeedbackStage.compose);
      expect(serverB.count('POST /api/feedback'), 0);
      await teardownPanel(tester);
    });

    testWidgets('切换后新服务的登录只写入新身份槽位', (tester) async {
      final PanelServer serverA = PanelServer();
      final PanelServer serverB = PanelServer();
      serverB.respond('GET /healthz', {'ok': true});
      serverB.respond('POST /api/auth/login', <String, Object?>{
        'ok': true,
        'token': 'token-b',
        'expiresAt': '2030-01-01T00:00:00Z',
        'user': userJson(),
        'quota': quotaJson(),
      });
      serverB.respond('POST /api/feedback',
          {'feedbackId': 'f-b', 'status': 'received'}, 201);
      final MemoryServerPrefStore prefs = MemoryServerPrefStore();
      final PerIdentityTokenStores tokenStores = PerIdentityTokenStores();
      tokenStores.forConfig(cfgA()).write('token-a'); // A 已登录
      serverA.respond('GET /api/auth/session', sessionJson(quotaJson()));
      serverB.respond('GET /api/auth/session', sessionJson(quotaJson()));
      await tester.binding.setSurfaceSize(const Size(1000, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(MaterialApp(
        home: FeedbackPanel(
          config: cfgA(),
          tokenStoreFactory: tokenStores.call,
          serverPrefStore: prefs,
          httpClient: routedClient(
              <String, PanelServer>{'a.test': serverA, 'b.test': serverB}),
        ),
      ));
      await tester.pump();
      await tester.pump();
      await tester.pump();

      // 切到 B（无草稿无需确认）。
      await tester.tap(find.byKey(settingsGear));
      await tester.pump();
      await tester.enterText(find.byKey(serverInput), 'https://b.test');
      await tester.tap(find.byKey(serverSave));
      await tester.pump();
      await tester.pump();
      // B 槽位无令牌 → 未登录态；期间不得有携带 A 令牌的请求发往 B。
      for (final http.BaseRequest req in serverB.requests) {
        expect(req.headers['authorization'], isNot('Bearer token-a'),
            reason: '旧身份令牌绝不发往新地址: ${req.url}');
      }
      // 返回撰写视图 → 走登录并提交流程 → B 槽位拿到 token-b。
      await tester.tap(find.byKey(const Key('feedback-settings-back')));
      await tester.pump();
      await tester.enterText(find.byKey(input), '发到 B');
      await tester.pump(); // 让提交按钮拿到新草稿的启用态
      await tester.tap(find.byKey(const Key('feedback-submit')));
      await tester.pump();
      await tester.enterText(
          find.byKey(const Key('feedback-login-username')), 'admin');
      await tester.enterText(
          find.byKey(const Key('feedback-login-password')), 'pw');
      await tester.tap(find.byKey(const Key('feedback-login-submit')));
      await tester.pump();
      await tester.pump();

      expect(
          await tokenStores
              .forConfig(cfgA().copyWith(apiBase: 'https://b.test'))
              .read(),
          'token-b');
      expect(await tokenStores.forConfig(cfgA()).read(), 'token-a'); // A 凭据保留
      // 发往 B 的提交携带 B 令牌。
      expect(serverB.count('POST /api/feedback'), 1);
      expect(
        serverB.lastMatching('POST /api/feedback').headers['authorization'],
        'Bearer token-b',
      );
      await teardownPanel(tester);
    });
  });

  group('FeedbackWidget 集成', () {
    testWidgets('effectiveApiBase 透传到控制器：覆盖保存后控制器读到新地址', (tester) async {
      final PanelServer serverA = PanelServer();
      final PanelServer serverB = PanelServer();
      serverB.respond('GET /healthz', {'ok': true});
      final FeedbackController controller = FeedbackController();
      addTearDown(controller.dispose);
      final MemoryServerPrefStore prefs = MemoryServerPrefStore();
      await tester.binding.setSurfaceSize(const Size(1000, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(MaterialApp(
        home: FeedbackWidget(
          config: cfgA(),
          controller: controller,
          tokenStore: MemoryTokenStore(),
          serverPrefStore: prefs,
          httpClient: routedClient(
              <String, PanelServer>{'a.test': serverA, 'b.test': serverB}),
          child: const SizedBox.expand(),
        ),
      ));
      await tester.pump();
      controller.open();
      await tester.pump();
      await tester.pump();
      await tester.pump();
      // 初始上报：控制器读到默认地址。
      expect(controller.effectiveApiBase, 'https://a.test');

      await tester.tap(find.byKey(settingsGear));
      await tester.pump();
      await tester.enterText(find.byKey(serverInput), 'https://b.test');
      await tester.tap(find.byKey(serverSave));
      await tester.pump();
      await tester.pump();
      await tester.pump();

      expect(controller.effectiveApiBase, 'https://b.test');
      expect(serverB.count('GET /healthz'), 1);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump(const Duration(seconds: 30));
    });
  });
}
