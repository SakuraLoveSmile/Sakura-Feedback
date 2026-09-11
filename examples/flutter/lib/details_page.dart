import 'package:flutter/material.dart';

import 'sensitive_card.dart';

/// 第二个路由：证明灵感球与反馈面板在导航之后依然在场。
///
/// 它由 `MaterialApp.routes` 表登记，交给应用根的 `FeedbackWidget` 覆盖；
/// 本页面不需要（也无法）自己挂载组件。
class DetailsPage extends StatelessWidget {
  const DetailsPage({super.key});

  /// 命名路由名（同时作为 pageLabel 上报）。
  static const String routeName = '/details';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('第二个路由')),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              const Icon(Icons.check_circle_outline,
                  size: 48, color: Colors.green),
              const SizedBox(height: 16),
              const Text(
                '这是第二个路由。右下角灵感球仍然在，'
                '点它 / 拖它就能在当前页面截图并反馈。',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 16),
              ),
              const SizedBox(height: 8),
              const Text(
                '因为组件挂在 Navigator 之上，页面被 push/pop 时组件实例不会被重建，'
                '已输入的草稿与截图也就不会丢。',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.grey),
              ),
              const SizedBox(height: 24),
              FilledButton.icon(
                onPressed: () => Navigator.of(context).maybePop(),
                icon: const Icon(Icons.arrow_back),
                label: const Text('返回第一页'),
              ),
              const SizedBox(height: 32),
              const SensitiveCard(
                title: '第二个路由上的敏感区',
                value: '邮箱：demo@example.com',
                note: '遮罩随页面走：任何路由下的敏感区域都会在截图中被覆盖。',
              ),
            ],
          ),
        ),
      ),
    );
  }
}
