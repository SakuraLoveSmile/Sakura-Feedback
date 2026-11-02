import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';

import 'server_pref.dart';

/// Internal settings IDs shared with the Web component; no public config change.
enum FeedbackWakeGesture {
  twoFingerHold('two-finger-hold', '双指长按', '两指同时按住 700 毫秒'),
  threeFingerSwipeUp('three-finger-swipe-up', '三指上滑', '三指同时向上滑动'),
  twoFingerDoubleTap('two-finger-double-tap', '双指双击', '用两指连续轻点两次');

  const FeedbackWakeGesture(this.id, this.title, this.description);
  final String id;
  final String title;
  final String description;
}

String wakeGestureStorageKey(String appId) =>
    'feedback:wake-gestures:v1:${Uri.encodeComponent(appId)}';

Set<FeedbackWakeGesture> decodeWakeGestures(String? value) {
  try {
    final Object? json = value == null ? null : jsonDecode(value);
    if (json is! Map<String, dynamic> ||
        json['version'] != 1 ||
        json['enabled'] is! List<Object?>) {
      return <FeedbackWakeGesture>{};
    }
    return FeedbackWakeGesture.values
        .where((FeedbackWakeGesture gesture) =>
            (json['enabled'] as List<Object?>).contains(gesture.id))
        .toSet();
  } on FormatException {
    return <FeedbackWakeGesture>{};
  }
}

String encodeWakeGestures(Set<FeedbackWakeGesture> enabled) =>
    jsonEncode(<String, Object>{
      'version': 1,
      'enabled': FeedbackWakeGesture.values
          .where(enabled.contains)
          .map((FeedbackWakeGesture gesture) => gesture.id)
          .toList(),
    });

/// Root-owned preferences: reads start before the panel exists. A selection
/// invalidates the pending read; a rebind invalidates old identity operations.
class FeedbackWakePreferences extends ChangeNotifier {
  FeedbackWakePreferences(
      {required String appId, required FeedbackServerPrefStore store})
      : _appId = appId,
        _store = store;
  String _appId;
  FeedbackServerPrefStore _store;
  Set<FeedbackWakeGesture> _enabled = <FeedbackWakeGesture>{};
  bool sessionOnly = false;
  int _identity = 0;
  int _revision = 0;
  bool _disposed = false;
  final Map<FeedbackServerPrefStore, Map<String, Future<void>>> _writeTails =
      Map<FeedbackServerPrefStore, Map<String, Future<void>>>.identity();

  Set<FeedbackWakeGesture> get enabled =>
      Set<FeedbackWakeGesture>.unmodifiable(_enabled);

  Future<void> load() async {
    final int identity = _identity, revision = _revision;
    final String key = wakeGestureStorageKey(_appId);
    final FeedbackServerPrefStore store = _store;
    bool current() =>
        !_disposed && identity == _identity && revision == _revision;
    try {
      // Returning to an app must read after its earlier in-flight write;
      // another store with the same key has an independent write queue.
      if (!current()) return;
      final Future<void>? tail = _writeTails[store]?[key];
      if (tail != null) await tail;
      if (!current()) return;
      final String? raw = await store.read(key);
      if (!current()) return;
      _enabled = decodeWakeGestures(raw);
      sessionOnly = false;
    } catch (_) {
      if (!current()) return;
      sessionOnly = true;
    }
    notifyListeners();
  }

  void rebind({required String appId, required FeedbackServerPrefStore store}) {
    ++_identity;
    ++_revision;
    _appId = appId;
    _store = store;
    _enabled = <FeedbackWakeGesture>{};
    sessionOnly = false;
    unawaited(load());
  }

  void select(Set<FeedbackWakeGesture> enabled) {
    final int revision = ++_revision, identity = _identity;
    final String key = wakeGestureStorageKey(_appId);
    final FeedbackServerPrefStore store = _store;
    _enabled = Set<FeedbackWakeGesture>.of(enabled);
    final String value = encodeWakeGestures(_enabled);
    notifyListeners();
    // Keep writes ordered even if a platform backend finishes out of order.
    final Map<String, Future<void>> tails =
        _writeTails.putIfAbsent(store, () => <String, Future<void>>{});
    final Future<void> previous = tails[key] ?? Future<void>.value();
    final Completer<void> done = Completer<void>();
    tails[key] = done.future;
    unawaited(() async {
      bool persisted = false;
      try {
        await previous;
        if (_disposed || identity != _identity) return;
        await store.write(key, value);
        persisted = true;
      } catch (_) {
        // The in-memory choice remains active for this session.
      } finally {
        done.complete();
        if (identical(tails[key], done.future)) tails.remove(key);
        if (tails.isEmpty) _writeTails.remove(store);
        if (!_disposed && identity == _identity && revision == _revision) {
          sessionOnly = !persisted;
          notifyListeners();
        }
      }
    }());
  }

  @override
  void dispose() {
    _disposed = true;
    ++_identity;
    super.dispose();
  }
}

class _WakeTouch {
  _WakeTouch(this.start) : position = start;
  Offset start;
  Offset position;
}

