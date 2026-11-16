import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'server_pref.dart';

/// Internal preference; independent from server URLs and wake gesture choices.
///
/// `hidden` 是 v0.8.2 新增、v0.8.5 澄清语义的第三种待机样式：只隐藏「待机
/// （收起）状态」——收起后不渲染任何入口；完整球（初始 / 唤醒后 / 面板关闭
/// 后）仍正常显示。已开启的唤醒手势仍可唤醒它，唤醒后闲置 5 秒再次进入待机
/// 隐藏。未开启手势时宿主始终可用 `controller.open()` 打开面板并改回其他
/// 样式（宿主托管时由宿主设置页改写）。旧版本只认识 `handle` / `edge`，未知
/// 值一律回退默认。
enum FeedbackOrbIdleStyle { handle, edge, hidden }

String orbIdleStorageKey(String appId) =>
    'feedback:orb-idle:v1:${Uri.encodeComponent(appId)}';

FeedbackOrbIdleStyle decodeOrbIdleStyle(String? value) {
  try {
    final Object? json = value == null ? null : jsonDecode(value);
    if (json is Map<String, dynamic> &&
        json['version'] == 1 &&
        json['style'] is String) {
      final String style = json['style'] as String;
      for (final FeedbackOrbIdleStyle candidate
          in FeedbackOrbIdleStyle.values) {
        if (candidate.name == style) return candidate;
      }
    }
  } on FormatException {/* Invalid values use the default. */}
  return FeedbackOrbIdleStyle.handle;
}

String encodeOrbIdleStyle(FeedbackOrbIdleStyle style) =>
    jsonEncode(<String, Object>{'version': 1, 'style': style.name});

/// Root-owned preferences: reads start before the panel exists. A selection
/// invalidates the pending read; a rebind invalidates old identity operations.
class FeedbackOrbIdlePreferences extends ChangeNotifier {
  FeedbackOrbIdlePreferences(
      {required String appId, required FeedbackServerPrefStore store})
      : _appId = appId,
        _store = store;
  String _appId;
  FeedbackServerPrefStore _store;
  FeedbackOrbIdleStyle _style = FeedbackOrbIdleStyle.handle;
  bool sessionOnly = false;
  int _identity = 0;
  int _revision = 0;
  bool _disposed = false;
  final Map<FeedbackServerPrefStore, Map<String, Future<void>>> _writeTails =
      Map<FeedbackServerPrefStore, Map<String, Future<void>>>.identity();

  FeedbackOrbIdleStyle get style => _style;

  Future<void> load() async {
    final int identity = _identity, revision = _revision;
    final String key = orbIdleStorageKey(_appId);
    final FeedbackServerPrefStore store = _store;
    bool current() =>
        !_disposed && identity == _identity && revision == _revision;
    try {
      // A -> B -> A can return while A's earlier write is still running.
      // Read that same backend/key only after its ordered writes settle.
      if (!current()) return;
      final Future<void>? tail = _writeTails[store]?[key];
      if (tail != null) await tail;
      if (!current()) return;
      final String? raw = await store.read(key);
      if (!current()) return;
      _style = decodeOrbIdleStyle(raw);
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
    _style = FeedbackOrbIdleStyle.handle;
    sessionOnly = false;
    unawaited(load());
  }

  void select(FeedbackOrbIdleStyle style) {
    final int revision = ++_revision, identity = _identity;
    final String key = orbIdleStorageKey(_appId);
    final FeedbackServerPrefStore store = _store;
    _style = style;
    final String value = encodeOrbIdleStyle(_style);
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
