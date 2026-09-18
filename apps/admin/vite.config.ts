import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  define: {
    // 管理端自身版本（反馈组件的 app-version 上报值）：构建期常量，与 package.json 同步。
    __ADMIN_VERSION__: JSON.stringify(pkg.version),
  },
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/login": "http://localhost:8787",
    },
  },
});
