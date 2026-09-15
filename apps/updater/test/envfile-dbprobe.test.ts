import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareDbProbes,
  DB_PROBE_SCRIPT,
  type DbProbeResult,
  parseDbProbeOutput,
  REQUIRED_TABLES,
} from "../src/db-probe.ts";
import {
  ENV_DATA_VOLUME_KEY,
  ENV_IMAGE_KEY,
  EnvFileError,
  hasSecureMode,
  parseEnvFile,
  readDeployEnvFile,
  renderUpdatedEnvFile,
  writeDeployEnvFile,
} from "../src/envfile.ts";
import { probeJson, scaffold } from "./helpers/fakes.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("parseEnvFile / renderUpdatedEnvFile", () => {
  it("解析引号、注释与重复定义（后者覆盖）", () => {
    const values = parseEnvFile(
      ["# comment", 'A="quoted value"', "B='single'", "C=plain", "D=1", "D=2", "", "  E = spaced  "].join("\n"),
    );
    expect(values.get("A")).toBe("quoted value");
    expect(values.get("B")).toBe("single");
    expect(values.get("C")).toBe("plain");
    expect(values.get("D")).toBe("2");
    expect(values.get("E")).toBe("spaced");
    expect(values.has("comment")).toBe(false);
  });

  it("只替换目标键，其余内容逐字节保留", () => {
    const original = [
      "# 头注释",
      "FEEDBACK_MASTER_KEY=secret",
      "FEEDBACK_IMAGE=old:1",
      "",
      "FEEDBACK_DATA_VOLUME=old-volume",
      "KEEP=1",
      "",
    ].join("\n");
    const rendered = renderUpdatedEnvFile(original, {
      [ENV_IMAGE_KEY]: "feedback-service:local@sha256:aaa",
      [ENV_DATA_VOLUME_KEY]: "feedback-data-new",
    });
    expect(rendered).toContain("# 头注释");
    expect(rendered).toContain("FEEDBACK_MASTER_KEY=secret");
    expect(rendered).toContain("KEEP=1");
    expect(rendered).toContain("FEEDBACK_IMAGE=feedback-service:local@sha256:aaa");
    expect(rendered).toContain("FEEDBACK_DATA_VOLUME=feedback-data-new");
    expect(rendered).not.toContain("old:1");
    const values = parseEnvFile(rendered);
    expect(values.get("FEEDBACK_MASTER_KEY")).toBe("secret");
    expect(values.get("KEEP")).toBe("1");
  });

  it("缺少必须登记的键时报错（首次安装未完成）", () => {
    expect(() => renderUpdatedEnvFile("FEEDBACK_IMAGE=a\n", { FEEDBACK_DATA_VOLUME: "v" })).toThrow(EnvFileError);
  });

  it("读写部署环境文件时保留 600 权限", async () => {
    const dirs = await scaffold();
    roots.push(dirs.root);
    const env = await readDeployEnvFile(dirs.envFile);
    expect(hasSecureMode(env.mode)).toBe(true);
    const rendered = renderUpdatedEnvFile(env.content, { [ENV_IMAGE_KEY]: "new:img" });
    await writeDeployEnvFile(env, rendered);
    const reread = await readDeployEnvFile(dirs.envFile);
    expect(reread.values.get(ENV_IMAGE_KEY)).toBe("new:img");
    expect(hasSecureMode(reread.mode)).toBe(true);
  });
});

describe("parseDbProbeOutput", () => {
  it("解析探针输出（允许前面有其它 stdout 行）", () => {
    const result = parseDbProbeOutput(`noise line\n${probeJson()}`);
    expect(result.ok).toBe(true);
    expect(result.integrity).toBe("ok");
    expect(result.userVersion).toBe(4);
    expect(result.counts.users).toBe(2);
    expect(result.settings["ai.apiKeyEnc"]?.shape).toBe("v1");
  });

  it("没有探针行或 JSON 非法时明确失败", () => {
    expect(parseDbProbeOutput("nothing").ok).toBe(false);
    expect(parseDbProbeOutput("PROBE:{oops").ok).toBe(false);
  });

  it("附件非法条目、缺失字段或重复表名不会被静默忽略", () => {
    const malformed = JSON.parse(probeJson().slice("PROBE:".length)) as Record<string, unknown>;
    const attachments = malformed.attachments as { logs: unknown[] };
    attachments.logs = [null];
    expect(parseDbProbeOutput(`PROBE:${JSON.stringify(malformed)}`).ok).toBe(false);

    const missingMetadata = JSON.parse(probeJson().slice("PROBE:".length)) as Record<string, unknown>;
    const missingScreenshots = missingMetadata.attachments as { screenshots: Array<Record<string, unknown>> };
    delete missingScreenshots.screenshots[0]?.metadataValid;
    expect(parseDbProbeOutput(`PROBE:${JSON.stringify(missingMetadata)}`).ok).toBe(false);

    const duplicateTable = JSON.parse(probeJson().slice("PROBE:".length)) as Record<string, unknown>;
    duplicateTable.tableNames = ["users", "users"];
    expect(parseDbProbeOutput(`PROBE:${JSON.stringify(duplicateTable)}`).ok).toBe(false);
  });
});

