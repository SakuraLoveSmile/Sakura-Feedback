import {
  FeedbackWidget,
  type FeedbackSubmittedDetail,
  type FeedbackLogFile,
  type FeedbackLogProvider,
} from './element';

export { FeedbackWidget };
export type { FeedbackSubmittedDetail, FeedbackLogFile, FeedbackLogProvider };
export type {
  FeedbackStatus,
  FeedbackContext,
  FeedbackRecord,
  FeedbackCaptureInfo,
  FeedbackLogAttachment,
  FeedbackSubmitPayload,
  FeedbackSubmitResponse,
  AuthUser,
  Quota,
  LoginResponse,
  SessionResponse,
} from './api';
export { normalizeServerBase } from './server_pref';
export type { NormalizeServerBaseResult } from './server_pref';

/** 元素标签名。 */
export const FEEDBACK_ELEMENT_TAG = 'feedback-widget';

/** 幂等注册自定义元素（多次 import 安全）。 */
export function defineFeedbackWidget(tag: string = FEEDBACK_ELEMENT_TAG): typeof FeedbackWidget {
  if (typeof customElements !== 'undefined' && !customElements.get(tag)) {
    customElements.define(tag, FeedbackWidget);
  }
  return FeedbackWidget;
}

// 模块导入即自动定义元素；IIFE/UMD `<script>` 加载同理由顶层副作用完成注册。
defineFeedbackWidget();

export interface OpenFeedbackOptions {
  apiBase?: string;
  appId?: string;
  appVersion?: string;
  pageLabel?: string;
  side?: 'left' | 'right';
  theme?: 'system' | 'light' | 'dark';
  showLauncher?: boolean;
  launcherBottom?: string;
  launcherMode?: 'tab' | 'orb';
  captureMode?: 'off' | 'viewport';
  logProvider?: import('./element').FeedbackLogProvider;
}

/**
 * 打开页面上的反馈面板；若尚无 `<feedback-widget>` 元素则动态创建。
 * 传入 options 时同步配置到（新建的或已有的）元素上。
 */
export function openFeedback(options: OpenFeedbackOptions = {}): FeedbackWidget {
  defineFeedbackWidget();
  let widget = document.querySelector(FEEDBACK_ELEMENT_TAG) as FeedbackWidget | null;
  if (!widget) {
    widget = document.createElement(FEEDBACK_ELEMENT_TAG) as FeedbackWidget;
    if (options.apiBase) widget.apiBase = options.apiBase;
    if (options.appId) widget.appId = options.appId;
    if (options.appVersion) widget.appVersion = options.appVersion;
    if (options.pageLabel) widget.pageLabel = options.pageLabel;
    if (options.side) widget.side = options.side;
    if (options.theme) widget.theme = options.theme;
    if (options.showLauncher !== undefined) widget.showLauncher = options.showLauncher;
    if (options.launcherBottom) widget.launcherBottom = options.launcherBottom;
    if (options.launcherMode) widget.launcherMode = options.launcherMode;
    if (options.captureMode) widget.captureMode = options.captureMode;
    if (options.logProvider !== undefined) widget.logProvider = options.logProvider;
    document.body.appendChild(widget);
  } else {
    if (options.apiBase) widget.apiBase = options.apiBase;
    if (options.appId) widget.appId = options.appId;
    if (options.appVersion !== undefined) widget.appVersion = options.appVersion;
    if (options.pageLabel !== undefined) widget.pageLabel = options.pageLabel;
    if (options.side) widget.side = options.side;
    if (options.theme) widget.theme = options.theme;
    if (options.showLauncher !== undefined) widget.showLauncher = options.showLauncher;
    if (options.launcherBottom) widget.launcherBottom = options.launcherBottom;
    if (options.launcherMode) widget.launcherMode = options.launcherMode;
    if (options.captureMode) widget.captureMode = options.captureMode;
    if (options.logProvider !== undefined) widget.logProvider = options.logProvider;
  }
  widget.open();
  return widget;
}

