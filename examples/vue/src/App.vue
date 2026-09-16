<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue';
// openFeedback：确保元素存在并调用 open()；导入本身也自动注册元素。
import { openFeedback, type FeedbackSubmittedDetail, type FeedbackWidget } from '@feedback/web';

const last = ref<string | null>(null);
/** 主题：与站点一致的深色模式（system | light | dark）。 */
const theme = ref<'system' | 'light' | 'dark'>('light');

/** 模板 ref：直接持有真实的 DOM 元素实例（不再用 document.querySelector 全局查找）。 */
const widget = useTemplateRef<FeedbackWidget>('widget');

function onSubmitted(ev: Event) {
  const detail = (ev as CustomEvent<FeedbackSubmittedDetail>).detail;
  // 提交成功只代表“原话已保存 + AI 已整理”；归档由管理员在 Feedback 管理页人工完成。
  last.value = `feedbackId=${detail.feedbackId} status=${detail.status}（已保存，等待人工归档）`;
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

    <!-- 宿主菜单调用：任何菜单项 / 工具栏按钮都可以直接调用 open() / captureAndOpen()。 -->
    <nav
      style="
        display: flex;
        gap: 16px;
        align-items: center;
        border-bottom: 1px solid #e2e8f0;
        padding-bottom: 10px;
        margin-bottom: 16px;
      "
    >
      <strong>站点菜单</strong>
      <button @click="openPanel">反馈</button>
      <button @click="captureAndOpen">反馈并截图</button>
      <label style="margin-left: auto; font-size: 13px">
        主题
        <select v-model="theme">
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </label>
    </nav>

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
    <p style="font-size: 13px; color: #64748b">
      提交成功后服务端只做保存与 AI 整理；<strong>归档到 Kaneo 由管理员在 Feedback 管理页人工完成</strong>
      （选择项目 / 列 / 工作区标签 / 可选负责人，再点「保存并归档」）。因此宿主文案请写"反馈已保存"。
    </p>

    <!-- 直接在模板里使用自定义元素；vite.config.ts 已声明 isCustomElement。
         launcher-mode / capture-mode 的组件默认值是 tab / off，这里显式覆盖。
         theme 与站点主题联动（system 跟随系统）。 -->
    <feedback-widget
      ref="widget"
      api-base="http://localhost:8787"
      app-id="com.example.demo-vue"
      app-version="1.0.0"
      page-label="home"
      side="right"
      launcher-mode="orb"
      capture-mode="viewport"
      :theme="theme"
    />
  </main>
</template>
