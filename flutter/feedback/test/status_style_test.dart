import 'dart:math' as math;

import 'package:feedback_widget/feedback_widget.dart';
import 'package:feedback_widget/src/status_style.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'panel_harness.dart';

/// WCAG 相对亮度对比度。
double _contrast(Color foreground, Color background) {
  final double a = foreground.computeLuminance();
  final double b = background.computeLuminance();
  final double hi = math.max(a, b);
  final double lo = math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

Map<String, Object?> _resolvedItem() => <String, Object?>{
      'id': 'fb-r',
      'appId': 'com.example.app',
      'title': '已解决反馈',
      'text': '问题已经处理好了',
      'status': 'received',
      'issueStatus': 'resolved',
      'dialogueVersion': 1,
      'archiveRound': 1,
      'lastActivityAt': '2026-11-02T10:00:00Z',
      'createdAt': '2026-11-02T09:00:00Z',
      'unread': false,
      'messageCount': 1,
    };

void main() {
  test('四种状态颜色互不相同，且深浅主题各有一套固定色板', () {
    final Map<Brightness, Set<int>> backgrounds = <Brightness, Set<int>>{};
    final Map<Brightness, Set<int>> foregrounds = <Brightness, Set<int>>{};
    for (final Brightness brightness in Brightness.values) {
      final List<FeedbackStatusColors> palette = <FeedbackStatusColors>[
        for (final IssueStatus status in IssueStatus.values)
          feedbackStatusColors(status, brightness),
      ];
      backgrounds[brightness] = palette
          .map((FeedbackStatusColors c) => c.background.toARGB32())
          .toSet();
      foregrounds[brightness] = palette
          .map((FeedbackStatusColors c) => c.foreground.toARGB32())
          .toSet();
      expect(backgrounds[brightness]!.length, IssueStatus.values.length,
          reason: '${brightness.name}: 四种状态背景色必须互不相同');
      expect(foregrounds[brightness]!.length, IssueStatus.values.length,
          reason: '${brightness.name}: 四种状态前景色必须互不相同');
      for (final IssueStatus status in IssueStatus.values) {
        final FeedbackStatusColors colors =
            feedbackStatusColors(status, brightness);
        expect(colors.background, isNot(colors.foreground));
      }
      expect(
          backgrounds[brightness],
          isNot(backgrounds[brightness == Brightness.dark
              ? Brightness.light
              : Brightness.dark]),
          reason: '浅色 / 深色主题必须使用两套不同色板');
    }
  });

  test('12px 粗体文本前景/背景对比度全部不低于 4.5:1', () {
    for (final Brightness brightness in Brightness.values) {
      for (final IssueStatus status in IssueStatus.values) {
        final FeedbackStatusColors colors =
            feedbackStatusColors(status, brightness);
        final double ratio = _contrast(colors.foreground, colors.background);
        expect(ratio, greaterThanOrEqualTo(4.5),
            reason:
                '${brightness.name}/${status.toWire()} 对比度 ${ratio.toStringAsFixed(2)}:1');
      }
    }
  });

  test('resolved 为绿色（g 通道显著大于 r/b），其余状态色相可区分', () {
    for (final Brightness brightness in Brightness.values) {
      final FeedbackStatusColors resolved =
          feedbackStatusColors(IssueStatus.resolved, brightness);
      for (final Color color in <Color>[
        resolved.background,
        resolved.foreground
      ]) {
        expect(color.g, greaterThan(color.r + 0.05),
            reason: '${brightness.name} resolved 必须是绿色');
        expect(color.g, greaterThan(color.b + 0.05),
            reason: '${brightness.name} resolved 必须是绿色');
      }
      final FeedbackStatusColors open =
          feedbackStatusColors(IssueStatus.open, brightness);
      expect(open.background.r, greaterThan(open.background.b),
          reason: '待处理必须偏暖（琥珀/橙）');
      final FeedbackStatusColors waitingUser =
          feedbackStatusColors(IssueStatus.waitingUser, brightness);
      expect(waitingUser.background.b, greaterThan(waitingUser.background.r),
          reason: '待补充必须偏蓝');
      final FeedbackStatusColors waitingAdmin =
          feedbackStatusColors(IssueStatus.waitingAdmin, brightness);
      expect(waitingAdmin.background.b, greaterThan(waitingAdmin.background.g),
          reason: '等待回复必须偏紫');
      expect(waitingAdmin.background.r, greaterThan(waitingAdmin.background.g),
          reason: '等待回复必须偏紫');
    }
  });

  for (final (FeedbackThemeMode mode, Brightness brightness)
      in <(FeedbackThemeMode, Brightness)>[
    (FeedbackThemeMode.light, Brightness.light),
    (FeedbackThemeMode.dark, Brightness.dark),
  ]) {
    testWidgets('历史列表与对话详情 resolved 状态容器使用固定绿色（${mode.name}）', (tester) async {
      final FeedbackStatusColors expected =
          feedbackStatusColors(IssueStatus.resolved, brightness);
      final PanelServer server = PanelServer();
      server.respond('GET /api/auth/session', sessionJson(quotaJson()));
      server.respond('GET /api/feedback/unread-summary', <String, Object?>{
        'unreadFeedbacksCount': 0,
        'totalUnreadMessages': 0
      });
      server.respond('GET /api/feedback/mine', <String, Object?>{
        'items': <Object?>[_resolvedItem()],
        'total': 1,
        'page': 1,
        'limit': 10,
        'unreadTotal': 0,
      });
      server.respond('GET /api/feedback/fb-r/dialogue', <String, Object?>{
        'feedback': <String, Object?>{
          'id': 'fb-r',
          'appId': 'com.example.app',
          'title': '已解决反馈',
          'text': '问题已经处理好了',
          'status': 'received',
          'issueStatus': 'resolved',
          'dialogueVersion': 1,
          'archiveRound': 1,
          'mgmtState': 'inbox',
          'createdAt': '2026-11-02T09:00:00Z',
          'updatedAt': '2026-11-02T10:00:00Z',
          'lastActivityAt': '2026-11-02T10:00:00Z',
          'resolutionNote': '已修复并发布',
        },
        'messages': <Object?>[],
        'lastReadSeq': 0,
      });

      await pumpPanel(tester,
          server: server,
          tokenStore: RecordingTokenStore('valid-token'),
          theme: ThemeData(brightness: brightness),
          config: FeedbackConfig('https://svc.test', 'com.example.app',
              appVersion: '9.9.9', pageLabel: 'home', theme: mode));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('tab-history')));
      await tester.pumpAndSettle();

      final Finder historyChip =
          find.byKey(const Key('feedback-history-status-fb-r'));
      final Container historyContainer = tester.widget<Container>(historyChip);
      expect((historyContainer.decoration! as BoxDecoration).color,
          expected.background,
          reason: '历史行 resolved 标签背景必须是固定绿色');
      final RichText historyLabel = tester.widget<RichText>(
          find.descendant(of: historyChip, matching: find.byType(RichText)));
      final TextSpan historySpan = historyLabel.text as TextSpan;
      expect(historySpan.style!.color, expected.foreground);
      expect(historySpan.style!.fontSize, 12);
      expect(historySpan.style!.fontWeight, FontWeight.w600);

      await tester.tap(find.byKey(const Key('feedback-item-fb-r')));
      await tester.pumpAndSettle();
      final Finder dialogueChip =
          find.byKey(const Key('feedback-dialogue-status'));
      final Container dialogueContainer =
          tester.widget<Container>(dialogueChip);
      expect((dialogueContainer.decoration! as BoxDecoration).color,
          expected.background,
          reason: '对话详情 resolved 标签与历史行同色');
      final Text dialogueLabel = tester.widget<Text>(
          find.descendant(of: dialogueChip, matching: find.byType(Text)));
      expect(dialogueLabel.style!.color, expected.foreground);
      expect(dialogueLabel.style!.fontSize, 12);
      expect(dialogueLabel.style!.fontWeight, FontWeight.w600);
      await teardownPanel(tester);
    });
  }
}
