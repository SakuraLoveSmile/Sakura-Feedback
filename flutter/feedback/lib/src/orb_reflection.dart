import 'local_choice.dart';
import 'server_pref.dart';

/// 按应用保存灵感球反射开关。宿主设置页可与组件使用同一份本机偏好。
class FeedbackOrbReflectionPreferences extends LocalChoicePreferences<bool> {
  FeedbackOrbReflectionPreferences({
    required super.appId,
    FeedbackServerPrefStore? store,
  }) : super(
          store: store ?? createDefaultServerPrefStore(),
          values: const [true, false],
          encode: (enabled) => enabled.toString(),
          storageKey: (appId) =>
              'feedback:orb-reflection:v1:${Uri.encodeComponent(appId)}',
        );

  /// 读取偏好后才显示边缘倒影，首次使用默认开启。
  bool get enabled => ready && visual;
}
