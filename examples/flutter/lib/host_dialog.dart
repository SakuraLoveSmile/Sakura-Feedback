import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';

/// 对话框演示区的固定颜色。
///
/// 取一个 Material 默认主题里不会出现的颜色，测试才能用像素断言
/// "对话框确实进入了截图"（见 test/widget_test.dart）。
const Color kHostDialogDemoColor = Color(0xFF12E5A0);

/// 打开一个"宿主自己的"对话框。
///
/// 用途：演示**截图范围是当前应用视口**——对话框是宿主 UI，会出现在截图里；
/// 而反馈面板本身（挂在 Navigator 之上）不属于宿主内容，永远不入图。
Future<void> showHostDialog(BuildContext context) {
  return showDialog<void>(
    context: context,
    // 组件挂在应用 Navigator 之上，而 showDialog 默认走 rootNavigator：
    // 在本示例里 root 就是承载组件的那层外层 Navigator（见 lib/main.dart），
    // 对话框会被推到组件**上方**——既压住灵感球，也不会进入截图。
    // 宿主要"自己的"对话框就显式用 useRootNavigator: false，
    // 落到应用自己的 Navigator 里，才算宿主内容。
    useRootNavigator: false,
    builder: (BuildContext context) {
      return AlertDialog(
        title: const Text('宿主对话框'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            const Text(
              '这个对话框属于宿主 UI。此时点/拖灵感球截图，'
              '对话框会出现在截图里，反馈面板自己不会。',
              style: TextStyle(fontSize: 13),
            ),
            const SizedBox(height: 12),
            Container(
              key: const Key('feedback-example-dialog-swatch'),
              height: 120,
              color: kHostDialogDemoColor,
            ),
            const SizedBox(height: 12),
            const FeedbackCaptureMask(
              child: Text(
                '对话框内的敏感行：6222 0000 1234 5678（会被遮罩）',
                style: TextStyle(fontFamily: 'monospace', fontSize: 12),
              ),
            ),
          ],
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('关闭'),
          ),
        ],
      );
    },
  );
}
