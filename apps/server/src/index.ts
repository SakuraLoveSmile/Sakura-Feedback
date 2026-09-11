import { serve } from "@hono/node-server";
import { createApp, resumeWorker } from "./app.ts";
import { loadConfig } from "./env.ts";

const config = loadConfig();
const feedbackApp = createApp(config);
resumeWorker(feedbackApp);

serve({ fetch: feedbackApp.app.fetch, port: config.port }, (info) => {
  console.log(`[server] Feedback 服务监听 :${info.port}，数据目录 ${config.dataDir}`);
});
