import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';

import 'details_page.dart';
import 'host_dialog.dart';
import 'sensitive_card.dart';

/// 第一个路由：演示从宿主代码主动呼出反馈面板。
///
/// [controller] 由应用根拥有并传入，本页面自己**不**创建也不释放它。
class HomePage extends StatelessWidget {
  const HomePage({
    super.key,
    required this.controller,
    this.onOpenHostSettings,
  });

  /// 应用根持有的控制器。
  final FeedbackController controller;

  /// 打开发送宿主设置页（v0.11.0 托管用法）；由应用根提供，改选后由根
  /// 重建 [FeedbackWidget] 生效。省略时该入口不可用。
  final VoidCallback? onOpenHostSettings;

  /// 命名路由名（同时作为 pageLabel 上报）。
  static const String routeName = '/';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('feedback_widget 结构示例')),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              const Text(
                '双指长按 700ms 可唤醒反馈，拖到问题处松手即可选区。'
                '入口样式与动效由「宿主设置」统一管理：改选后组件按新值重建，'
                '反馈面板里只保留服务器设置。',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 16),
              ),
              const SizedBox(height: 8),
              const Text(
                '组件挂在 Navigator 之上：切到第二个路由、或打开宿主对话框，'
                '同一手势仍可在当前页面唤醒，草稿与登录状态也不会因导航丢失。',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.grey),
              ),
              const SizedBox(height: 24),
              Wrap(
                spacing: 12,
                runSpacing: 12,
                alignment: WrapAlignment.center,
                children: <Widget>[
                  FilledButton.icon(
                    onPressed: controller.open,
                    icon: const Icon(Icons.edit_note_outlined),
                    label: const Text('纯文本打开'),
                  ),
                  FilledButton.tonalIcon(
                    onPressed: () => controller.captureAndOpen(),
                    icon: const Icon(Icons.camera_alt_outlined),
                    label: const Text('截图并打开'),
                  ),
                  OutlinedButton.icon(
                    onPressed: () =>
                        Navigator.of(context).pushNamed(DetailsPage.routeName),
                    icon: const Icon(Icons.arrow_forward_outlined),
                    label: const Text('打开第二个路由'),
                  ),
                  OutlinedButton.icon(
                    onPressed: () => showHostDialog(context),
                    icon: const Icon(Icons.open_in_new_outlined),
                    label: const Text('打开宿主对话框'),
                  ),
                  OutlinedButton.icon(
                    onPressed: onOpenHostSettings,
                    icon: const Icon(Icons.tune_outlined),
                    label: const Text('宿主设置'),
                  ),
                ],
              ),
              const SizedBox(height: 32),
              const SensitiveCard(
                title: '敏感数据保护演示区',
                value: '卡号：6222 0000 1234 5678',
              ),
            ],
          ),
        ),
      ),
    );
  }
}
