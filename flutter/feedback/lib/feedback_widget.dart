/// 个人反馈组件（feedback_widget）。
///
/// 将 Feedback 服务的反馈提交能力嵌入 Flutter 应用：
/// 悬浮按钮 + 响应式面板 + 面板内登录（Web / 原生共用表单）+ 状态轮询。
///
/// 快速上手：
///
/// ```dart
/// FeedbackWidget(
///   config: FeedbackConfig(
///     'https://fb.example.com',
///     'com.example.app',
///     appVersion: '1.2.3',
///   ),
///   child: MyApp(),
/// )
/// ```
library;

export 'src/api_client.dart'
    show
        ApiException,
        ApiClient,
        FeedbackCaptureInfo,
        FeedbackSubmitResult,
        FeedbackRecord,
        LoginResult;
export 'src/capture_mask.dart' show FeedbackCaptureMask;
export 'src/config.dart'
    show
        FeedbackConfig,
        FeedbackCaptureMode,
        FeedbackLauncherMode,
        FeedbackSide,
        FeedbackThemeMode;
export 'src/controller.dart' show FeedbackController;
export 'src/idempotency.dart' show generateFeedbackIdempotencyKey;
export 'src/panel.dart'
    show FeedbackPanel, FeedbackPanelState, FeedbackStage, kFeedbackMaxTextRunes;
export 'src/token_store.dart'
    show FeedbackTokenStore, MemoryTokenStore, feedbackTokenStorageKey;
export 'src/widget.dart'
    show FeedbackWidget, kFeedbackWideBreakpoint, kFeedbackPanelWidth;
