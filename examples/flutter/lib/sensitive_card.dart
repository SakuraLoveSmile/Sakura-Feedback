import 'package:feedback_widget/feedback_widget.dart';
import 'package:flutter/material.dart';

/// 敏感信息演示卡片：整块包在 [FeedbackCaptureMask] 里。
///
/// 截图时该区域会被中性遮罩（#6E6E73）覆盖，用于验证宿主可以主动声明
/// 敏感区域，而不是让用户自己记得遮挡。
class SensitiveCard extends StatelessWidget {
  const SensitiveCard({
    super.key,
    required this.title,
    required this.value,
    this.note = '在灵感球截图中，此区域会被中性遮罩遮盖以保护隐私。',
  });

  /// 卡片标题。
  final String title;

  /// 卡片里展示的"敏感"内容。
  final String value;

  /// 补充说明。
  final String note;

  @override
  Widget build(BuildContext context) {
    return FeedbackCaptureMask(
      child: Card(
        elevation: 0,
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                '$title (FeedbackCaptureMask)',
                style: const TextStyle(fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 6),
              Text(
                note,
                style: const TextStyle(fontSize: 12, color: Colors.grey),
              ),
              const SizedBox(height: 8),
              Text(value, style: const TextStyle(fontFamily: 'monospace')),
            ],
          ),
        ),
      ),
    );
  }
}
