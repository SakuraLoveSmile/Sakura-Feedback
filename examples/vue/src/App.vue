<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue';
// openFeedback：确保元素存在并调用 open()；导入本身也自动注册元素。
import { openFeedback, type FeedbackSubmittedDetail, type FeedbackWidget } from '@feedback/web';

const last = ref<string | null>(null);

/** 模板 ref：直接持有真实的 DOM 元素实例（不再用 document.querySelector 全局查找）。 */
const widget = useTemplateRef<FeedbackWidget>('widget');

function onSubmitted(ev: Event) {
  const detail = (ev as CustomEvent<FeedbackSubmittedDetail>).detail;
  last.value = `feedbackId=${detail.feedbackId} status=${detail.status}`;
}

/** 只打开面板，不触发截图（需要截图用 captureAndOpen()）。 */
function openPanel() {
  widget.value?.open();
}

/** 截取当前应用视口并打开面板（截图期间反馈面板自身不入图）。 */
function captureAndOpen() {
  widget.value?.captureAndOpen();
}

/**
 * openFeedback() 只做一件事：确保页面上有 <feedback-widget> 并调用它的 open()。
 * 它**不会**截图——即使传 captureMode: 'viewport' 也只是配置元素的属性，
 * 不会立即拍摄；真正要"截图 + 打开"必须调用元素的 captureAndOpen()。
 */
function openViaModuleHelper() {
  openFeedback({
    apiBase: 'http://localhost:8787',
    appId: 'com.example.demo-vue',
    pageLabel: 'home',
  });
}

onMounted(() => {
  // 事件在元素实例上派发（bubbles + composed）；这里挂上，卸载时移除，避免泄漏。
  widget.value?.addEventListener('feedback-submitted', onSubmitted);
});

onBeforeUnmount(() => {
  widget.value?.removeEventListener('feedback-submitted', onSubmitted);
});
</script>

<template>
  <main style="font-family: sans-serif; padding: 40px">
    <h1>Vue × @feedback/web 示例</h1>
    <p>右下角为灵感球（可拖动到界面任意位置指出问题并截图）：</p>

    <div style="display: flex; gap: 12px; margin-bottom: 8px; flex-wrap: wrap">
      <button @click="openPanel">元素 ref：open()（纯文本，不截图）</button>
      <button @click="captureAndOpen">元素 ref：captureAndOpen()（截图并打开）</button>
      <button @click="openViaModuleHelper">openFeedback()（仅打开面板，不截图）</button>
    </div>
    <p style="font-size: 13px; color: #64748b; margin: 0 0 20px 0">
      注意：<code>openFeedback()</code> 内部只调 <code>open()</code>，不会截图；要"截图 + 打开"请用
      <code>captureAndOpen()</code>。示例元素已显式声明
      <code>launcher-mode="orb"</code> 与 <code>capture-mode="viewport"</code>（组件默认是
      <code>tab</code> / <code>off</code>，升级不改变旧宿主行为）。
    </p>

    <div
      data-feedback-capture-mask
      style="
        border: 1px solid #e2e8f0;
        padding: 16px;
        border-radius: 8px;
        max-width: 400px;
        background: #f8fafc;
        margin-bottom: 20px;
      "
    >
      <h3 style="margin: 0 0 8px 0">敏感数据保护演示区</h3>
      <p style="margin: 0 0 8px 0; font-size: 13px; color: #64748b">
        带有 <code>data-feedback-capture-mask</code> 属性的区域在截图时会被中性遮罩覆盖：
      </p>
      <div>密码：<code>MySecretP@ssw0rd!</code></div>
    </div>

    <p style="color: #059669">{{ last ? `最近提交：${last}` : '' }}</p>

    <!-- 直接在模板里使用自定义元素；vite.config.ts 已声明 isCustomElement。
         launcher-mode / capture-mode 的组件默认值是 tab / off，这里显式覆盖。 -->
    <feedback-widget
      ref="widget"
      api-base="http://localhost:8787"
      app-id="com.example.demo-vue"
      app-version="1.0.0"
      page-label="home"
      side="right"
      launcher-mode="orb"
      capture-mode="viewport"
    />
  </main>
</template>
