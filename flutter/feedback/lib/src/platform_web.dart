// Web 平台实现：令牌仅存内存；登录走契约「Web 登录握手时序」——
// window.open 弹出 <apiBase>/login?appId=..&nonce=..&cb=..，
// 监听 postMessage 并严格校验 origin + type + nonce，拿到短期令牌。
import 'dart:async';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

import 'config.dart';
import 'idempotency.dart';
import 'token_store.dart';
import 'web_handshake.dart';

/// Web 默认仓库：仅内存（刷新后需重新握手；服务侧 Cookie 会话可静默续期）。
///
/// 内存仓库不跨服务持久化，故无需按 [config] 派生存储键；参数与原生实现
/// 保持一致，便于同一调用点（[createDefaultTokenStore]）条件导入。
FeedbackTokenStore createDefaultTokenStore(FeedbackConfig config) =>
    MemoryTokenStore();

/// 打开登录弹窗并等待握手 postMessage（严格校验后才 resolve）。
Future<WebHandshakeResult> startWebLoginHandshake({
  required String apiBase,
  required String appId,
  Duration timeout = const Duration(minutes: 5),
}) async {
  final Uri serviceUri;
  try {
    serviceUri = Uri.parse(apiBase);
  } on FormatException {
    return const WebHandshakeResult.fail('服务地址无效');
  }
  final String serviceOrigin = serviceUri.origin;
  final String hostOrigin = web.window.location.origin;
  final String nonce = generateFeedbackIdempotencyKey();
  final String url = '$apiBase/login'
      '?appId=${Uri.encodeComponent(appId)}'
      '&nonce=${Uri.encodeComponent(nonce)}'
      '&cb=${Uri.encodeComponent(hostOrigin)}';

  final web.Window? popup =
      web.window.open(url, 'feedback_login', 'popup=1,width=420,height=680');
  if (popup == null) {
    return const WebHandshakeResult.blocked();
  }

  final Completer<WebHandshakeResult> completer =
      Completer<WebHandshakeResult>();
  late final JSFunction listener;
  Timer? timeoutTimer;
  Timer? closeWatch;

  void finish(WebHandshakeResult result) {
    if (completer.isCompleted) return;
    web.window.removeEventListener('message', listener);
    closeWatch?.cancel();
    timeoutTimer?.cancel();
    completer.complete(result);
  }

  void handleMessage(web.Event event) {
    if (event.type != 'message') return;
    final web.MessageEvent message = event as web.MessageEvent;
    // 严格校验：来源必须是服务 origin（契约第 5 步）。
    if (message.origin != serviceOrigin) return;
    final Object? data = message.data.dartify();
    if (data is! Map) return;
    final Object? type = data['type'];
    if (type != 'feedback:auth') return;
    final Object? msgNonce = data['nonce'];
    if (msgNonce != nonce) return; // nonce 不匹配：丢弃
    final Object? token = data['accessToken'];
    if (token is! String || token.isEmpty) return;
    final Object? rawExpiry = data['expiresAt'];
    finish(WebHandshakeResult.ok(
      token,
      expiresAt: rawExpiry is String ? DateTime.tryParse(rawExpiry) : null,
    ));
  }

  listener = handleMessage.toJS;
  web.window.addEventListener('message', listener);
  timeoutTimer =
      Timer(timeout, () => finish(const WebHandshakeResult.fail('登录超时，请重试')));
  // 用户直接关闭登录窗口而未完成握手时，及时结束等待。
  closeWatch = Timer.periodic(const Duration(milliseconds: 700), (Timer t) {
    if (popup.closed) {
      finish(const WebHandshakeResult.fail('登录窗口已关闭，请重试'));
    }
  });
  return completer.future;
}
