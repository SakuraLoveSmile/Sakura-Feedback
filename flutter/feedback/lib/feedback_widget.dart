/// 个人反馈组件（feedback_widget）。
///
/// 将 Feedback 服务的反馈提交能力嵌入 Flutter 应用：
/// 悬浮按钮 + 响应式面板 + 登录（原生表单 / Web 弹窗握手）+ 状态轮询。
///
/// 快速上手：
///
/// ```dart
/// FeedbackWidget(
///   config: FeedbackConfig(
///     'https://fb.example.com',
///     'com.example.app',
///     appVersion: '1.2.3',
///     // 可选：新草稿首次打开面板时自动采集宿主日志（3 秒超时）。
///     logProvider: () async => <FeedbackLogFile>[
///       FeedbackLogFile(name: 'app.log', bytes: myLogBytes),
///     ],
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
        FeedbackLogFile,
        FeedbackLogProvider,
        FeedbackSide,
        FeedbackThemeMode;
export 'src/controller.dart' show FeedbackController;
export 'src/idempotency.dart' show generateFeedbackIdempotencyKey;
export 'src/logs.dart'
    show
        FeedbackLogAttachment,
        FeedbackLogFilePicker,
        FeedbackLogSource,
        kFeedbackLogExtensions,
        kFeedbackLogPreviewMaxRunes,
        kFeedbackMaxLogBytes,
        kFeedbackMaxLogs,
        pickFeedbackLogFiles,
        validateFeedbackLogFile;
export 'src/panel.dart'
    show FeedbackPanel, FeedbackPanelState, FeedbackStage, kFeedbackMaxTextRunes;
export 'src/token_store.dart'
    show FeedbackTokenStore, MemoryTokenStore, feedbackTokenStorageKey;
export 'src/web_handshake.dart' show WebHandshakeResult;
export 'src/widget.dart'
    show FeedbackWidget, kFeedbackWideBreakpoint, kFeedbackPanelWidth;
