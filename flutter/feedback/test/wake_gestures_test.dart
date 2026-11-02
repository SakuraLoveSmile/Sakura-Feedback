import 'dart:async';

import 'package:feedback_widget/src/wake_gestures.dart';
import 'package:feedback_widget/src/server_pref.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const Set<FeedbackWakeGesture> _all = <FeedbackWakeGesture>{
  ...FeedbackWakeGesture.values
};
const List<Offset> _points = <Offset>[
  Offset(160, 300),
  Offset(220, 300),
  Offset(280, 300)
];

class _Harness {
  FeedbackWakeGestureRecognizer? recognizer;
  final List<Offset> wakes = <Offset>[];
  bool hint = false;
  bool available = true;
  Set<FeedbackWakeGesture> enabled = _all;

  Future<void> mount(WidgetTester tester, {Widget? child}) async {
    await tester.pumpWidget(MaterialApp(
        home: Listener(
      onPointerUp: (PointerUpEvent e) => recognizer?.preparePointerUp(e),
      child: RawGestureDetector(
        behavior: HitTestBehavior.translucent,
        gestures: <Type, GestureRecognizerFactory>{
          FeedbackWakeGestureRecognizer: GestureRecognizerFactoryWithHandlers<
              FeedbackWakeGestureRecognizer>(
            () => recognizer = FeedbackWakeGestureRecognizer(),
            (FeedbackWakeGestureRecognizer value) {
              value
                ..isAvailable = (() => available)
                ..onReleaseHint = ((bool value) => hint = value)
                ..onWake = wakes.add
                ..enabled = enabled;
            },
          ),
        },
        child: child ?? const ColoredBox(color: Colors.blue),
      ),
    )));
  }
}

Future<List<TestGesture>> _down(WidgetTester tester, int count,
    {List<Offset> points = _points}) async {
  final List<TestGesture> touches = <TestGesture>[];
  for (int i = 0; i < count; i++) {
    touches.add(await tester.startGesture(points[i]));
  }
  return touches;
}

Future<void> _up(List<TestGesture> touches) async {
  for (final TestGesture touch in touches) {
    await touch.up();
  }
}

Future<void> _swipe(List<TestGesture> touches,
    [Offset delta = const Offset(0, -80)]) async {
  for (final TestGesture touch in touches) {
    await touch.moveBy(delta);
  }
}

class _Store implements FeedbackServerPrefStore {
  final Map<String, String> data = <String, String>{};
  final List<String> reads = <String>[];
  final List<(String, String)> writes = <(String, String)>[];
  final List<Completer<void>> gates = <Completer<void>>[];
  Completer<String?>? readGate;
  bool failRead = false, failWrite = false, delayWrites = false;
  @override
  Future<String?> read(String key) async {
    reads.add(key);
    if (failRead) throw StateError('read failed');
    return readGate == null ? data[key] : await readGate!.future;
  }

  @override
  Future<void> write(String key, String value) async {
    writes.add((key, value));
    if (delayWrites) {
      final Completer<void> gate = Completer<void>();
      gates.add(gate);
      await gate.future;
    }
    if (failWrite) throw StateError('write failed');
    data[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    data.remove(key);
  }
}

void main() {
  testWidgets(
      'hold accepts at 700ms, latches once, waits for all ups and uses final centroid',
      (tester) async {
    final _Harness h = _Harness();
    await h.mount(tester);
    final List<TestGesture> fingers = await _down(tester, 2);
    await tester.pump(const Duration(milliseconds: 699));
    expect(h.hint, isFalse);
    await tester.pump(const Duration(milliseconds: 1));
    expect(h.hint, isTrue);
    expect(h.wakes, isEmpty);
    await fingers[0].moveBy(const Offset(4, 0));
    await fingers[0].up();
    expect(h.wakes, isEmpty);
    await tester.pump(const Duration(seconds: 2));
    await fingers[1].up();
    expect(h.wakes, <Offset>[const Offset(192, 300)]);
    expect(h.hint, isFalse);
    await tester.pump(const Duration(seconds: 2));
    expect(h.wakes, hasLength(1));
  });

  for (final String failure in <String>[
    'early-up',
    'move',
    'third',
    'cancel',
    'late-second'
  ]) {
    testWidgets('hold rejects $failure', (tester) async {
      final _Harness h = _Harness()
        ..enabled = <FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerHold};
      await h.mount(tester);
      final TestGesture a = await tester.startGesture(_points[0]);
      if (failure == 'late-second') {
        await tester.pump(const Duration(milliseconds: 181));
      }
      final TestGesture b = await tester.startGesture(_points[1]);
      if (failure == 'early-up') await a.up();
      if (failure == 'move') await a.moveBy(const Offset(12.1, 0));
      if (failure == 'third') {
        final TestGesture c = await tester.startGesture(_points[2]);
        await c.up();
      }
      if (failure == 'cancel') await a.cancel();
      await tester.pump(const Duration(milliseconds: 750));
      if (failure != 'early-up' && failure != 'cancel') await a.up();
      await b.up();
      expect(h.wakes, isEmpty);
      expect(h.hint, isFalse);
    });
  }