/// Local RawGestureDetector recognizer. It joins only arenas from the host
/// slot's hit path. Pending two-finger input never accepts a scale/pinch on down.
/// Three fingers reserve their still-live arenas as soon as they arrive; any
/// rejectGesture marks the sequence defunct, so an already lost scroll cannot
/// be stolen back. Routes remain until up solely to drain that local sequence.
class FeedbackWakeGestureRecognizer extends OneSequenceGestureRecognizer {
  FeedbackWakeGestureRecognizer({super.debugOwner})
      : super(supportedDevices: <PointerDeviceKind>{PointerDeviceKind.touch});

  Set<FeedbackWakeGesture> _enabled = <FeedbackWakeGesture>{};
  set enabled(Set<FeedbackWakeGesture> value) {
    if (setEquals(_enabled, value)) return;
    cancel();
    _enabled = Set<FeedbackWakeGesture>.of(value);
  }

  bool Function()? isAvailable;
  ValueChanged<bool>? onReleaseHint;
  ValueChanged<Offset>? onWake;
  final Map<int, _WakeTouch> _touches = <int, _WakeTouch>{};
  final Set<int> _down = <int>{};
  final Set<int> _accepted = <int>{};
  final List<Timer> _timers = <Timer>[];
  Timer? _holdTimer;
  Timer? _betweenTimer;
  bool _failed = false;
  bool _ready = false;
  bool _hold = false;
  bool _swipe = false;
  bool _tap = false;
  bool _threeJoined = false;
  bool _lifting = false;
  bool _hint = false;
  Offset? _firstTapCenter;

  bool get _available => _enabled.isNotEmpty && (isAvailable?.call() ?? true);

  Timer _timer(int ms, VoidCallback callback) =>
      _schedule(Duration(milliseconds: ms), callback);

  // Deadline endpoints are inclusive: input at exactly 120/180/220ms etc.
  // is still eligible. The next microsecond expires the candidate.
  Timer _deadline(int ms, VoidCallback callback) =>
      _schedule(Duration(milliseconds: ms, microseconds: 1), callback);

  Timer _schedule(Duration duration, VoidCallback callback) {
    final Timer timer = Timer(duration, () {
      if (!_available) {
        cancel();
        return;
      }
      callback();
    });
    _timers.add(timer);
    return timer;
  }

  void _setHint(bool value) {
    if (_hint == value) return;
    _hint = value;
    onReleaseHint?.call(value);
  }

  void _clearTimers() {
    for (final Timer timer in _timers) {
      timer.cancel();
    }
    _timers.clear();
    _holdTimer = _betweenTimer = null;
  }

  void cancel() {
    _failed = true;
    _ready = false;
    _firstTapCenter = null;
    _clearTimers();
    _setHint(false);
    resolve(GestureDisposition.rejected);
    if (_down.isEmpty) _reset();
  }

  void _reset() {
    _clearTimers();
    _touches.clear();
    _accepted.clear();
    _failed = _ready = _threeJoined = _lifting = false;
    _hold = _swipe = _tap = false;
    _setHint(false);
  }

  void _begin() {
    _reset();
    _hold = _enabled.contains(FeedbackWakeGesture.twoFingerHold);
    _swipe = _enabled.contains(FeedbackWakeGesture.threeFingerSwipeUp);
    _tap = _enabled.contains(FeedbackWakeGesture.twoFingerDoubleTap);
    _deadline(120, () {
      if (_touches.length < 2) {
        _tap = false;
        _checkPossible();
      }
    });
    _deadline(180, () {
      if (_touches.length < 2) _hold = false;
      if (_touches.length < 3) _swipe = false;
      _checkPossible();
    });
    _deadline(220, () {
      _tap = false;
      _checkPossible();
    });
  }

  void _checkPossible() {
    if (!_ready && !_hold && !_swipe && !_tap) cancel();
  }

  @override
  bool isPointerAllowed(PointerDownEvent event) =>
      _available && super.isPointerAllowed(event);

  @override
  void handleNonAllowedPointer(PointerDownEvent event) {
    // Mouse/stylus events cannot join or disturb an active touch sequence.
  }

  @override
  void addAllowedPointer(PointerDownEvent event) {
    final Offset? first = _firstTapCenter;
    if (_down.isEmpty) {
      _betweenTimer?.cancel();
      _begin();
      _firstTapCenter = first;
    }
    startTrackingPointer(event.pointer, event.transform);
    _down.add(event.pointer);
    _touches[event.pointer] = _WakeTouch(event.position);
    if (_failed || _ready || _lifting || _touches.length > 3) {
      cancel();
      return;
    }
    if (_touches.length == 2) {
      if (_firstTapCenter != null &&
          (_centroid - _firstTapCenter!).distance > 32) {
        cancel();
        return;
      }
      if (_hold) {
        _holdTimer = _timer(700, () {
          if (!_failed && _down.length == 2 && _hold) {
            _recognize(showHint: true);
          }
        });
      }
    } else if (_touches.length == 3) {
      _hold = _tap = false;
      _holdTimer?.cancel();
      _firstTapCenter = null;
      if (!_swipe) {
        cancel();
        return;
      }
      // Pre-join movement only checks eligibility. Swipe thresholds start
      // together when all three fingers have arrived.
      for (final _WakeTouch touch in _touches.values) {
        touch.start = touch.position;
      }
      _threeJoined = true;
      _reserve();
      _deadline(700, () {
        if (!_ready) cancel();
      });
    }
  }

