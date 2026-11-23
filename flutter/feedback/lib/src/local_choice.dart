import 'dart:async';
import 'package:flutter/foundation.dart';

import 'server_pref.dart';

class LocalChoicePreferences<T extends Enum> extends ChangeNotifier {
  LocalChoicePreferences(
      {required String appId,
      required FeedbackServerPrefStore store,
      required this.values,
      required this.storageKey})
      : _appId = appId,
        _store = store;
  String _appId;
  FeedbackServerPrefStore _store;
  final List<T> values;
  final String Function(String) storageKey;
  late T _visual = values.first;
  bool sessionOnly = false;
  int _identity = 0;
  int _revision = 0;
  bool _disposed = false;
  final Map<FeedbackServerPrefStore, Map<String, Future<void>>> _writeTails =
      Map<FeedbackServerPrefStore, Map<String, Future<void>>>.identity();

  T get visual => _visual;

  Future<void> load() async {
    final int identity = _identity, revision = _revision;
    final String key = storageKey(_appId);
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
      _visual = values.firstWhere((v) => v.name == raw?.trim(),
          orElse: () => values.first);
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
    _visual = values.first;
    sessionOnly = false;
    unawaited(load());
  }

  void select(T visual) {
    final int revision = ++_revision, identity = _identity;
    final String key = storageKey(_appId);
    final FeedbackServerPrefStore store = _store;
    _visual = visual;
    final String value = visual.name;
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
