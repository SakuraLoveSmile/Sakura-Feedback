import 'dart:convert';
import 'dart:typed_data';

import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'panel_harness.dart';

/// 1x1 PNG。
final Uint8List kTinyPng = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');

Map<String, Object?> _session() => <String, Object?>{
      'authenticated': true,
      'kind': 'client',
      'user': userJson(),
      'quota': quotaJson(),
      'capabilities': <String, Object?>{'dialogue': true, 'images': 5},
    };

Map<String, Object?> _item(String id, String status, {String? title}) =>
    <String, Object?>{
      'id': id,
      'appId': 'com.example.app',
      'text': 'text-$id',
      'title': title,
      'status': 'archived',
      'issueStatus': status,
      'createdAt': '2024-01-01T00:00:00Z',
      'updatedAt': '2024-01-01T00:00:00Z',
      'lastActivityAt': '2024-01-01T00:00:00Z',
      'unread': false,
    };

void main() {
  group('我的反馈：分页 + 状态筛选 + 附件 Bearer', () {
    testWidgets('分页：翻页请求带 page；筛选：issueStatus 参数', (tester) async {
      final PanelServer server = PanelServer();
      server.respond('GET /api/auth/session', _session());
      server.respond(
          'GET /api/feedback/unread-summary', <String, Object?>{'unreadFeedbacksCount': 0, 'totalUnreadMessages': 0});

      final List<String> mineQueries = <String>[];
      server.on('GET /api/feedback/mine', (http.BaseRequest req) async {
        mineQueries.add(req.url.query);
        final Map<String, String> q = req.url.queryParameters;
        final int page = int.tryParse(q['page'] ?? '1') ?? 1;
        final String? status = q['issueStatus'];
        final List<Map<String, Object?>> items = status == null
            ? (page == 1
                ? List<Map<String, Object?>>.generate(
                    10, (int i) => _item('fb-$i', 'open'))
                : <Map<String, Object?>>[_item('fb-x', 'resolved')])
            : <Map<String, Object?>>[_item('fb-s', status)];
        return jsonResponse(<String, Object?>{
          'items': items,
          'total': 11,
          'page': page,
          'limit': 10,
          'unreadTotal': 0,
        });
      });

      await pumpPanel(
        tester,
        server: server,
        tokenStore: MemoryTokenStore('tok'),
      );
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(const Key('tab-history')));
      await tester.pump();
      await tester.pump();

      // 第 1 页 10 条。
      expect(find.byKey(const Key('feedback-history-pageinfo')),
          findsOneWidget);
      expect(mineQueries.last, contains('page=1'));

      // 状态筛选：待补充 → issueStatus=waiting_user。
      await tester.tap(find.byKey(const Key('feedback-filter-waiting_user')));
      await tester.pump();
      await tester.pump();
      expect(mineQueries.last, contains('issueStatus=waiting_user'));
      expect(mineQueries.last, contains('page=1'));

      // 回到全部并翻页。
      await tester.tap(find.byKey(const Key('feedback-filter-all')));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(const Key('feedback-history-next')));
      await tester.pump();
      await tester.pump();
      expect(mineQueries.last, contains('page=2'));
      expect(mineQueries.last, isNot(contains('issueStatus')));
    });

    testWidgets('状态文案 v12：waiting_admin → 待管理员回复、open → 待处理',
        (tester) async {
      final PanelServer server = PanelServer();
      server.respond('GET /api/auth/session', _session());
      server.respond(
          'GET /api/feedback/unread-summary', <String, Object?>{'unreadFeedbacksCount': 0, 'totalUnreadMessages': 0});
      server.respond('GET /api/feedback/mine', <String, Object?>{
        'items': <Map<String, Object?>>[
          _item('a', 'waiting_admin', title: '等管理员'),
          _item('b', 'open', title: '开着'),
        ],
        'total': 2,
        'page': 1,
        'limit': 10,
        'unreadTotal': 0,
      });
      await pumpPanel(
        tester,
        server: server,
        tokenStore: MemoryTokenStore('tok'),
      );
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(const Key('tab-history')));
      await tester.pump();
      await tester.pump();
      // 标签（RichText）—按文字查找（findRichText 命中 RichText）。
      expect(find.text('待管理员回复', findRichText: true), findsWidgets);
      expect(find.text('待处理', findRichText: true), findsWidgets);
      // 不再出现旧误标「新反馈」。
      expect(find.text('新反馈', findRichText: true), findsNothing);
    });

    testWidgets('对话详情：feedback.images 与消息附件经 Bearer 下载渲染',
        (tester) async {
      final PanelServer server = PanelServer();
      server.respond('GET /api/auth/session', _session());
      server.respond(
          'GET /api/feedback/unread-summary', <String, Object?>{'unreadFeedbacksCount': 0, 'totalUnreadMessages': 0});
      server.respond('GET /api/feedback/mine', <String, Object?>{
        'items': <Map<String, Object?>>[
          _item('fb-9', 'resolved', title: '已解'),
        ],
        'total': 1,
        'page': 1,
        'limit': 10,
        'unreadTotal': 0,
      });
      server.respond('GET /api/feedback/fb-9/dialogue', <String, Object?>{
        'feedback': <String, Object?>{
          'id': 'fb-9',
          'appId': 'com.example.app',
          'text': '原反馈',
          'status': 'archived',
          'issueStatus': 'resolved',
          'dialogueVersion': 1,
          'archiveRound': 1,
          'mgmtState': 'closed',
          'createdAt': '2024-01-01T00:00:00Z',
          'updatedAt': '2024-01-02T00:00:00Z',
          'lastActivityAt': '2024-01-02T00:00:00Z',
          'resolutionNote': '已修复并发布',
          'images': <Map<String, Object?>>[
            <String, Object?>{
              'id': 'im1',
              'sort': 0,
              'source': 'capture',
              'mime': 'image/png',
              'filename': 's.png',
              'byteSize': 68,
              'sha256': 'x' * 64,
            },
          ],
          'logs': <Map<String, Object?>>[
            <String, Object?>{
              'id': 'lg1',
              'filename': 'run.log',
              'byteSize': 5,
              'sha256': 'y' * 64,
              'source': 'auto',
            },
          ],
        },
        'messages': <Map<String, Object?>>[
          <String, Object?>{
            'id': 'm1',
            'seq': 1,
            'senderType': 'admin',
            'senderName': 'ops',
            'text': '请看图片',
            'createdAt': '2024-01-02T00:00:00Z',
            'attachments': <Map<String, Object?>>[
              <String, Object?>{
                'id': 'att-1',
                'kind': 'image',
                'filename': 'fix.png',
                'byteSize': 68,
                'sha256': 'z' * 64,
                'mime': 'image/png',
                'createdAt': '2024-01-02T00:00:00Z',
              },
              <String, Object?>{
                'id': 'att-2',
                'kind': 'log',
                'filename': 'diag.log',
                'byteSize': 10,
                'sha256': 'w' * 64,
                'createdAt': '2024-01-02T00:00:00Z',
              },
            ],
          },
        ],
        'lastReadSeq': 1,
      });
      server.respond('POST /api/feedback/fb-9/read',
          <String, Object?>{'ok': true, 'lastReadSeq': 1});
      // 附件下载（Bearer + 图片字节）。
      final List<String> authHits = <String>[];
      server.on('GET /api/feedback/fb-9/images/im1',
          (http.BaseRequest req) async {
        authHits.add('image:${req.headers['Authorization']}');
        return http.Response.bytes(kTinyPng, 200,
            headers: const <String, String>{'content-type': 'image/png'});
      });
      server.on('GET /api/feedback/messages/attachments/att-1',
          (http.BaseRequest req) async {
        authHits.add('att-img:${req.headers['Authorization']}');
        return http.Response.bytes(kTinyPng, 200,
            headers: const <String, String>{'content-type': 'image/png'});
      });
      server.on('GET /api/feedback/fb-9/logs/lg1/download',
          (http.BaseRequest req) async {
        authHits.add('log:${req.headers['Authorization']}');
        return http.Response.bytes(
            utf8.encode('log-body'), 200,
            headers: const <String, String>{'content-type': 'text/plain'});
      });

      await pumpPanel(
        tester,
        server: server,
        tokenStore: MemoryTokenStore('tok'),
      );
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(const Key('tab-history')));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(const Key('feedback-item-fb-9')));
      await tester.pump();
      await tester.pump();
      await tester.pump();

      // resolutionNote 展示。
      expect(find.byKey(const Key('feedback-resolution-note')), findsOneWidget);
      expect(find.textContaining('已修复并发布'), findsWidgets);

      // 图片附件经 Bearer 拉取（image + 消息附件）。
      await tester.pump();
      expect(authHits.any((String h) => h.startsWith('image:Bearer tok')),
          isTrue);
      expect(authHits.any((String h) => h.startsWith('att-img:Bearer tok')),
          isTrue);

      // 日志 chip 点击 → Bearer 下载并预览。
      await tester.tap(find.text('run.log'));
      await tester.pump();
      await tester.pump();
      await tester.pump();
      expect(authHits.any((String h) => h.startsWith('log:Bearer tok')),
          isTrue);
      expect(find.byKey(const Key('feedback-log-preview-dialog')),
          findsOneWidget);
      expect(find.text('log-body'), findsOneWidget);

      // 详情打开期间 10s 轮询激活（断言定时器存在）。
      final FeedbackPanelState panel =
          tester.state<FeedbackPanelState>(find.byType(FeedbackPanel));
      expect(panel.dialoguePollingActive, isTrue,
          reason: '详情打开期间应有 10s 对话轮询');
      expect(panel.summaryPollingActive, isFalse,
          reason: '详情打开时摘要轮询让位给对话轮询');

      // 回复草稿在轮询刷新后不清空。
      await tester.enterText(
          find.byKey(const Key('feedback-reply-input')), '未发出的回复');
      await tester.pump();
      await tester.pump(const Duration(seconds: 11)); // 触发一轮对话轮询
      await tester.pump();
      expect(
        tester.widget<TextField>(
          find.byKey(const Key('feedback-reply-input')),
        ).controller?.text,
        '未发出的回复',
        reason: '轮询增量刷新不得清回复草稿',
      );

      await teardownPanel(tester);
    });
  });
}
