import 'package:flutter/material.dart';

/// 截图遮挡作用域：由每个 [FeedbackWidget] 实例独立持有并在其子树内提供。
///
/// [FeedbackCaptureMask] 注册到**最近**的截图作用域；同一作用域内的遮挡
/// 区域在该作用域对应的截图生成时生效。不同组件实例各自拥有独立作用域，
/// 因此互相不会遮挡，也不会影响彼此的注册状态。
class FeedbackCaptureScope {
  /// 仅供 [FeedbackWidget] 内部创建；宿主代码不应构造。
  FeedbackCaptureScope();

  final Map<Object, FeedbackCaptureMaskRecord> _records =
      <Object, FeedbackCaptureMaskRecord>{};

  /// 当前已注册的遮挡记录（只读视图）。
  Iterable<FeedbackCaptureMaskRecord> get records => _records.values;

  /// 注册遮挡记录。同一 owner 重复注册视为更新（幂等）。
  void register(Object owner, FeedbackCaptureMaskRecord record) {
    _records[owner] = record;
  }

  /// 注销遮挡记录。未注册时为安全空操作。
  void unregister(Object owner) {
    _records.remove(owner);
  }

  /// 返回 [context] 最近的截图作用域；不在任何组件子树内时返回 null。
  ///
  /// 只读查询，不建立依赖。遮挡层应通过 [dependOn] 建立依赖，
  /// 以便被移动到其他作用域时触发 `didChangeDependencies` 重新注册。
  static FeedbackCaptureScope? maybeOf(BuildContext context) {
    final FeedbackCaptureScopeWidget? widget =
        context.getInheritedWidgetOfExactType<FeedbackCaptureScopeWidget>();
    return widget?.scope;
  }

  /// 建立对最近截图作用域的依赖并返回它（遮挡层注册用）。
  static FeedbackCaptureScope? dependOn(BuildContext context) {
    final FeedbackCaptureScopeWidget? widget =
        context.dependOnInheritedWidgetOfExactType<FeedbackCaptureScopeWidget>();
    return widget?.scope;
  }
}

/// 一条已注册的遮挡区域记录（组件内部使用）。
class FeedbackCaptureMaskRecord {
  FeedbackCaptureMaskRecord._(this._state);

  final _FeedbackCaptureMaskState _state;

  /// 遮挡层的 BuildContext（用于截图时解析渲染对象几何）。
  BuildContext get context => _state.context;

  /// 遮罩颜色。截图绘制时使用其 RGB 并强制不透明。
  Color get maskColor => _state.widget.maskColor;
}

/// 内部 InheritedWidget：把 [FeedbackCaptureScope] 提供到组件子树。
/// 未从包导出，宿主代码不应直接使用。
class FeedbackCaptureScopeWidget extends InheritedWidget {
  /// 构造作用域提供者。
  const FeedbackCaptureScopeWidget({
    super.key,
    required this.scope,
    required super.child,
  });

  final FeedbackCaptureScope scope;

  @override
  bool updateShouldNotify(FeedbackCaptureScopeWidget oldWidget) =>
      !identical(scope, oldWidget.scope);
}

/// 标记截图脱敏区域的 Widget。
///
/// 在灵感球或主动截图时，被包裹区域在生成的位图上将被中性遮罩覆盖，
/// 保护敏感信息。遮罩必须位于某个 [FeedbackWidget] 子树内才会生效；
/// 被移动到另一个组件子树时会自动重新注册到新的作用域，销毁时注销。
///
/// ```dart
/// FeedbackCaptureMask(
///   child: TextField(obscureText: true, ...),
/// )
/// ```
class FeedbackCaptureMask extends StatefulWidget {
  /// 构造脱敏遮罩包裹层。
  const FeedbackCaptureMask({
    super.key,
    required this.child,
    this.maskColor = const Color(0xFF6E6E73),
  });

  /// 包含敏感信息的子 Widget。
  final Widget child;

  /// 遮罩颜色，默认中性灰（#6E6E73）。
  ///
  /// 截图绘制时仅取其 RGB 分量并强制完全不透明。
  final Color maskColor;

  @override
  State<FeedbackCaptureMask> createState() => _FeedbackCaptureMaskState();
}

class _FeedbackCaptureMaskState extends State<FeedbackCaptureMask> {
  FeedbackCaptureScope? _scope;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final FeedbackCaptureScope? scope = FeedbackCaptureScope.dependOn(context);
    if (!identical(scope, _scope)) {
      _scope?.unregister(this);
      _scope = scope;
      scope?.register(this, FeedbackCaptureMaskRecord._(this));
    }
  }

  @override
  void dispose() {
    _scope?.unregister(this);
    _scope = null;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
