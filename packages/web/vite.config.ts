import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    lib: {
      entry: 'src/index.ts',
      name: 'FeedbackWeb',
      formats: ['es', 'umd'],
      fileName: (format) => (format === 'es' ? 'feedback-web.js' : 'feedback-web.umd.cjs'),
    },
  },
});
