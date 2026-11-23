import 'dart:async';
import 'package:flutter/foundation.dart';

import 'server_pref.dart';

/// 终端用户的入口样式偏好；宿主 `launcherMode=tab/orb` 时以宿主为准。
enum FeedbackLauncherStyle { beam, orb }

String launcherStyleStorageKey(String appId) =>
    'feedback:launcher-style:v1:${Uri.encodeComponent(appId)}';

FeedbackLauncherStyle decodeLauncherStyle(String? value) =>
    value?.trim() == 'orb' ? FeedbackLauncherStyle.orb : FeedbackLauncherStyle.beam;

String encodeLauncherStyle(FeedbackLauncherStyle style) => style.name;

/// 与 [FeedbackOrbIdlePreferences] 相同的读写与身份隔离模型。
class FeedbackLauncherStylePreferences extends ChangeNotifier {
  FeedbackLauncherStylePreferences(
      {required String appId, required FeedbackServerPrefStore store})
      : _appId = appId,
        _store = store;
  String _appId;
  FeedbackServerPrefStore _store;
  FeedbackLauncherStyle _style = FeedbackLauncherStyle.beam;
  bool sessionOnly = false;
  int _identity = 0;
  int _revision = 0;
  bool _disposed = false;
  final Map<FeedbackServerPrefStore, Map<String, Future<void>>> _writeTails =
      Map<FeedbackServerPrefStore, Map<String, Future<void>>>.identity();

  FeedbackLauncherStyle get style => _style;

  Future<void> load() async {
    final int identity = _identity, revision = _revision;
    final String key = launcherStyleStorageKey(_appId);
    final FeedbackServerPrefStore store = _store;
    bool current() =>
        !_disposed && identity == _identity && revision == _revision;
    try {
      if (!current()) return;
      final Future<void>? tail = _writeTails[store]?[key];
      if (tail != null) await tail;
      if (!current()) return;
      final String? raw = await store.read(key);
      if (!current()) return;
      _style = decodeLauncherStyle(raw);
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
    _style = FeedbackLauncherStyle.beam;
    sessionOnly = false;
    unawaited(load());
  }

  void select(FeedbackLauncherStyle style) {
    final int revision = ++_revision, identity = _identity;
    final String key = launcherStyleStorageKey(_appId);
    final FeedbackServerPrefStore store = _store;
    _style = style;
    final String value = encodeLauncherStyle(style);
    notifyListeners();
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