function probeResult(overrides: Partial<DbProbeResult> = {}): DbProbeResult {
  const json = probeJson();
  const parsed = parseDbProbeOutput(json);
  return { ...parsed, ...overrides };
}

describe("compareDbProbes", () => {
  const expectation = { dbSchemaVersion: 4, before: probeResult() };

  it("完整通过：完整性、schema、数据保留与加密配置形态", () => {
    const verdict = compareDbProbes(probeResult(), expectation);
    expect(verdict.ok).toBe(true);
    expect(verdict.problems).toEqual([]);
  });

  it("支持从旧版迁移（旧版基线无 feedback_logs 计数时不报错，仅警告）", () => {
    const beforeOldCounts = { users: 2, feedbacks: 5, feedback_screenshots: 3, daily_usage: 7 };
    const beforeOld = probeResult({ userVersion: 3, tableNames: [...REQUIRED_TABLES], counts: beforeOldCounts });
    const verdict = compareDbProbes(probeResult(), { dbSchemaVersion: 4, before: beforeOld });
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings.join()).toContain("更新前缺少 feedback_logs 计数");
  });

  it("缺少必需表、schema 过低、数据丢失都判失败", () => {
    const missingTable = compareDbProbes(
      probeResult({
        tableNames: ["users"],
        counts: { users: 1, feedbacks: 1, feedback_screenshots: 1, daily_usage: 1, feedback_logs: 0 },
      }),
      expectation,
    );
    expect(missingTable.ok).toBe(false);
    expect(missingTable.problems.join()).toContain("缺少表");

    const oldSchema = compareDbProbes(probeResult({ userVersion: 3 }), expectation);
    expect(oldSchema.problems.join()).toContain("schema 版本过低");

    const lost = compareDbProbes(probeResult({ counts: { ...probeResult().counts, feedbacks: 1 } }), expectation);
    expect(lost.problems.join()).toContain("数据丢失");

    const brokenIntegrity = compareDbProbes(
      probeResult({ integrity: "database disk image is malformed" }),
      expectation,
    );
    expect(brokenIntegrity.problems.join()).toContain("完整性");
  });

  it("既有配置项丢失或形态变化都判失败；加密配置必须是 v1", () => {
    const settings = probeResult().settings;
    delete settings["ai.baseUrl"];
    const lostSetting = compareDbProbes(probeResult({ settings }), expectation);
    expect(lostSetting.problems.join()).toContain("ai.baseUrl");

    const wrongShape = compareDbProbes(
      probeResult({
        settings: { ...probeResult().settings, "ai.apiKeyEnc": { present: true, bytes: 10, shape: "text" } },
      }),
      expectation,
    );
    expect(wrongShape.problems.join()).toContain("形态异常");
  });

  it("没有基线或清单缺少 dbSchemaVersion 时只告警", () => {
    const verdict = compareDbProbes(probeResult(), { dbSchemaVersion: null, before: null });
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings.join()).toContain("缺少更新前的数据基线");
    expect(verdict.warnings.join()).toContain("dbSchemaVersion");
  });

  it("附件摘要、大小或归属核对失败时判不通过", () => {
    const baseline = probeResult({
      attachments: {
        screenshots: [{ feedbackId: "fb-1", byteSize: 1234, sha256: "sha-screen" }],
        logs: [{ id: "log-1", feedbackId: "fb-1", byteSize: 567, sha256: "sha-log" }],
      },
    });

    const lostScreenshot = compareDbProbes(
      probeResult({
        attachments: {
          screenshots: [],
          logs: [{ id: "log-1", feedbackId: "fb-1", byteSize: 567, sha256: "sha-log" }],
        },
      }),
      { dbSchemaVersion: 4, before: baseline },
    );
    expect(lostScreenshot.ok).toBe(false);
    expect(lostScreenshot.problems.join()).toContain("截图附件丢失");

    const mismatchedLogSha = compareDbProbes(
      probeResult({
        attachments: {
          screenshots: [{ feedbackId: "fb-1", byteSize: 1234, sha256: "sha-screen" }],
          logs: [{ id: "log-1", feedbackId: "fb-1", byteSize: 567, sha256: "sha-altered" }],
        },
      }),
      { dbSchemaVersion: 4, before: baseline },
    );
    expect(mismatchedLogSha.ok).toBe(false);
    expect(mismatchedLogSha.problems.join()).toContain("日志附件内容或归属不一致");
  });

  it("重复附件 ID 判失败", () => {
    const duplicate = probeResult({
      counts: { ...probeResult().counts, feedback_logs: 2 },
      attachments: {
        screenshots: [],
        logs: [
          { id: "log-1", feedbackId: "fb-1", byteSize: 1, sha256: "a".repeat(64) },
          { id: "log-1", feedbackId: "fb-1", byteSize: 1, sha256: "a".repeat(64) },
        ],
      },
    });
    const verdict = compareDbProbes(duplicate, { dbSchemaVersion: 4, before: null });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join()).toContain("重复 ID");
  });

  it("使用真实 SQLite 附件字节计算摘要，拒绝元数据损坏与升级前后内容变化", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "feedback-db-probe-"));
    roots.push(root);
    const dbPath = path.join(root, "feedback.db");
    runSqliteScript(
      dbPath,
      `
        const { DatabaseSync } = require("node:sqlite");
        const crypto = require("node:crypto");
        const db = new DatabaseSync(process.env.DB_PATH);
        db.exec("CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE feedbacks (id TEXT PRIMARY KEY); CREATE TABLE feedback_screenshots (feedback_id TEXT PRIMARY KEY, png_blob BLOB, byte_size INTEGER, sha256 TEXT); CREATE TABLE daily_usage (user_id TEXT, day TEXT, used INTEGER, reset_at TEXT); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE feedback_logs (id TEXT PRIMARY KEY, feedback_id TEXT, bytes BLOB, byte_size INTEGER, sha256 TEXT);");
        const screenshot = Buffer.from("PNG-A");
        const log = Buffer.from("AAA");
        const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
        db.prepare("INSERT INTO users VALUES (?)").run("user-1");
        db.prepare("INSERT INTO feedbacks VALUES (?)").run("fb-1");
        db.prepare("INSERT INTO daily_usage VALUES (?, ?, ?, ?)").run("user-1", "2026-09-15", 0, "2026-09-16T00:00:00Z");
        db.prepare("INSERT INTO settings VALUES (?, ?)").run("ai.apiKeyEnc", "v1:encrypted");
        db.prepare("INSERT INTO feedback_screenshots VALUES (?, ?, ?, ?)").run("fb-1", screenshot, screenshot.byteLength, digest(screenshot));
        db.prepare("INSERT INTO feedback_logs VALUES (?, ?, ?, ?, ?)").run("log-1", "fb-1", log, log.byteLength, digest(log));
        db.exec("PRAGMA user_version = 5");
        db.close();
      `,
    );

    const healthy = runDbProbe(dbPath);
    expect(healthy.ok).toBe(true);
    expect(compareDbProbes(healthy, { dbSchemaVersion: 5, before: healthy }).ok).toBe(true);

    runSqliteScript(
      dbPath,
      `
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(process.env.DB_PATH);
        db.prepare("UPDATE feedback_logs SET bytes = ? WHERE id = ?").run(Buffer.from("BBB"), "log-1");
        db.close();
      `,
    );
    const staleMetadata = runDbProbe(dbPath);
    expect(staleMetadata.attachments?.logs[0]?.metadataValid).toBe(false);
    expect(compareDbProbes(staleMetadata, { dbSchemaVersion: 5, before: healthy }).ok).toBe(false);
    expect(compareDbProbes(staleMetadata, { dbSchemaVersion: 5, before: healthy }).problems.join()).toContain("元数据");

    runSqliteScript(
      dbPath,
      `
        const { DatabaseSync } = require("node:sqlite");
        const crypto = require("node:crypto");
        const db = new DatabaseSync(process.env.DB_PATH);
        const bytes = Buffer.from("BBB");
        const sha = crypto.createHash("sha256").update(bytes).digest("hex");
        db.prepare("UPDATE feedback_logs SET bytes = ?, byte_size = ?, sha256 = ? WHERE id = ?").run(bytes, bytes.byteLength, sha, "log-1");
        db.close();
      `,
    );
    const changed = runDbProbe(dbPath);
    expect(changed.attachments?.logs[0]?.metadataValid).toBe(true);
    expect(compareDbProbes(changed, { dbSchemaVersion: 5, before: healthy }).ok).toBe(false);
    expect(compareDbProbes(changed, { dbSchemaVersion: 5, before: healthy }).problems.join()).toContain("内容或归属");

    runSqliteScript(
      dbPath,
      `
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(process.env.DB_PATH);
        db.prepare("UPDATE feedback_screenshots SET png_blob = ? WHERE feedback_id = ?").run(Buffer.from("PNG-B"), "fb-1");
        db.close();
      `,
    );
    const brokenScreenshot = runDbProbe(dbPath);
    expect(brokenScreenshot.attachments?.screenshots[0]?.metadataValid).toBe(false);
    expect(compareDbProbes(brokenScreenshot, { dbSchemaVersion: 5, before: healthy }).ok).toBe(false);
  });
});

function runSqliteScript(dbPath: string, script: string): void {
  execFileSync(process.execPath, ["-e", script], {
    env: { ...process.env, DB_PATH: dbPath },
    stdio: "pipe",
  });
}

function runDbProbe(dbPath: string): DbProbeResult {
  const stdout = execFileSync(process.execPath, ["-e", DB_PROBE_SCRIPT], {
    env: { ...process.env, DB_PATH: dbPath },
    encoding: "utf8",
    stdio: "pipe",
  });
  return parseDbProbeOutput(stdout);
}
