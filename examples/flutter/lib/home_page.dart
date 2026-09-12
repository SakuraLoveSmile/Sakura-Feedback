import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';

import 'details_page.dart';
import 'host_dialog.dart';
import 'host_logs.dart';
import 'sensitive_card.dart';

/// 第一个路由：演示从宿主代码主动呼出反馈面板。
///
/// [controller] 由应用根拥有并传入，本页面自己**不**创建也不释放它。
class HomePage extends StatelessWidget {
  const HomePage({super.key, required this.controller});

  /// 应用根持有的控制器。
  final FeedbackController controller;

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
                '右下角为灵感球，拖动到界面任意位置松手即可截图并反馈。',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 16),
              ),
              const SizedBox(height: 8),
              const Text(
                '组件挂在 Navigator 之上：切到第二个路由、或打开宿主对话框，'
                '灵感球都还在场，草稿与登录状态也不会因导航丢失。',
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
                ],
              ),
              const SizedBox(height: 32),
              const _HostLogCard(),
              const SizedBox(height: 24),
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

/// 宿主日志演示区：展示"宿主已有日志系统 → logProvider 自动采集"的闭环。
///
/// 这里的按钮就是示例里的**自动日志触发入口**：写一条运行日志后，
/// 打开反馈面板（新草稿首次打开）即可在面板里看到自动附加的
/// `host-app.log`（内容取自环形缓冲，导出前由宿主脱敏）。
class _HostLogCard extends StatelessWidget {
  const _HostLogCard();

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: ListenableBuilder(
          listenable: hostLogs,
          builder: (BuildContext context, Widget? _) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text('宿主日志（内存环形缓冲）',
                    style: Theme.of(context).textTheme.titleSmall),
                const SizedBox(height: 6),
                Text(
                  '当前缓冲 ${hostLogs.length} / ${hostLogs.capacity} 行；'
                  '打开反馈面板时会自动导出为 host-app.log 交给组件'
                  '（3 秒超时，失败可用面板内的「重试」）。',
                  key: const Key('feedback-example-log-summary'),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 12,
                  runSpacing: 8,
                  children: <Widget>[
                    OutlinedButton.icon(
                      key: const Key('feedback-example-log-append'),
                      onPressed: () => hostLogs.info('手动写入一条演示日志'),
                      icon: const Icon(Icons.playlist_add, size: 18),
                      label: const Text('写入一条运行日志'),
                    ),
                    OutlinedButton.icon(
                      key: const Key('feedback-example-log-clear'),
                      onPressed: hostLogs.clear,
                      icon: const Icon(Icons.clear_all, size: 18),
                      label: const Text('清空宿主日志'),
                    ),
                  ],
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}
