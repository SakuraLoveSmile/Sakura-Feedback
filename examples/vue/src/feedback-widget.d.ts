import type { DefineComponent } from 'vue';

/** 让模板与 vue-tsc 认识 <feedback-widget> 元素及其受支持的 attributes。 */
declare module 'vue' {
  interface GlobalComponents {
    'feedback-widget': DefineComponent<{
      'api-base'?: string;
      'app-id'?: string;
      'app-version'?: string;
      'page-label'?: string;
      side?: 'left' | 'right';
      theme?: 'system' | 'light' | 'dark';
      'show-launcher'?: 'true' | 'false';
      'launcher-bottom'?: string;
      /** `auto`（默认，按输入能力：精细指针用贴边标签，触屏走光束）| `beam` | `tab` | `orb`。 */
      'launcher-mode'?: 'auto' | 'beam' | 'tab' | 'orb';
      /** `off`（默认）| `viewport`（呼出时截取当前应用视口）。 */
      'capture-mode'?: 'off' | 'viewport';
    }>;
  }
}

export {};
