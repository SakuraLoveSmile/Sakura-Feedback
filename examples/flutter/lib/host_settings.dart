import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';

/// 宿主侧保存的三项反馈外观（v0.11.0 宿主托管用法）。
///
/// 三项与 [FeedbackWidget] 的 `launcherStyle` / `wakeVisual` / `orbEntrance`
/// 一一对应：值由宿主持有，改选后宿主重建组件即生效；再传
/// `hideSettings: true`，反馈面板的设置页就只剩服务器设置。
class HostFeedbackSettings {
  const HostFeedbackSettings({
    this.launcherStyle = FeedbackLauncherStyle.beam,
    this.wakeVisual = FeedbackWakeVisual.ripple,
    this.orbEntrance = FeedbackOrbEntrance.bead,
  });

  /// 入口样式：光束唤醒（无常驻入口）或灵感球。
  final FeedbackLauncherStyle launcherStyle;

  /// 光束唤醒时的动效：水波涟漪或极光。
  final FeedbackWakeVisual wakeVisual;

  /// 灵感球下次唤醒时播放的入场动画。
  final FeedbackOrbEntrance orbEntrance;

  HostFeedbackSettings copyWith({
    FeedbackLauncherStyle? launcherStyle,
    FeedbackWakeVisual? wakeVisual,
    FeedbackOrbEntrance? orbEntrance,
  }) {
    return HostFeedbackSettings(
      launcherStyle: launcherStyle ?? this.launcherStyle,
      wakeVisual: wakeVisual ?? this.wakeVisual,
      orbEntrance: orbEntrance ?? this.orbEntrance,
    );
  }
}

/// 打开宿主设置页（底部弹层）。
///
/// 最小实现：只做改选与回传，保存与持久化由宿主自己负责。每次改选都会
/// 立刻回调 [onChanged]，宿主 setState 重建 [FeedbackWidget] 即生效。
Future<void> showHostFeedbackSettings(
  BuildContext context, {
  required HostFeedbackSettings settings,
  required ValueChanged<HostFeedbackSettings> onChanged,
}) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (BuildContext context) {
      return _HostFeedbackSettingsSheet(
        initial: settings,
        onChanged: onChanged,
      );
    },
  );
}

/// 三项设置的选择区：改选即回调宿主，不做本地持久化。
class _HostFeedbackSettingsSheet extends StatefulWidget {
  const _HostFeedbackSettingsSheet({
    required this.initial,
    required this.onChanged,
  });

  final HostFeedbackSettings initial;
  final ValueChanged<HostFeedbackSettings> onChanged;

  @override
  State<_HostFeedbackSettingsSheet> createState() =>
      _HostFeedbackSettingsSheetState();
}

class _HostFeedbackSettingsSheetState
    extends State<_HostFeedbackSettingsSheet> {
  late HostFeedbackSettings _current = widget.initial;

  void _update(HostFeedbackSettings next) {
    setState(() {
      _current = next;
    });
    widget.onChanged(next);
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Text(
              '反馈外观设置',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            const Text(
              '反馈外观与动效由宿主统一管理：改选后组件按新值重建，'
              '反馈面板里只保留服务器设置。',
              style: TextStyle(color: Colors.grey),
            ),
            const SizedBox(height: 20),
            const Text('入口样式'),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                for (final FeedbackLauncherStyle style
                    in FeedbackLauncherStyle.values)
                  ChoiceChip(
                    label: Text(_launcherStyleLabel(style)),
                    selected: _current.launcherStyle == style,
                    onSelected: (_) =>
                        _update(_current.copyWith(launcherStyle: style)),
                  ),
              ],
            ),
            const SizedBox(height: 20),
            const Text('唤醒动效'),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                for (final FeedbackWakeVisual visual
                    in FeedbackWakeVisual.values)
                  ChoiceChip(
                    label: Text(_wakeVisualLabel(visual)),
                    selected: _current.wakeVisual == visual,
                    onSelected: (_) =>
                        _update(_current.copyWith(wakeVisual: visual)),
                  ),
              ],
            ),
            const SizedBox(height: 20),
            const Text('灵感球入场'),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                for (final FeedbackOrbEntrance entrance
                    in FeedbackOrbEntrance.values)
                  ChoiceChip(
                    label: Text(entrance.label),
                    selected: _current.orbEntrance == entrance,
                    onSelected: (_) =>
                        _update(_current.copyWith(orbEntrance: entrance)),
                  ),
              ],
            ),
            const SizedBox(height: 24),
            Align(
              alignment: Alignment.centerRight,
              child: FilledButton(
                onPressed: () => Navigator.of(context).pop(),
                child: const Text('完成'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

String _launcherStyleLabel(FeedbackLauncherStyle style) {
  switch (style) {
    case FeedbackLauncherStyle.beam:
      return '光束唤醒';
    case FeedbackLauncherStyle.orb:
      return '灵感球';
  }
}

String _wakeVisualLabel(FeedbackWakeVisual visual) {
  switch (visual) {
    case FeedbackWakeVisual.ripple:
      return '水波涟漪';
    case FeedbackWakeVisual.aurora:
      return '极光';
  }
}
