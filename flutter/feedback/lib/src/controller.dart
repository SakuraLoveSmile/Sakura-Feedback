import 'dart:ui' show Offset;

import 'package:flutter/foundation.dart';

/// 主动呼出 / 收起反馈面板与截图触发的控制器。
///
/// 传给 [FeedbackWidget]（见 `feedback_widget.dart`）后即可在宿主代码中调用
/// [open] / [close] / [captureAndOpen] / [cancelCapture]；不传时组件内部自动创建。
class FeedbackController extends ChangeNotifier {
  bool _isOpen = false;

  /// 截图并呼出面板的底层委托函数（由 [FeedbackWidget] 绑定）。
  Future<void> Function({Offset? releasePoint})? onCaptureAndOpen;

  /// 取消截图与拖拽的底层委托函数（由 [FeedbackWidget] 绑定）。
  void Function()? onCancelCapture;

  /// 面板当前是否展开。
  bool get isOpen => _isOpen;

  /// 展开反馈面板。
  void open() {
    if (_isOpen) return;
    _isOpen = true;
    notifyListeners();
  }

  /// 收起反馈面板。
  ///
  /// 即使面板当前未展开也总是通知监听者：宿主在捕获进行中调用 [close]
  /// 时（面板可能尚未展开），组件依赖该通知使进行中的捕获会话失效。
  void close() {
    _isOpen = false;
    notifyListeners();
  }

  /// 截取宿主当前视口完整截图并打开反馈面板。
  Future<void> captureAndOpen({Offset? releasePoint}) async {
    if (onCaptureAndOpen != null) {
      await onCaptureAndOpen!(releasePoint: releasePoint);
    } else {
      open();
    }
  }

  /// 取消当前截图或拖拽状态。
  void cancelCapture() {
    onCancelCapture?.call();
  }

  /// 切换展开 / 收起。
  void toggle() {
    if (_isOpen) {
      close();
    } else {
      open();
    }
  }
}