  Offset get _centroid =>
      _touches.values.fold<Offset>(
          Offset.zero, (Offset sum, _WakeTouch touch) => sum + touch.position) /
      _touches.length.toDouble();
  Offset get _translation =>
      _touches.values.fold<Offset>(
          Offset.zero,
          (Offset sum, _WakeTouch touch) =>
              sum + touch.position - touch.start) /
      _touches.length.toDouble();

  void _reserve() {
    resolve(GestureDisposition.accepted);
  }

  void _recognize({required bool showHint}) {
    if (_failed || !_available) {
      cancel();
      return;
    }
    _reserve();
    if (_failed) return;
    _ready = true;
    _clearTimers();
    _setHint(showHint);
  }

  @override
  void acceptGesture(int pointer) {
    _accepted.add(pointer);
  }

  @override
  void rejectGesture(int pointer) {
    _accepted.remove(pointer);
    if (!_failed) cancel();
  }

  void _move(_WakeTouch touch, Offset position) {
    touch.position = position;
    if (_failed || _ready) return;
    if (!_threeJoined) {
      if ((position - touch.start).distance > 12) {
        cancel();
      } else if (_touches.length == 2) {
        final List<_WakeTouch> pair = _touches.values.toList();
        final Offset originalSpan = pair[1].start - pair[0].start;
        final Offset currentSpan = pair[1].position - pair[0].position;
        if ((currentSpan - originalSpan).distance > 12) cancel();
      }
      return;
    }
    final Offset delta = _translation;
    if (_touches.values.any((_WakeTouch p) =>
            (p.position - p.start).dy > 12 ||
            (p.position.dx - p.start.dx).abs() > 64) ||
        delta.dx.abs() > 48) {
      cancel();
      return;
    }
    final double up = -delta.dy;
    if (up >= 72 &&
        delta.dx.abs() <= up * .6 &&
        _touches.values
            .every((_WakeTouch p) => p.start.dy - p.position.dy >= 48)) {
      _recognize(showHint: true);
    }
  }

  /// Local hit-test Listener runs before the pointer router's child tap
  /// callbacks. Reserve a valid two-finger tap on its first up so that a host
  /// button cannot fire before this recognizer gets that same up. No down or
  /// pinch is intercepted, and a single finger is always left to the host.
  void preparePointerUp(PointerUpEvent event) {
    if (!_available ||
        _failed ||
        _ready ||
        !_tap ||
        _touches.length != 2 ||
        !_down.contains(event.pointer)) {
      return;
    }
    _move(_touches[event.pointer]!, event.position);
    if (!_failed) _reserve();
  }

  @override
  void handleEvent(PointerEvent event) {
    if (!_down.contains(event.pointer)) {
      return;
    }
    if (!_available) cancel();
    final _WakeTouch touch = _touches[event.pointer]!;
    if (event is PointerMoveEvent || event is PointerUpEvent) {
      _move(touch, event.position);
    }
    if (event is PointerCancelEvent) cancel();
    if (event is! PointerUpEvent && event is! PointerCancelEvent) return;
    if (!_failed && !_ready) {
      _holdTimer?.cancel();
      _hold = _swipe = false;
      if (_tap && _touches.length == 2) {
        if (!_lifting) {
          _lifting = true;
          _reserve(); // a completed two-finger tap, never a pinch on down
          _deadline(100, cancel);
        }
      } else {
        cancel();
      }
    }
    _down.remove(event.pointer);
    stopTrackingPointer(event.pointer);
    if (_down.isNotEmpty) return;
    if (!_failed && _ready && _touches.keys.every(_accepted.contains)) {
      final Offset point = _centroid;
      _firstTapCenter = null;
      _reset();
      onWake?.call(point);
    } else if (!_failed &&
        _tap &&
        _touches.length == 2 &&
        _touches.keys.every(_accepted.contains)) {
      if (_firstTapCenter != null) {
        final Offset point = _centroid;
        if ((point - _firstTapCenter!).distance > 32) {
          cancel();
          return;
        }
        _firstTapCenter = null;
        _reset();
        onWake?.call(point);
      } else {
        final Offset point = _centroid;
        _reset();
        _firstTapCenter = point;
        _betweenTimer = _deadline(300, () {
          _firstTapCenter = null;
          _reset();
        });
      }
    } else {
      _firstTapCenter = null;
      _reset();
    }
  }

  @override
  void didStopTrackingLastPointer(int pointer) {
    // Round completion above owns state. Do not reset before the last up.
  }

  @override
  String get debugDescription => 'feedback wake gestures';

  @override
  void dispose() {
    onReleaseHint = null;
    onWake = null;
    _clearTimers();
    super.dispose();
  }
}
