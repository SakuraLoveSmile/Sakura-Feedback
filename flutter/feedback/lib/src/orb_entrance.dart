import 'local_choice.dart';

/// Order is also the entrance selector in orb_gesture_glass.glsl.
enum FeedbackOrbEntrance {
  bead('小珠浮现', 320),
  join('指尖合珠', 320),
  reveal('掠光显形', 250),
  dent('按痕浮起', 335),
  turn('薄镜翻开', 285),
  drop('牵丝成滴', 340),
  corners('取景成球', 280);

  const FeedbackOrbEntrance(this.label, this.milliseconds);
  final String label;
  final int milliseconds;
}

String orbEntranceStorageKey(String appId) =>
    'feedback:orb-entrance:v1:${Uri.encodeComponent(appId)}';

class FeedbackOrbEntrancePreferences
    extends LocalChoicePreferences<FeedbackOrbEntrance> {
  FeedbackOrbEntrancePreferences({required super.appId, required super.store})
      : super(
            values: FeedbackOrbEntrance.values,
            encode: (effect) => effect.name,
            storageKey: orbEntranceStorageKey);
}
