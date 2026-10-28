import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'panel_harness.dart';

void main() {
  testWidgets('未登录点击「我的反馈」显示登录引导，点击「前往登录」切回登录表单', (tester) async {
    final PanelServer server = PanelServer();
    server.respond('GET /api/auth/session', {'authenticated': false}, 401);

    await pumpPanel(tester,
        server: server, tokenStore: RecordingTokenStore(null));
    await tester.pumpAndSettle();

    // 点击「我的反馈」Tab
    await tester.tap(find.byKey(const Key('tab-history')));
    await tester.pumpAndSettle();

    expect(find.text('查看反馈历史需要登录'), findsOneWidget);
    expect(find.byKey(const Key('history-login-btn')), findsOneWidget);

    // 点击前往登录
    await tester.tap(find.byKey(const Key('history-login-btn')));
    await tester.pumpAndSettle();

    // 验证切换到了登录表单
    expect(find.byKey(const Key('feedback-login-username')), findsOneWidget);
    expect(find.byKey(const Key('feedback-login-password')), findsOneWidget);

    await teardownPanel(tester);
  });

  testWidgets('已登录进入「我的反馈」拉取列表并展示状态与未读，点击进入对话详情', (tester) async {
    final PanelServer server = PanelServer();
    final RecordingTokenStore tokenStore = RecordingTokenStore('valid-token');
    server.respond('GET /api/auth/session', sessionJson(quotaJson()));
    server.respond('GET /api/feedback/unread-summary', {
      'unreadFeedbacksCount': 1,
      'totalUnreadMessages': 2,
    });
    server.respond('GET /api/feedback/mine', {
      'items': [
        {
          'id': 'fb-201',
          'appId': 'com.example.app',
          'title': '闪退问题',
          'text': '进入设置界面时闪退',
          'status': 'received',
          'issueStatus': 'waiting_user',
          'dialogueVersion': 1,
          'archiveRound': 1,
          'lastActivityAt': DateTime.now().toIso8601String(),
          'createdAt': DateTime.now().toIso8601String(),
          'unread': true,
          'messageCount': 2,
          'latestMessage': {
            'seq': 2,
            'senderType': 'admin',
            'senderName': '技术支持',
            'text': '请问是哪款系统版本？',
            'createdAt': DateTime.now().toIso8601String(),
          },
        }
      ],
      'total': 1,
      'page': 1,
      'limit': 20,
      'unreadTotal': 2,
    });
    server.respond('GET /api/feedback/fb-201/dialogue', {
      'feedback': {
        'id': 'fb-201',
        'appId': 'com.example.app',
        'title': '闪退问题',
        'text': '进入设置界面时闪退',
        'status': 'received',
        'issueStatus': 'waiting_user',
        'dialogueVersion': 1,
        'archiveRound': 1,
        'mgmtState': 'inbox',
        'createdAt': DateTime.now().toIso8601String(),
        'updatedAt': DateTime.now().toIso8601String(),
        'lastActivityAt': DateTime.now().toIso8601String(),
      },
      'messages': [
        {
          'id': 'msg-1',
          'seq': 1,
          'senderType': 'admin',
          'senderId': 'admin-1',
          'senderName': '技术支持',
          'text': '请问是哪款系统版本？',
          'createdAt': DateTime.now().toIso8601String(),
          'attachments': <Map<String, Object?>>[],
        },
      ],
      'lastReadSeq': 0,
    });
    server.respond('POST /api/feedback/fb-201/read', {
      'ok': true,
      'lastReadSeq': 1,
    });

    await pumpPanel(tester, server: server, tokenStore: tokenStore);
    await tester.pumpAndSettle();

    // 点击「我的反馈」Tab
    await tester.tap(find.byKey(const Key('tab-history')));
    await tester.pumpAndSettle();

    // 验证列表展示
    expect(find.text('闪退问题'), findsOneWidget);
    expect(find.text('待补充'), findsOneWidget);
    expect(find.text('未读'), findsOneWidget);
    expect(find.text('管理员: 请问是哪款系统版本？'), findsOneWidget);

    // 点击反馈卡片进入对话详情
    await tester.tap(find.byKey(const Key('feedback-item-fb-201')));
    await tester.pumpAndSettle();

    // 验证展示原话与管理员消息
    expect(find.text('进入设置界面时闪退'), findsOneWidget);
    expect(find.text('请问是哪款系统版本？'), findsOneWidget);

    // 验证调用了已读上报接口
    expect(server.count('POST /api/feedback/fb-201/read'), 1);

    await teardownPanel(tester);
  });

  testWidgets('对话详情中输入回复并发送成功', (tester) async {
    final PanelServer server = PanelServer();
    final RecordingTokenStore tokenStore = RecordingTokenStore('valid-token');
    server.respond('GET /api/auth/session', sessionJson(quotaJson()));
    server.respond('GET /api/feedback/unread-summary', {
      'unreadFeedbacksCount': 0,
      'totalUnreadMessages': 0,
    });
    server.respond('GET /api/feedback/mine', {
      'items': [
        {
          'id': 'fb-202',
          'appId': 'com.example.app',
          'title': '排版错位',
          'text': '深色模式下文字看不清',
          'status': 'received',
          'issueStatus': 'waiting_user',
          'dialogueVersion': 1,
          'archiveRound': 1,
          'lastActivityAt': DateTime.now().toIso8601String(),
          'createdAt': DateTime.now().toIso8601String(),
          'unread': false,
          'messageCount': 0,
          'latestMessage': null,
        }
      ],
      'total': 1,
      'page': 1,
      'limit': 20,
      'unreadTotal': 0,
    });
    server.respond('GET /api/feedback/fb-202/dialogue', {
      'feedback': {
        'id': 'fb-202',
        'appId': 'com.example.app',
        'title': '排版错位',
        'text': '深色模式下文字看不清',
        'status': 'received',
        'issueStatus': 'waiting_user',
        'dialogueVersion': 1,
        'archiveRound': 1,
        'mgmtState': 'inbox',
        'createdAt': DateTime.now().toIso8601String(),
        'updatedAt': DateTime.now().toIso8601String(),
        'lastActivityAt': DateTime.now().toIso8601String(),
      },
      'messages': <Map<String, Object?>>[],
      'lastReadSeq': 0,
    });
    server.respond('POST /api/feedback/fb-202/messages', {
      'ok': true,
      'message': {
        'id': 'msg-reply-1',
        'seq': 1,
        'senderType': 'user',
        'senderId': 'u1',
        'senderName': '我',
        'text': '已在 Android 14 上复现',
        'createdAt': DateTime.now().toIso8601String(),
        'attachments': <Map<String, Object?>>[],
      },
      'dialogueVersion': 2,
      'issueStatus': 'waiting_admin',
    }, 201);

    await pumpPanel(tester, server: server, tokenStore: tokenStore);
    await tester.pumpAndSettle();

    // 点击「我的反馈」Tab
    await tester.tap(find.byKey(const Key('tab-history')));
    await tester.pumpAndSettle();

    // 点击卡片
    await tester.tap(find.byKey(const Key('feedback-item-fb-202')));
    await tester.pumpAndSettle();

    // 输入回复内容
    await tester.enterText(
        find.byKey(const Key('feedback-reply-input')), '已在 Android 14 上复现');
    await tester.pump();

    // 发送
    await tester.tap(find.byKey(const Key('feedback-reply-send')));
    await tester.pumpAndSettle();

    // 验证发送请求发出
    expect(server.count('POST /api/feedback/fb-202/messages'), 1);
    expect(
        (server.lastMatching('POST /api/feedback/fb-202/messages') as dynamic)
            .body,
        contains('已在 Android 14 上复现'));

    // 验证输入框被清空
    final EditableText replyInput =
        tester.widget(find.descendant(
          of: find.byKey(const Key('feedback-reply-input')),
          matching: find.byType(EditableText),
        ));
    expect(replyInput.controller.text, isEmpty);

    await teardownPanel(tester);
  });
}
