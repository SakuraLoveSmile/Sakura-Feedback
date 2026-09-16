import { serve } from "@hono/node-server";
import { createApp, resumeWorker } from "./app.ts";
import { loadConfig } from "./env.ts";

const config = loadConfig();
const feedbackApp = createApp(config);
resumeWorker(feedbackApp);

const server = serve({ fetch: feedbackApp.app.fetch, port: config.port }, (info) => {
  console.log(`[server] Feedback 服务监听 :${info.port}，数据目录 ${config.dataDir}`);
});

/**
 * 优雅退出（docs/deployment.md 的停机备份流程依赖此行为）：
 * 停止接受新请求 → 等处理队列排空 → checkpoint 并关闭 SQLite。
 * 完成后 data/ 只应剩 feedback.db，整目录拷贝即一致快照。
 * 超时未排空则退出，WAL 保留原样，由下次启动的恢复流程兜底（绝不自动补发）。
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] 收到 ${signal}：停止接受新请求，等待处理队列排空…`);
  const force = setTimeout(() => {
    console.error("[server] 队列未在 20s 内排空，直接退出；WAL 保留，恢复流程会在下次启动兜底");
    process.exit(1);
  }, 20_000);
  force.unref?.();

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // 关闭空闲 keep-alive 连接，否则 close() 会一直等它们自然结束
    (server as unknown as { closeIdleConnections?: () => void }).closeIdleConnections?.();
  });
  // T3：先停调度与定时器（不再安排新工作、不再有定时器回调碰数据库），再排空已有队列。
  feedbackApp.worker.stop();
  await feedbackApp.worker.idle();
  try {
    feedbackApp.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    feedbackApp.db.close();
    console.log("[server] 已 checkpoint 并关闭 SQLite，可安全备份 data/");
  } catch (err) {
    console.error("[server] 关闭数据库失败:", (err as Error).message);
  }
  clearTimeout(force);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
