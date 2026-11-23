import 'package:feedback_widget/src/server_pref.dart';
import 'package:feedback_widget/src/wake_visual.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('decode defaults to ripple; only aurora opts in', () {
    expect(decodeWakeVisual(null), FeedbackWakeVisual.ripple);
    expect(decodeWakeVisual(''), FeedbackWakeVisual.ripple);
    expect(decodeWakeVisual('garbage'), FeedbackWakeVisual.ripple);
    expect(decodeWakeVisual(' aurora '), FeedbackWakeVisual.aurora);
    expect(encodeWakeVisual(FeedbackWakeVisual.aurora), 'aurora');
    expect(encodeWakeVisual(FeedbackWakeVisual.ripple), 'ripple');
    expect(wakeVisualStorageKey('com.example.app'),
        'feedback:wake-visual:v1:com.example.app');
    expect(wakeVisualStorageKey('a b'), contains('%20'));
  });

  test('preference loads the stored value and persists the selection',
      () async {
    final MemoryServerPrefStore store = MemoryServerPrefStore();
    await store.write(wakeVisualStorageKey('app'), 'aurora');
    final FeedbackWakeVisualPreferences prefs =
        FeedbackWakeVisualPreferences(appId: 'app', store: store);
    expect(prefs.visual, FeedbackWakeVisual.ripple);
    await prefs.load();
    expect(prefs.visual, FeedbackWakeVisual.aurora);
    expect(prefs.sessionOnly, isFalse);

    prefs.select(FeedbackWakeVisual.ripple);
    await pumpEventQueue();
    expect(await store.read(wakeVisualStorageKey('app')), 'ripple');
    expect(prefs.sessionOnly, isFalse);

    prefs.dispose();
  });
}
