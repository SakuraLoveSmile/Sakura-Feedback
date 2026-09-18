import type { FeedbackWidget } from "@feedback/web";
import type * as React from "react";

declare global {
  /** 构建期注入的管理端版本号（vite.config.ts define）。 */
  const __ADMIN_VERSION__: string;
}

/** 让 JSX 认识 <feedback-widget> 元素及其全部受支持 attributes。 */
type FeedbackWidgetAttributes = React.DetailedHTMLProps<
  React.HTMLAttributes<FeedbackWidget> & {
    "api-base"?: string;
    "app-id"?: string;
    "app-version"?: string;
    "page-label"?: string;
    side?: "left" | "right";
    theme?: "system" | "light" | "dark";
    /** 字符串属性：只有 "false" 表示隐藏入口，其余值（含缺省）为显示。 */
    "show-launcher"?: "true" | "false";
    /** 入口垂直位置，百分比或像素，默认 '25%'。 */
    "launcher-bottom"?: string;
    /** 默认 'tab'（贴边标签）；'orb' 为灵感球（可拖拽指出位置并截图）。 */
    "launcher-mode"?: "tab" | "orb";
    /** 默认 'off'；'viewport' 为呼出时截取当前应用视口。 */
    "capture-mode"?: "off" | "viewport";
  },
  FeedbackWidget
>;

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "feedback-widget": FeedbackWidgetAttributes;
    }
  }
}
