import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'panel_harness.dart';

/// T1 补修回归（Flutter 面板层）：
/// A. 登录期间关闭面板 / 重新打开：迟到的登录结果既不写令牌也不自动提交，
///    重新打开后可以继续编辑并重新登录；
/// B. 额度刷新与生命周期：关闭不轮询、重新打开立即查询、额度用尽 30 秒轮询、
///    跨 resetAt 只触发一次有效刷新、旧额度查询迟到不覆盖新次数。
void main() {
  const input = Key('feedback-input');
  const submit = Key('feedback-submit');
  const loginUser = Key('feedback-login-username');
  const loginPassword = Key('feedback-login-password');
  const loginSubmit = Key('feedback-login-submit');

  late PanelServer server;

  setUp(() {
    server = PanelServer();
  });

  Future<void> openLoginForm(WidgetTester tester, String text) async {
    await tester.enterText(find.byKey(input), text);
    await tester.pump();
    await tester.tap(find.byKey(submit));
    await tester.pump();
    expect(find.byKey(loginUser), findsOneWidget);
  }

  Future<void> fillCredentials(WidgetTester tester) async {
    await tester.enterText(find.byKey(loginUser), 'admin');
    await tester.enterText(find.byKey(loginPassword), 's3cret-pw');
    await tester.tap(find.byKey(loginSubmit));
    await tester.pump();
  }

  group('T1-A 登录操作失效', () {
    testWidgets('登录期间关闭面板：迟到的登录结果不写令牌、不自动提交，草稿保留', (tester) async {
      final store = RecordingTokenStore();
      final login = Completer<http.Response>();
      server.on('POST /api/auth/login', (request) => login.future);
      server.respond('GET /api/auth/session', sessionJson(quotaJson()));
      server.respond('POST /api/feedback',
          <String, Object?>{'feedbackId': 'f1', 'status': 'received'}, 201);

      await pumpPanel(tester, server: server, tokenStore: store, visible: true);
      await openLoginForm(tester, '登录期间离开');
      await fillCredentials(tester);

      // 用户关闭面板（真实开关状态由宿主传入）。
      await pumpPanel(tester, server: server, tokenStore: store, visible: false);
      await tester.pump();

      login.complete(jsonResponse(<String, Object?>{
        'ok': true,
        'token': 'late-token',
        'expiresAt': '2030-01-01T00:00:00Z',
        'user': userJson(),
        'quota': quotaJson(),
      }));
      await tester.pump();
      await tester.pump();

      expect(store.writes, 0); // 失效登录不得调用令牌写入
      expect(store.value, isNull);
      expect(server.count('POST /api/feedback'), 0); // 不得自动提交
      expect(
        tester.widget<TextField>(find.byKey(input)).controller!.text,
        '登录期间离开',
      );
      await teardownPanel(tester);
    });

    testWidgets('重新打开面板：可以继续编辑并重新登录，新登录只提交一次', (tester) async {
      final store = RecordingTokenStore();
      final login = Completer<http.Response>();
      server.on('POST /api/auth/login', (request) => login.future);
      // 第二次登录（重新打开之后）使用常驻的固定响应。
      server.on('POST /api/auth/login',
          (request) async => jsonResponse(<String, Object?>{
                'ok': true,
                'token': 'fresh-token',
                'expiresAt': '2030-01-01T00:00:00Z',
                'user': userJson(),
                'quota': quotaJson(),
              }));
      server.respond('GET /api/auth/session', sessionJson(quotaJson()));
      server.respond('POST /api/feedback',
          <String, Object?>{'feedbackId': 'f1', 'status': 'received'}, 201);

      await pumpPanel(tester, server: server, tokenStore: store, visible: true);
      await openLoginForm(tester, '重新打开继续');
      await fillCredentials(tester);

      await pumpPanel(tester, server: server, tokenStore: store, visible: false);
      await tester.pump();
      login.complete(jsonResponse(<String, Object?>{
        'ok': true,
        'token': 'late-token',
        'expiresAt': '2030-01-01T00:00:00Z',
        'user': userJson(),
        'quota': quotaJson(),
      }));
      await tester.pump();
      await tester.pump();
      expect(store.writes, 0);

      // 重新打开：草稿仍在，可重新发起登录。
      await pumpPanel(tester, server: server, tokenStore: store, visible: true);
      await tester.pump();
      expect(
        tester.widget<TextField>(find.byKey(input)).controller!.text,
        '重新打开继续',
      );

      await tester.tap(find.byKey(submit));
      await tester.pump();
      await fillCredentials(tester);
      await tester.pump();
      await tester.pump();

      expect(store.value, 'fresh-token');
      expect(server.count('POST /api/feedback'), 1); // 新登录只提交一次
      await teardownPanel(tester);
    });

    testWidgets('登录期间取消：迟到的成功不写令牌', (tester) async {
      final store = RecordingTokenStore();
      final login = Completer<http.Response>();
      server.on('POST /api/auth/login', (request) => login.future);
      server.respond('POST /api/feedback',
          <String, Object?>{'feedbackId': 'f1', 'status': 'received'}, 201);

      await pumpPanel(tester, server: server, tokenStore: store, visible: true);
      await openLoginForm(tester, '取消后不写');
      await fillCredentials(tester);

      await tester.tap(find.byKey(const Key('feedback-login-cancel')));
      await tester.pump();

      login.complete(jsonResponse(<String, Object?>{
        'ok': true,
        'token': 'late-token',
        'expiresAt': '2030-01-01T00:00:00Z',
        'user': userJson(),
        'quota': quotaJson(),
      }));
      await tester.pump();
      await tester.pump();

      expect(store.writes, 0);
      expect(server.count('POST /api/feedback'), 0);
      await teardownPanel(tester);
    });
  });

  group('T1-B 额度刷新与生命周期', () {
    testWidgets('重新打开面板：实际调用 GET /api/auth/session 刷新额度', (tester) async {
      final store = RecordingTokenStore('tok');
      server.respond('GET /api/auth/session', sessionJson(quotaJson()));

      await pumpPanel(tester, server: server, tokenStore: store, visible: true);
      await tester.pump();
      await tester.pump();
      await pumpPanel(tester, server: server, tokenStore: store, visible: false);
      await tester.pump();
      server.requests.clear();

      await pumpPanel(tester, server: server, tokenStore: store, visible: true);
      await tester.pump();
      await tester.pump();
      expect(server.count('GET /api/auth/session'), 1); // 真的发起了刷新
      expect(find.textContaining('今日剩余 3 次'), findsOneWidget);
      await teardownPanel(tester);
    });

    testWidgets('额度用尽：30 秒后刷新，后台调高额度后无需重开面板即可恢复提交', (tester) async {
      final store = RecordingTokenStore('tok');
      int calls = 0;
      server.on('GET /api/auth/session', (request) async {
        calls++;
        // 后台把额度从 3 调到 5、当天已用 3：下一次刷新返回剩余 2。
        return jsonResponse(sessionJson(calls == 1
            ? quotaJson(dailyLimit: 3, used: 3, remaining: 0)
            : quotaJson(dailyLimit: 5, used: 3, remaining: 2)));
      });
      server.respond('POST /api/feedback',
          <String, Object?>{'feedbackId': 'f1', 'status': 'received'}, 201);

      await pumpPanel(tester, server: server, tokenStore: store, visible: true);
      await tester.pump();
      await tester.pump();
      expect(calls, 1);
      await tester.enterText(find.byKey(input), '额度恢复后可提交');
      await tester.pump();
      expect(find.byKey(const Key('feedback-quota-blocked')), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byKey(submit)).onPressed, isNull);

      await tester.pump(const Duration(seconds: 30));
      await tester.pump();
      await tester.pump();

      expect(calls, 2);
      expect(find.textContaining('今日剩余 2 次'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byKey(submit)).onPressed, isNotNull);

      // 恢复后回到 resetAt 单次定时：不产生周期轮询。
      await tester.pump(const Duration(seconds: 120));
      await tester.pump();
      expect(calls, 2);
      await teardownPanel(tester);
    });

    testWidgets('剩余 0 跨过 resetAt：只触发一次有效刷新并恢复按钮', (tester) async {
      final store = RecordingTokenStore('tok');
      final String resetAt =
          DateTime.now().add(const Duration(seconds: 20)).toUtc().toIso8601String();
      int calls = 0;
      server.on('GET /api/auth/session', (request) async {
        calls++;
        return jsonResponse(sessionJson(calls == 1
            ? quotaJson(used: 3, remaining: 0, resetAt: resetAt)
            : quotaJson(
                used: 0,
                remaining: 3,
                resetAt: DateTime.now()
                    .add(const Duration(days: 1))
                    .toUtc()
                    .toIso8601String())));
      });

      await pumpPanel(tester, server: server, tokenStore: store, visible: true);
      await tester.pump();
      await tester.pump();
      expect(calls, 1);

      await tester.pump(const Duration(seconds: 25)); // 越过 resetAt
      await tester.pump();
      await tester.pump();
      expect(calls, 2); // 只触发一次有效刷新
      expect(find.textContaining('今日剩余 3 次'), findsOneWidget);

      await tester.pump(const Duration(seconds: 300)); // 不自行重置、不紧密循环
      await tester.pump();
      expect(calls, 2);
      await teardownPanel(tester);
    });

    testWidgets('关闭面板或退到后台：不产生额度轮询；重新打开或回到前台立即查询', (tester) async {
      final store = RecordingTokenStore('tok');
      server.respond('GET /api/auth/session',
          sessionJson(quotaJson(used: 3, remaining: 0)));

      await pumpPanel(tester, server: server, tokenStore: store, visible: true);
      await tester.pump();
      await tester.pump();
      expect(server.count('GET /api/auth/session'), 1);

      await pumpPanel(tester, server: server, tokenStore: store, visible: false);
      await tester.pump();
      await tester.pump(const Duration(seconds: 300));
      await tester.pump();
      expect(server.count('GET /api/auth/session'), 1); // 关闭后没有额度轮询

      await pumpPanel(tester, server: server, tokenStore: store, visible: true);
      await tester.pump();
      await tester.pump();
      expect(server.count('GET /api/auth/session'), 2); // 重新打开立即查询

      // 退到后台：按合法顺序转移生命周期状态。
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump();
      await tester.pump(const Duration(seconds: 300));
      await tester.pump();
      expect(server.count('GET /api/auth/session'), 2);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      await tester.pump();
      expect(server.count('GET /api/auth/session'), 3); // 回到前台立即查询
      await teardownPanel(tester);
    });

    testWidgets('旧额度查询迟到：不覆盖提交成功后的剩余次数', (tester) async {
      final store = RecordingTokenStore('tok');
      final pending = Completer<http.Response>();
      server.on('GET /api/auth/session', (request) => pending.future);
      // 提交直接归档：面板回到「已归档」，可从这里返回撰写视图查看额度。
      server.respond(
          'POST /api/feedback',
          <String, Object?>{
            'feedbackId': 'f1',
            'status': 'archived',
            'quota': quotaJson(used: 1, remaining: 2),
          },
          201);

      await pumpPanel(tester, server: server, tokenStore: store, visible: true);
      await tester.pump();
      await tester.pump(); // 额度查询挂起
      expect(server.count('GET /api/auth/session'), 1);

      await tester.enterText(find.byKey(input), '提交后剩余 2');
      await tester.pump();
      await tester.tap(find.byKey(submit));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(const Key('feedback-continue')));
      await tester.pump();
      expect(find.textContaining('今日剩余 2 次'), findsOneWidget);

      // 旧额度查询迟到（返回扣减前的剩余 3）：必须被丢弃。
      pending.complete(jsonResponse(sessionJson(quotaJson(used: 0, remaining: 3))));
      await tester.pump();
      await tester.pump();
      expect(find.textContaining('今日剩余 2 次'), findsOneWidget);
      expect(find.textContaining('今日剩余 3 次'), findsNothing);
      await teardownPanel(tester);
    });

    testWidgets('额度刷新 401：回到需要登录态并停止额度定时查询，草稿保留', (tester) async {
      final store = RecordingTokenStore('tok');
      server.respond(
          'GET /api/auth/session',
          <String, Object?>{
            'error': {'code': 'unauthorized', 'message': '登录已过期'}
          },
          401);

      await pumpPanel(tester, server: server, tokenStore: store, visible: true);
      await tester.pump();
      await tester.pump();
      expect(server.count('GET /api/auth/session'), 1);
      expect(store.clears, 1); // 401 清令牌

      await tester.enterText(find.byKey(input), '过期草稿保留');
      await tester.pump();
      expect(find.byKey(loginUser), findsNothing);
      await tester.tap(find.byKey(submit)); // 回到需要登录态
      await tester.pump();
      expect(find.byKey(loginUser), findsOneWidget);
      expect(
        tester.widget<TextField>(find.byKey(input)).controller!.text,
        '过期草稿保留',
      );

      await tester.pump(const Duration(seconds: 300));
      await tester.pump();
      expect(server.count('GET /api/auth/session'), 1); // 定时任务已停止
      await teardownPanel(tester);
    });

    testWidgets('查询挂起期间关闭再打开：旧结果丢弃，结束后立即补发一次', (tester) async {
      final store = RecordingTokenStore('tok');
      final pending = Completer<http.Response>();
      int calls = 0;
      server.on('GET /api/auth/session', (request) async {
        calls++;
        if (calls == 1) return pending.future; // 旧查询挂起
        return jsonResponse(sessionJson(quotaJson(used: 0, remaining: 5)));
      });

      await pumpPanel(tester, server: server, tokenStore: store, visible: true);
      await tester.pump();
      await tester.pump();
      expect(server.count('GET /api/auth/session'), 1);

      // 旧查询在途时关闭面板，再重新打开：不得并发，只能登记待补发。
      await pumpPanel(tester, server: server, tokenStore: store, visible: false);
      await tester.pump();
      await pumpPanel(tester, server: server, tokenStore: store, visible: true);
      await tester.pump();
      expect(server.count('GET /api/auth/session'), 1);

      // 旧查询返回旧值：必须被丢弃，且立即补发一次（不等到 resetAt）。
      pending.complete(jsonResponse(sessionJson(quotaJson(used: 0, remaining: 3))));
      await tester.pump();
      await tester.pump();
      await tester.pump();
      expect(server.count('GET /api/auth/session'), 2);
      expect(find.textContaining('今日剩余 5 次'), findsOneWidget);
      expect(find.textContaining('今日剩余 3 次'), findsNothing);

      await tester.pump(const Duration(seconds: 300));
      await tester.pump();
      expect(server.count('GET /api/auth/session'), 2); // 补发不重复
      await teardownPanel(tester);
    });

    testWidgets('连续重开与回前台：登记合并为一次补发', (tester) async {
      final store = RecordingTokenStore('tok');
      final pending = Completer<http.Response>();
      int calls = 0;
      server.on('GET /api/auth/session', (request) async {
        calls++;
        if (calls == 1) return pending.future;
        return jsonResponse(sessionJson(quotaJson(used: 0, remaining: 5)));
      });

      await pumpPanel(tester, server: server, tokenStore: store, visible: true);
      await tester.pump();
      await tester.pump();
      expect(server.count('GET /api/auth/session'), 1);

      // 旧查询在途：关闭 → 重开 → 退后台 → 回前台，多次登记只算一次意图。
      await pumpPanel(tester, server: server, tokenStore: store, visible: false);
      await tester.pump();
      await pumpPanel(tester, server: server, tokenStore: store, visible: true);
      await tester.pump();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(server.count('GET /api/auth/session'), 1); // 不并发

      pending.complete(jsonResponse(sessionJson(quotaJson(used: 0, remaining: 3))));
      await tester.pump();
      await tester.pump();
      await tester.pump();
      expect(server.count('GET /api/auth/session'), 2); // 恰好一次补发
      expect(find.textContaining('今日剩余 5 次'), findsOneWidget);

      await tester.pump(const Duration(seconds: 300));
      await tester.pump();
      expect(server.count('GET /api/auth/session'), 2);
      await teardownPanel(tester);
    });

    testWidgets('提交忙碌期间回前台：提交完成后立即补发一次（不停摆）', (tester) async {
      final store = RecordingTokenStore('tok');
      int calls = 0;
      server.on('GET /api/auth/session', (request) async {
        calls++;
        return jsonResponse(sessionJson(quotaJson(
            used: calls <= 1 ? 0 : 1,
            remaining: calls <= 1 ? 3 : 2)));
      });
      final submitRequest = Completer<http.Response>();
      server.on('POST /api/feedback', (request) => submitRequest.future);

      await pumpPanel(tester, server: server, tokenStore: store, visible: true);
      await tester.pump();
      await tester.pump();
      expect(calls, 1);

      // 提交挂起（忙碌）期间退后台再回前台：查询暂缓但意图保留。
      await tester.enterText(find.byKey(input), '忙碌结束补发');
      await tester.pump();
      await tester.tap(find.byKey(submit));
      await tester.pump();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(calls, 1); // 忙碌期间不并发

      // 提交成功：忙碌结束，立即补发一次，拿到服务端最新扣次结果。
      submitRequest.complete(jsonResponse(
          <String, Object?>{
            'feedbackId': 'f1',
            'status': 'archived',
            'quota': quotaJson(used: 1, remaining: 2),
          },
          201));
      await tester.pump();
      await tester.pump();
      await tester.pump();
      expect(calls, 2);
      await tester.tap(find.byKey(const Key('feedback-continue')));
      await tester.pump();
      expect(find.textContaining('今日剩余 2 次'), findsOneWidget);
      await teardownPanel(tester);
    });
  });

  group('T1-A 旧请求 401 不得清除新登录（面板层）', () {
    testWidgets('旧令牌的提交在重登后返回 401：新登录令牌与登录态保留，不退出登录', (tester) async {
      final store = RecordingTokenStore('tok-old');
      final staleSession = Completer<http.Response>();
      final staleSubmit = Completer<http.Response>();
      int sessionCalls = 0;
      int submitCalls = 0;
      server.on('GET /api/auth/session', (request) async {
        sessionCalls++;
        if (sessionCalls == 1) return staleSession.future; // 旧令牌的额度查询挂起
        return jsonResponse(sessionJson(quotaJson()));
      });
      server.on('POST /api/feedback', (request) async {
        submitCalls++;
        if (submitCalls == 1) return staleSubmit.future; // 旧令牌的提交挂起
        return jsonResponse(
            <String, Object?>{'feedbackId': 'f2', 'status': 'received'}, 201);
      });
      server.on('POST /api/auth/login',
          (request) async => jsonResponse(<String, Object?>{
                'ok': true,
                'token': 'fresh-token',
                'expiresAt': '2030-01-01T00:00:00Z',
                'user': userJson(),
                'quota': quotaJson(),
              }));

      await pumpPanel(tester, server: server, tokenStore: store, visible: true);
      await tester.pump();
      await tester.pump(); // 恢复会话（tok-old）+ 额度查询挂起

      // 旧令牌的提交也进入在途。
      await tester.enterText(find.byKey(input), '新登录保护');
      await tester.pump();
      await tester.tap(find.byKey(submit));
      await tester.pump();

      // 第一个 401（额度查询）：令牌确已失效——清除旧令牌、回到需要登录态。
      staleSession.complete(jsonResponse(
          <String, Object?>{
            'error': {'code': 'unauthorized', 'message': '登录已过期'}
          },
          401));
      await tester.pump();
      await tester.pump();
      expect(store.value, isNull);

      // 重新登录：保存新令牌（登录成功后自动续交一次，使用新令牌）。
      await tester.tap(find.byKey(submit));
      await tester.pump();
      await tester.enterText(find.byKey(loginUser), 'admin');
      await tester.enterText(find.byKey(loginPassword), 's3cret-pw');
      await tester.tap(find.byKey(loginSubmit));
      await tester.pump();
      await tester.pump();
      await tester.pump();
      expect(store.value, 'fresh-token');

      // 旧令牌的提交此时返回 401：不得清除新令牌、不得退出登录。
      staleSubmit.complete(jsonResponse(
          <String, Object?>{
            'error': {'code': 'unauthorized', 'message': '登录已过期'}
          },
          401));
      await tester.pump();
      await tester.pump();
      expect(store.value, 'fresh-token');
      expect(store.clears, 1); // 只有第一次真正的会话失效清除过
      expect(find.byKey(loginUser), findsNothing); // 未被踢回登录表单
      await teardownPanel(tester);
    });
  });

  group('T1-C 安全存储写入失败提示', () {
    testWidgets('写入失败：显示存储提示、清空密码、保留草稿、不自动提交', (tester) async {
      final store = FailingWriteTokenStore();
      server.on('POST /api/auth/login',
          (request) async => jsonResponse(<String, Object?>{
                'ok': true,
                'token': 'fresh-token',
                'expiresAt': '2030-01-01T00:00:00Z',
                'user': userJson(),
                'quota': quotaJson(),
              }));
      server.respond('GET /api/auth/session', sessionJson(quotaJson()));
      server.respond('POST /api/feedback',
          <String, Object?>{'feedbackId': 'f1', 'status': 'received'}, 201);

      await pumpPanel(tester, server: server, tokenStore: store, visible: true);
      await openLoginForm(tester, '存储失败草稿');
      await fillCredentials(tester);
      await tester.pump();
      await tester.pump();

      // 服务端登录已成功（write 被调用过），但令牌保存失败：
      // 必须给出存储失败的准确提示，而不是“网络异常”。
      expect(store.writeAttempts, 1);
      expect(find.text('无法保存登录状态，请检查应用的安全存储配置'), findsOneWidget);
      expect(find.textContaining('网络异常'), findsNothing);
      expect(find.byKey(loginUser), findsOneWidget); // 仍在登录表单
      expect(
        tester.widget<TextField>(find.byKey(input)).controller!.text,
        '存储失败草稿',
      ); // 草稿保留
      expect(find.byKey(loginPassword).evaluate().isNotEmpty, isTrue);
      expect(
        tester.widget<TextField>(find.byKey(loginPassword)).controller!.text,
        '',
      ); // 密码清空
      expect(server.count('POST /api/feedback'), 0); // 不自动提交
      await teardownPanel(tester);
    });
  });
}
