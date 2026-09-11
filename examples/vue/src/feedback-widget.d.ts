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
      /** `tab`（默认，贴边标签）| `orb`（灵感球）。 */
      'launcher-mode'?: 'tab' | 'orb';
      /** `off`（默认）| `viewport`（呼出时截取当前应用视口）。 */
      'capture-mode'?: 'off' | 'viewport';
    }>;
  }
}

export {};