  testWidgets(
      'pending hold leaves pinch arena and single-finger scrolling to host',
      (tester) async {
    final _Harness h = _Harness();
    int scales = 0;
    await h.mount(tester,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onScaleStart: (_) => scales++,
          onScaleUpdate: (_) {},
          child: const SizedBox.expand(),
        ));
    final List<TestGesture> fingers = await _down(tester, 2);
    expect(scales, 0, reason: 'second down must not steal scale');
    await fingers[0].moveBy(const Offset(-40, 0));
    await fingers[1].moveBy(const Offset(40, 0));
    expect(scales, greaterThan(0));
    await _up(fingers);
    expect(h.wakes, isEmpty);

    final ScrollController scroll = ScrollController();
    addTearDown(scroll.dispose);
    await h.mount(tester,
        child: ListView(
            controller: scroll,
            children: const <Widget>[SizedBox(height: 2500)]));
    final TestGesture single = await tester.startGesture(_points[0]);
    await single.moveBy(const Offset(0, -100));
    await tester.pump();
    await single.moveBy(const Offset(0, -100));
    await single.up();
    await tester.pump();
    expect(scroll.offset, greaterThan(0));
    expect(h.wakes, isEmpty);
  });

  testWidgets(
      'three fingers reserve all live arenas before host scroll; thresholds and all-up gate',
      (tester) async {
    final _Harness h = _Harness();
    final ScrollController scroll = ScrollController();
    addTearDown(scroll.dispose);
    await h.mount(tester,
        child: ListView(
            controller: scroll,
            children: const <Widget>[SizedBox(height: 2500)]));
    final List<TestGesture> fingers = await _down(tester, 3);
    await fingers[0].moveBy(const Offset(0, -100));
    await fingers[1].moveBy(const Offset(0, -100));
    await fingers[2].moveBy(const Offset(0, -47));
    expect(h.hint, isFalse, reason: 'each finger must move up at least 48');
    await fingers[2].moveBy(const Offset(0, -1));
    expect(h.hint, isTrue);
    expect(h.wakes, isEmpty);
    expect(scroll.offset, 0);
    await fingers[0].up();
    await fingers[1].up();
    expect(h.wakes, isEmpty);
    await fingers[2].up();
    expect(h.wakes, hasLength(1));
    expect(
        (h.wakes.single - Offset(220, 300 - 248 / 3)).distance, lessThan(1e-9));
    expect(h.hint, isFalse);
    await tester.pumpAndSettle();
    expect(scroll.offset, 0);
  });

  testWidgets(
      'three-finger swipe measures displacement only after the third finger joins',
      (tester) async {
    final _Harness h = _Harness()
      ..enabled = <FeedbackWakeGesture>{FeedbackWakeGesture.threeFingerSwipeUp};
    await h.mount(tester);
    final List<TestGesture> fingers = await _down(tester, 2);
    await _swipe(fingers, const Offset(0, -12));
    fingers.add(await tester.startGesture(_points[2]));

    await _swipe(fingers, const Offset(0, -64));
    expect(h.hint, isFalse,
        reason:
            'the first two fingers pre-join 12px must not count toward 72px');
    expect(h.wakes, isEmpty);
    await _swipe(fingers, const Offset(0, -7));
    expect(h.hint, isFalse,
        reason: '71px after all fingers join is insufficient');
    await _swipe(fingers, const Offset(0, -1));
    expect(h.hint, isTrue, reason: '72px after all fingers join recognizes');
    expect(h.wakes, isEmpty);

    await fingers[0].up();
    await fingers[1].up();
    expect(h.wakes, isEmpty, reason: 'the last finger is still down');
    await fingers[2].up();
    expect(h.wakes, <Offset>[const Offset(220, 220)]);
    expect(h.hint, isFalse);
    await tester.pump(const Duration(seconds: 1));
    expect(h.wakes, hasLength(1));
  });

  for (final String failure in <String>[
    'two',
    'four',
    'down',
    'sideways',
    'ratio',
    'timeout',
    'cancel',
    'before-join',
    'late-third'
  ]) {
    testWidgets('three-finger swipe rejects $failure', (tester) async {
      final _Harness h = _Harness()
        ..enabled = <FeedbackWakeGesture>{
          FeedbackWakeGesture.threeFingerSwipeUp
        };
      await h.mount(tester);
      final List<TestGesture> fingers = await _down(tester, 2);
      if (failure == 'before-join') {
        await fingers[0].moveBy(const Offset(0, -13));
      }
      if (failure == 'late-third') {
        await tester.pump(const Duration(milliseconds: 181));
      }
      if (failure != 'two') fingers.add(await tester.startGesture(_points[2]));
      if (failure == 'four') {
        fingers.add(await tester.startGesture(const Offset(340, 300)));
      }
      if (failure == 'timeout') {
        await tester.pump(const Duration(milliseconds: 701));
      }
      if (failure == 'cancel') {
        await fingers.removeLast().cancel();
      }
      await _swipe(
          fingers,
          failure == 'down'
              ? const Offset(0, 80)
              : failure == 'sideways'
                  ? const Offset(65, -80)
                  : failure == 'ratio'
                      ? const Offset(47, -72)
                      : const Offset(0, -80));
      await _up(fingers);
      expect(h.wakes, isEmpty);
      expect(h.hint, isFalse);
    });
  }

  testWidgets(
      'an arena lost to a host drag cannot be reclaimed when third finger arrives',
      (tester) async {
    final _Harness h = _Harness();
    int drags = 0;
    await h.mount(tester,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onVerticalDragStart: (_) => drags++,
          onVerticalDragUpdate: (_) {},
          child: const SizedBox.expand(),
        ));
    final TestGesture a = await tester.startGesture(_points[0]);
    await a.moveBy(const Offset(0, -50));
    expect(drags, 1);
    final List<TestGesture> rest =
        await _down(tester, 2, points: _points.sublist(1));
    await _swipe(<TestGesture>[a, ...rest]);
    await _up(<TestGesture>[a, ...rest]);
    expect(h.wakes, isEmpty);
  });

  testWidgets(
      'two-finger double tap suppresses host clicks and does not become a hold',
      (tester) async {
    final _Harness h = _Harness();
    int taps = 0;
    await h.mount(tester,
        child: GestureDetector(
            onTap: () => taps++,
            behavior: HitTestBehavior.opaque,
            child: const SizedBox.expand()));
    await _up(await _down(tester, 2));
    expect(h.wakes, isEmpty);
    expect(taps, 0);
    await tester.pump(const Duration(milliseconds: 200));
    final List<TestGesture> second = await _down(tester, 2);
    await second[0].up();
    expect(h.wakes, isEmpty);
    await second[1].up();
    expect(h.wakes, <Offset>[const Offset(190, 300)]);
    expect(taps, 0);
    await tester.pump(const Duration(milliseconds: 800));
    expect(h.wakes, hasLength(1));
    expect(h.hint, isFalse);
  });

  for (final String failure in <String>[
    'single',
    'late-join',
    'held',
    'movement',
    'release-gap',
    'round-gap',
    'distance',
    'cancel'
  ]) {
    testWidgets('two-finger double tap rejects $failure', (tester) async {
      final _Harness h = _Harness()
        ..enabled = <FeedbackWakeGesture>{
          FeedbackWakeGesture.twoFingerDoubleTap
        };
      await h.mount(tester);
      final List<TestGesture> first = await _down(tester, 1);
      if (failure == 'late-join') {
        await tester.pump(const Duration(milliseconds: 121));
      }
      if (failure != 'single') first.add(await tester.startGesture(_points[1]));
      if (failure == 'held') {
        await tester.pump(const Duration(milliseconds: 221));
      }
      if (failure == 'movement') await first[0].moveBy(const Offset(0, 13));
      if (failure == 'cancel') {
        await first.removeLast().cancel();
      }
      await first[0].up();
      if (failure == 'release-gap') {
        await tester.pump(const Duration(milliseconds: 101));
      }
      if (first.length > 1) await first[1].up();
      await tester
          .pump(Duration(milliseconds: failure == 'round-gap' ? 301 : 100));
      final List<TestGesture> second = await _down(
          tester, failure == 'single' ? 1 : 2,
          points: failure == 'distance'
              ? _points.map((Offset p) => p + const Offset(33, 0)).toList()
              : _points);
      await _up(second);
      expect(h.wakes, isEmpty);
      await tester.pump(const Duration(milliseconds: 800));
    });
  }

  for (final String invalidation in <String>[
    'cancel',
    'extra-finger',
    'availability',
    'disabled',
    'dispose'
  ]) {
    testWidgets('latched hold invalidation $invalidation prevents late wake',
        (tester) async {
      final _Harness h = _Harness();
      await h.mount(tester);
      final List<TestGesture> fingers = await _down(tester, 2);
      await tester.pump(const Duration(milliseconds: 700));
      expect(h.hint, isTrue);
      if (invalidation == 'cancel') {
        await fingers.removeLast().cancel();
      }
      if (invalidation == 'extra-finger') {
        fingers.add(await tester.startGesture(_points[2]));
      }
      if (invalidation == 'availability') h.available = false;
      if (invalidation == 'disabled') {
        h.enabled = <FeedbackWakeGesture>{};
        await h.mount(tester);
      }
      if (invalidation == 'dispose') {
        await tester.pumpWidget(const SizedBox.shrink());
      }
      await _up(fingers);
      await tester.pump(const Duration(seconds: 1));
      expect(h.wakes, isEmpty);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
      'default-off, mouse and stylus cannot wake; single tap remains host-owned',
      (tester) async {
    final _Harness h = _Harness()..enabled = <FeedbackWakeGesture>{};
    int taps = 0;
    final Widget child = GestureDetector(
        onTap: () => taps++,
        behavior: HitTestBehavior.opaque,
        child: const SizedBox.expand());
    await h.mount(tester, child: child);
    await _up(await _down(tester, 2));
    await tester.pump(const Duration(milliseconds: 800));
    expect(h.wakes, isEmpty);
    h.enabled = _all;
    await h.mount(tester, child: child);
    for (final PointerDeviceKind kind in <PointerDeviceKind>[
      PointerDeviceKind.mouse,
      PointerDeviceKind.stylus
    ]) {
      final TestGesture pointer =
          await tester.startGesture(_points[0], kind: kind);
      await tester.pump(const Duration(milliseconds: 800));
      await pointer.up();
    }
    final int before = taps;
    await tester.tapAt(_points[0]);
    expect(taps, before + 1);
    expect(h.wakes, isEmpty);
    await tester.pump(const Duration(milliseconds: 800));
  });

  testWidgets(
      'inclusive two-finger join, press, release and inter-round deadlines remain valid',
      (tester) async {
    final _Harness h = _Harness()
      ..enabled = <FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerDoubleTap};
    await h.mount(tester);
    for (int round = 0; round < 2; round++) {
      final TestGesture a = await tester.startGesture(_points[0]);
      await tester.pump(const Duration(milliseconds: 120));
      final TestGesture b = await tester.startGesture(_points[1]);
      await a.up();
      await tester.pump(const Duration(milliseconds: 100));
      await b.up();
      if (round == 0) {
        await tester.pump(const Duration(milliseconds: 300));
      }
    }
    expect(h.wakes, <Offset>[const Offset(190, 300)]);
  });

  testWidgets(
      'hold includes second finger at 180ms and rejects pinch below individual movement limit',
      (tester) async {
    final _Harness h = _Harness()
      ..enabled = <FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerHold};
    await h.mount(tester);
    final TestGesture a = await tester.startGesture(_points[0]);
    await tester.pump(const Duration(milliseconds: 180));
    final TestGesture b = await tester.startGesture(_points[1]);
    await tester.pump(const Duration(milliseconds: 700));
    await _up(<TestGesture>[a, b]);
    expect(h.wakes, hasLength(1));
    final List<TestGesture> pinch = await _down(tester, 2);
    await pinch[0].moveBy(const Offset(-10, 0));
    await pinch[1].moveBy(const Offset(10, 0));
    await tester.pump(const Duration(milliseconds: 700));
    await _up(pinch);
    expect(h.wakes, hasLength(1),
        reason:
            'relative pinch movement cancels even if each finger moves less than 12px');
  });

  testWidgets(
      'second tap final centroid must stay within 32px, even when downs were near enough',
      (tester) async {
    final _Harness h = _Harness()
      ..enabled = <FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerDoubleTap};
    await h.mount(tester);
    await _up(await _down(tester, 2));
    final List<TestGesture> second = await _down(tester, 2,
        points: _points.map((Offset p) => p + const Offset(30, 0)).toList());
    for (final TestGesture finger in second) {
      await finger.moveBy(const Offset(4, 0));
    }
    await _up(second);
    expect(h.wakes, isEmpty);
  });

  test(
      'late old-app reads and disposed preferences cannot publish stale choices',
      () async {
    final _Store store = _Store()..readGate = Completer<String?>();
    final Completer<String?> a = store.readGate!;
    final FeedbackWakePreferences prefs =
        FeedbackWakePreferences(appId: 'a', store: store);
    final Future<void> read = prefs.load();
    final Completer<String?> b = Completer<String?>();
    store.readGate = b;
    prefs.rebind(appId: 'b', store: store);
    a.complete(encodeWakeGestures(_all));
    await read;
    expect(prefs.enabled, isEmpty);
    prefs.dispose();
    b.complete(encodeWakeGestures(_all));
    await Future<void>.delayed(Duration.zero);
  });

  test(
      'preference codec filters unknown/duplicate IDs and rejects invalid versions',
      () {
    expect(wakeGestureStorageKey('a b/中'),
        'feedback:wake-gestures:v1:a%20b%2F%E4%B8%AD');
    expect(
        decodeWakeGestures(
            '{"version":1,"enabled":["unknown","two-finger-hold","two-finger-hold",42]}'),
        <FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerHold});
    for (final String raw in <String>[
      'not-json',
      'null',
      '[]',
      '{"version":2,"enabled":["two-finger-hold"]}',
      '{"version":1,"enabled":true}'
    ]) {
      expect(decodeWakeGestures(raw), isEmpty);
    }
    expect(decodeWakeGestures(encodeWakeGestures(_all)), _all);
  });

  test(
      'late read cannot overwrite new selection; ordered writes and app identities remain isolated',
      () async {
    final _Store store = _Store()
      ..readGate = Completer<String?>()
      ..delayWrites = true;
    final FeedbackWakePreferences prefs =
        FeedbackWakePreferences(appId: 'a', store: store);
    final Future<void> read = prefs.load();
    prefs.select(<FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerHold});
    prefs.select(<FeedbackWakeGesture>{FeedbackWakeGesture.threeFingerSwipeUp});
    await Future<void>.delayed(Duration.zero);
    expect(store.writes, hasLength(1));
    store.readGate!.complete(encodeWakeGestures(
        <FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerDoubleTap}));
    await read;
    expect(prefs.enabled,
        <FeedbackWakeGesture>{FeedbackWakeGesture.threeFingerSwipeUp});
    store.gates[0].complete();
    await Future<void>.delayed(Duration.zero);
    expect(store.writes, hasLength(2));
    store.gates[1].complete();
    await Future<void>.delayed(Duration.zero);
    expect(decodeWakeGestures(store.data[wakeGestureStorageKey('a')]),
        prefs.enabled);

    prefs.select(<FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerHold});
    prefs.select(_all); // queued under old app; must never write into b
    await Future<void>.delayed(Duration.zero);
    store.readGate = null;
    prefs.rebind(appId: 'b', store: store);
    await Future<void>.delayed(Duration.zero);
    expect(prefs.enabled, isEmpty);
    store.gates[2].complete();
    await Future<void>.delayed(Duration.zero);
    expect(store.writes, hasLength(3),
        reason: 'queued old identity is discarded');
    expect(store.data[wakeGestureStorageKey('b')], isNull);
    prefs.dispose();
  });

  test(
      'returning app waits for its in-flight gesture write before restoring choices',
      () async {
    final _Store store = _Store()..delayWrites = true;
    final FeedbackWakePreferences prefs =
        FeedbackWakePreferences(appId: 'a', store: store);
    addTearDown(prefs.dispose);
    await prefs.load();
    prefs.select(<FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerHold});
    await Future<void>.delayed(Duration.zero);
    expect(store.gates, hasLength(1));

    prefs.rebind(appId: 'b', store: store);
    prefs.rebind(appId: 'a', store: store);
    await Future<void>.delayed(Duration.zero);
    store.gates.single.complete();
    await Future<void>.delayed(Duration.zero);

    expect(prefs.enabled,
        <FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerHold},
        reason: 'returning A must restore the choice its earlier write saved');
    expect(decodeWakeGestures(store.data[wakeGestureStorageKey('a')]),
        prefs.enabled);
    expect(prefs.sessionOnly, isFalse);
  });

  test(
      'another preference store does not wait for an old same-key gesture write',
      () async {
    final _Store old = _Store()..delayWrites = true;
    final FeedbackWakePreferences prefs =
        FeedbackWakePreferences(appId: 'a', store: old);
    addTearDown(prefs.dispose);
    prefs.select(<FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerHold});
    await Future<void>.delayed(Duration.zero);
    expect(old.gates, hasLength(1));

    final _Store next = _Store();
    next.data[wakeGestureStorageKey('a')] = encodeWakeGestures(
        <FeedbackWakeGesture>{FeedbackWakeGesture.threeFingerSwipeUp});
    prefs.rebind(appId: 'a', store: next);
    await Future<void>.delayed(Duration.zero);
    expect(prefs.enabled,
        <FeedbackWakeGesture>{FeedbackWakeGesture.threeFingerSwipeUp});
    prefs.select(<FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerDoubleTap});
    await Future<void>.delayed(Duration.zero);
    expect(decodeWakeGestures(next.data[wakeGestureStorageKey('a')]),
        <FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerDoubleTap},
        reason: 'another backend must not queue behind the old backend');

    old.gates.single.complete();
    await Future<void>.delayed(Duration.zero);
    expect(prefs.enabled,
        <FeedbackWakeGesture>{FeedbackWakeGesture.twoFingerDoubleTap});
  });

  test(
      'failed preference storage keeps immediate choices active and reports session-only',
      () async {
    final _Store store = _Store()
      ..failRead = true
      ..failWrite = true;
    final FeedbackWakePreferences prefs =
        FeedbackWakePreferences(appId: 'a', store: store);
    await prefs.load();
    expect(prefs.sessionOnly, isTrue);
    prefs.select(_all);
    expect(prefs.enabled, _all);
    await Future<void>.delayed(Duration.zero);
    expect(prefs.sessionOnly, isTrue);
    expect(prefs.enabled, _all);
    prefs.dispose();
  });
}
