import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [
    vue({
      // <feedback-widget> 是宿主页面自己注册的 Custom Element，不是 Vue 组件。
      // 不声明 isCustomElement 时模板编译器会生成 resolveComponent('feedback-widget')，
      // 开发模式会报 "Failed to resolve component: feedback-widget"。
      template: {
        compilerOptions: {
          isCustomElement: (tag: string) => tag === 'feedback-widget',
        },
      },
    }),
  ],
});
