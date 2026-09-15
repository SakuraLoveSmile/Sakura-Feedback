// feedback 服务替身：只为本地端到端验证提供「真实可被更新、可被核验」的服务。
// 表结构与 apps/server/src/db/db.ts 对齐（users/feedbacks/feedback_screenshots/daily_usage/settings, user_version=3），
// 首次启动时写入固定数据，便于断言「更新后账号/反馈/截图/额度仍然保留」。
import { mkdirSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dataDir = process.env.FEEDBACK_DATA_DIR ?? "/data";
const port = Number(process.env.FEEDBACK_PORT ?? 8787);
const version = process.env.APP_VERSION ?? "0.0.0";
const controlDir = process.env.FEEDBACK_UPDATE_CONTROL_DIR ?? "";

mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, "feedback.db");
const fresh = !existsSync(dbPath);

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', enabled INTEGER NOT NULL DEFAULT 1,
  daily_limit INTEGER NOT NULL DEFAULT 3, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedbacks (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback_screenshots (
  id TEXT PRIMARY KEY, feedback_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_usage (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, day TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
PRAGMA user_version = 3;
`);

if (fresh) {
  const now = new Date().toISOString();
  for (const [id, name] of [
    ["u-admin", "admin"],
    ["u-user", "user"],
  ]) {
    db.prepare("INSERT INTO users (id, username, pass_hash, role, created_at) VALUES (?, ?, ?, ?, ?)").run(
      id,
      name,
      "scrypt$stub",
      name === "admin" ? "admin" : "user",
      now,
    );
  }
  for (let index = 1; index <= 5; index += 1) {
    db.prepare("INSERT INTO feedbacks (id, app_id, user_id, text, status, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      `f-${index}`,
      "app-1",
      "u-user",
      `stub feedback ${index}`,
      "archived",
      now,
    );
  }
  for (let index = 1; index <= 3; index += 1) {
    db.prepare("INSERT INTO feedback_screenshots (id, feedback_id, created_at) VALUES (?, ?, ?)").run(
      `s-${index}`,
      `f-${index}`,
      now,
    );
  }
  for (let index = 1; index <= 7; index += 1) {
    db.prepare("INSERT INTO daily_usage (id, user_id, day, used) VALUES (?, ?, ?, 1)").run(
      `d-${index}`,
      "u-user",
      `2026-09-0${index}`,
    );
  }
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("ai.baseUrl", "https://api.example.com/v1");
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
    "ai.apiKeyEnc",
    "v1:c3R1Yi1pdi1ieXRlcw==:c3R1Yi10YWc=:c3R1Yi1jaXBoZXJ0ZXh0",
  );
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  console.log(`[stub] 初始化数据目录 ${dataDir}（version=${version}）`);
} else {
  const count = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  console.log(`[stub] 复用既有数据库 ${dbPath}（users=${count}，version=${version}）`);
}

const counts = () => {
  const table = (name) => db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get().c;
  return {
    users: table("users"),
    feedbacks: table("feedbacks"),
    feedback_screenshots: table("feedback_screenshots"),
    daily_usage: table("daily_usage"),
    userVersion: db.prepare("PRAGMA user_version").get().user_version,
  };
};

const paused = () => controlDir !== "" && existsSync(path.join(controlDir, "paused"));

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stub.local");
  const json = (status, body) => {
    const payload = `${JSON.stringify(body)}\n`;
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  };
  if (url.pathname === "/healthz") {
    json(200, { ok: true, version, paused: paused() });
    return;
  }
  if (url.pathname === "/version") {
    json(200, { version, counts: counts() });
    return;
  }
  if (url.pathname === "/api/feedback") {
    if (paused()) {
      json(503, { error: "paused", message: "更新进行中，写入已暂停" });
      return;
    }
    json(200, { ok: true, version });
    return;
  }
  json(404, { error: "not_found", path: url.pathname });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[stub] 监听 :${port}（version=${version}，paused=${paused()}）`);
});

let closing = false;
const shutdown = (signal) => {
  if (closing) return;
  closing = true;
  console.log(`[stub] 收到 ${signal}：优雅退出`);
  server.close(() => {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
    } catch (err) {
      console.error("[stub] 关闭数据库失败", err.message);
    }
    process.exit(0);
  });
  // 兜底：连接排空不了也要在预算内退出
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
