import 'local_choice.dart';

/// 终端用户的唤醒动效偏好；仅在光束唤醒模式下有意义。
enum FeedbackWakeVisual { ripple, aurora }

String wakeVisualStorageKey(String appId) =>
    'feedback:wake-visual:v1:${Uri.encodeComponent(appId)}';

FeedbackWakeVisual decodeWakeVisual(String? value) => value?.trim() == 'aurora'
    ? FeedbackWakeVisual.aurora
    : FeedbackWakeVisual.ripple;

String encodeWakeVisual(FeedbackWakeVisual visual) => visual.name;

class FeedbackWakeVisualPreferences
    extends LocalChoicePreferences<FeedbackWakeVisual> {
  FeedbackWakeVisualPreferences({required super.appId, required super.store})
      : super(
            values: FeedbackWakeVisual.values,
            storageKey: wakeVisualStorageKey);
}
