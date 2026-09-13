// 令牌存储协调层（包内部实现，不属于公开 API）。
//
// T1-A：认证请求的 401 处理必须基于**请求发出时实际使用的令牌与认证世代**
// 做条件清除，而不是在响应到达后清除 store 里的「当前」令牌——否则旧请求
// 的迟到 401 会把用户重新登录保存的新令牌误删（把新账号退出登录）。
//
// 协调层提供两件能力：
// - **操作队列**：登录写入与 401 条件清除串行执行，比较与删除之间不允许
//   新的登录写入插队；
// - **认证世代**：每次成功写入 / 清除后递增。请求发出前捕获
//   `(token, generation)`；401 时仅当世代仍是当前世代、且 store 里的令牌
//   未被更换时才清除并通知界面。
//
// 共享粒度：默认安全存储（`SecureFeedbackTokenStore`）按存储键（服务身份
// `apiBase`+`appId` 派生）共享同一协调器——同身份的多个仓库实例看到同一份
// 世代与队列；其余仓库（宿主自定义实现 / 测试内存仓库）按实例共享。宿主
// 无需修改自定义存储实现。
import 'platform_io.dart';
import 'token_store.dart';

/// 一次认证请求发出前捕获的令牌及其认证世代。
class TokenLease {
  const TokenLease._(this.token, this.generation);

  /// 请求实际携带的令牌（可能为 null：未登录时的匿名请求）。
  final String? token;

  /// 捕获时刻的认证世代。
  final int generation;
}

/// 包装任意 [FeedbackTokenStore]，为其叠加操作队列与认证世代协调。
///
/// 通过 [CoordinatedTokenStore.of] 获取（幂等）：同一底层仓库永远映射到
/// 同一协调器实例。对调用方而言它仍是普通 [FeedbackTokenStore]。
class CoordinatedTokenStore implements FeedbackTokenStore {
  CoordinatedTokenStore._(this._inner);

  static final Map<Object, CoordinatedTokenStore> _registry =
      <Object, CoordinatedTokenStore>{};

  /// 返回与 [inner] 对应的协调器（已协调则原样返回）。
  ///
  /// 默认安全存储按存储键（服务身份）共享；其余仓库按实例共享。
  factory CoordinatedTokenStore.of(FeedbackTokenStore inner) {
    if (inner is CoordinatedTokenStore) return inner;
    final Object identity =
        inner is SecureFeedbackTokenStore ? inner.storageKey : inner;
    return _registry.putIfAbsent(
      identity,
      () => CoordinatedTokenStore._(inner),
    );
  }

  final FeedbackTokenStore _inner;

  /// 存储操作队列：read / write / clear 全部串行，保证「比较与删除」
  /// 之间不会有新的登录写入插队。
  Future<void> _queue = Future<void>.value();

  /// 认证世代：每次成功写入 / 清除后递增。
  int _generation = 0;

  Future<T> _enqueue<T>(Future<T> Function() op) {
    final Future<T> run = _queue.then((_) => op());
    // 队列吞掉单次操作的错误继续运转（调用方仍会收到该错误）。
    _queue = run.then((_) {}, onError: (Object _) {});
    return run;
  }

  /// 捕获请求使用的令牌与当前认证世代（在操作队列内执行）。
  Future<TokenLease> lease() => _enqueue(() async {
        final String? token = await _inner.read();
        return TokenLease._(token, _generation);
      });

  /// 仅当 [lease] 仍属于当前认证世代、且 store 中的令牌未被更换时清除。
  ///
  /// 返回是否实际清除：`true` 才允许触发 onUnauthorized（回到登录态）；
  /// `false` 表示请求已过期（期间发生了新登录 / 清除），调用方只向原调用
  /// 者抛错，绝不清除新凭据、绝不退出当前登录。
  Future<bool> clearIfCurrent(TokenLease lease) => _enqueue(() async {
        if (lease.generation != _generation) return false;
        final String? current = await _inner.read();
        if (current != lease.token) return false;
        await _inner.clear();
        _generation++;
        return true;
      });

  @override
  Future<String?> read() => _enqueue(_inner.read);

  @override
  Future<void> write(String token) => _enqueue(() async {
        await _inner.write(token);
        _generation++; // 新登录保存成功：递增认证世代
      });

  @override
  Future<void> clear() => _enqueue(() async {
        await _inner.clear();
        _generation++;
      });
}
