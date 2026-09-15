import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { loadTokenSet, TokenError, tokenMatches } from "../src/token.ts";
import { captureLogger } from "./helpers/fakes.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "updater-token-"));
  roots.push(root);
  return root;
}

function configFor(controlDir: string) {
  return loadConfig({
    UPDATER_IMAGE_NAME: "feedback-service:local",
    UPDATER_DEPLOY_DIR: path.dirname(controlDir),
    UPDATER_CONTROL_DIR: controlDir,
    UPDATER_STATE_DIR: path.join(controlDir, "state"),
    UPDATER_TOKEN_FILE: path.join(controlDir, "updater-token"),
  });
}

describe("loadTokenSet / tokenMatches", () => {
  it("读取 600 令牌文件并只接受正确令牌", async () => {
    const root = await makeRoot();
    const controlDir = path.join(root, "update-control");
    await fs.mkdir(controlDir, { recursive: true });
    await fs.writeFile(path.join(controlDir, "updater-token"), "s3cret-token-value-1234\n", { mode: 0o600 });
    const { log, lines } = captureLogger();
    const tokens = await loadTokenSet(configFor(controlDir), log);
    expect(tokens.primary.value).toBe("s3cret-token-value-1234");
    expect(tokens.primary.mode).toBe(0o600);
    expect(tokenMatches(tokens, "s3cret-token-value-1234")).toBe(true);
    expect(tokenMatches(tokens, "s3cret-token-value-1235")).toBe(false);
    expect(tokenMatches(tokens, "")).toBe(false);
    expect(tokenMatches(tokens, undefined)).toBe(false);
    expect(tokenMatches(tokens, "x".repeat(5000))).toBe(false);
    // 令牌值绝不进入日志
    expect(lines.join("\n")).not.toContain("s3cret-token-value-1234");
  });

  it("权限过宽只告警，不改动部署目录", async () => {
    const root = await makeRoot();
    const controlDir = path.join(root, "update-control");
    await fs.mkdir(controlDir, { recursive: true });
    const tokenFile = path.join(controlDir, "updater-token");
    await fs.writeFile(tokenFile, "s3cret-token-value-1234\n", { mode: 0o644 });
    await fs.chmod(tokenFile, 0o644);
    const { log, lines } = captureLogger();
    await loadTokenSet(configFor(controlDir), log);
    expect(lines.join("\n")).toContain("令牌文件权限过宽");
    expect((await fs.stat(tokenFile)).mode & 0o777).toBe(0o644);
  });

  it("同时接受控制目录内第二份 feedback-token", async () => {
    const root = await makeRoot();
    const controlDir = path.join(root, "update-control");
    await fs.mkdir(controlDir, { recursive: true });
    await fs.writeFile(path.join(controlDir, "updater-token"), "updater-token-value-1234\n", { mode: 0o600 });
    await fs.writeFile(path.join(controlDir, "feedback-token"), "feedback-token-value-5678\n", { mode: 0o600 });
    const tokens = await loadTokenSet(configFor(controlDir));
    expect(tokenMatches(tokens, "updater-token-value-1234")).toBe(true);
    expect(tokenMatches(tokens, "feedback-token-value-5678")).toBe(true);
    expect(tokenMatches(tokens, "other-token-value-9999")).toBe(false);
  });

  it("令牌文件缺失或过短时拒绝启动", async () => {
    const root = await makeRoot();
    const controlDir = path.join(root, "update-control");
    await fs.mkdir(controlDir, { recursive: true });
    await expect(loadTokenSet(configFor(controlDir))).rejects.toBeInstanceOf(TokenError);
    await fs.writeFile(path.join(controlDir, "updater-token"), "short\n", { mode: 0o600 });
    await expect(loadTokenSet(configFor(controlDir))).rejects.toThrow(/内容过短/);
  });
});
