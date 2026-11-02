import 'package:flutter/material.dart';

import 'api_client.dart' show IssueStatus;

/// 反馈状态的固定色板（背景色 / 前景色）。
///
/// 与 Web 端 0.8.2 的语义一致，不再借用 Material `ColorScheme` 的
/// secondary / primary / tertiary container：那套映射会让「待补充」和
/// 「已解决」在不同主题下看起来同样接近主色，用户无法只凭颜色分辨状态。
/// 这里显式固定四种状态色：待处理=琥珀、待补充=蓝、等待回复=紫、已解决=绿，
/// 并按亮度给出各自的深色变体。
@immutable
class FeedbackStatusColors {
  /// 构造一组状态色。
  const FeedbackStatusColors({
    required this.background,
    required this.foreground,
  });

  /// 标签背景色。
  final Color background;

  /// 标签前景色（正文，12px 粗体）。
  final Color foreground;
}

// 浅色主题：柔和的浅底 + 同色相深字，对比度实测 5.98–7.47:1。
// 深色主题：深底 + 浅色同色相字，对比度实测 7.42–8.50:1。
// 两套都明显高于 12px 粗体文本要求的 4.5:1（WCAG AA 正文口径）。
const FeedbackStatusColors _openLight = FeedbackStatusColors(
    background: Color(0xFFFFF4D6), foreground: Color(0xFF8A4B00));
const FeedbackStatusColors _openDark = FeedbackStatusColors(
    background: Color(0xFF4A3410), foreground: Color(0xFFFFD58A));
const FeedbackStatusColors _waitingUserLight = FeedbackStatusColors(
    background: Color(0xFFE3EEFF), foreground: Color(0xFF0B4A9E));
const FeedbackStatusColors _waitingUserDark = FeedbackStatusColors(
    background: Color(0xFF12335C), foreground: Color(0xFFA8C7FF));
const FeedbackStatusColors _waitingAdminLight = FeedbackStatusColors(
    background: Color(0xFFF0E6FF), foreground: Color(0xFF5B21B6));
const FeedbackStatusColors _waitingAdminDark = FeedbackStatusColors(
    background: Color(0xFF33205C), foreground: Color(0xFFD6BCFF));
const FeedbackStatusColors _resolvedLight = FeedbackStatusColors(
    background: Color(0xFFD5F2E1), foreground: Color(0xFF166534));
const FeedbackStatusColors _resolvedDark = FeedbackStatusColors(
    background: Color(0xFF123D28), foreground: Color(0xFF9CE8B8));

/// 取某个状态在指定亮度下的固定配色。
///
/// 历史列表的状态标签与对话详情的状态标签共用这一份映射，保证同一状态在
/// 两个视图里颜色一致；深浅主题各取一套变体。
FeedbackStatusColors feedbackStatusColors(
    IssueStatus status, Brightness brightness) {
  final bool dark = brightness == Brightness.dark;
  return switch (status) {
    IssueStatus.open => dark ? _openDark : _openLight,
    IssueStatus.waitingUser => dark ? _waitingUserDark : _waitingUserLight,
    IssueStatus.waitingAdmin => dark ? _waitingAdminDark : _waitingAdminLight,
    IssueStatus.resolved => dark ? _resolvedDark : _resolvedLight,
  };
}
