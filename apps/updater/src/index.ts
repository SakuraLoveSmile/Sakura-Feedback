import { ConfigError, loadConfig } from "./config.ts";
import { ControlFiles } from "./control.ts";
import { DockerCli } from "./docker.ts";
import { UpdateEngine } from "./engine.ts";
import { ensureDir, fileExists } from "./fsx.ts";
import { startUpdaterServer } from "./http.ts";
import { createLogger } from "./log.ts";
import { ManifestSource } from "./manifest.ts";
import { reconcileOnStartup } from "./reconcile.ts";
import { FileTaskStore } from "./state.ts";
import { loadTokenSet, type TokenSet } from "./token.ts";
import { UPDATER_VERSION } from "./version.ts";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  let tokens: TokenSet;
  try {
    tokens = await loadTokenSet(config);
  } catch (err) {
    process.stderr.write(`[updater] 启动失败：${(err as Error).message}\n`);
    process.exit(1);
    return;
  }
  const log = createLogger({ redact: tokens.all.map((source) => source.value) });

  if (!(await fileExists(config.controlDir))) {
    log.error("控制目录不存在，拒绝启动", {
      controlDir: config.controlDir,
      hint: "应由 deploy/install-updater.sh 创建并挂载；路径在容器内外必须一致",
    });
    process.exit(1);
  }
  await ensureDir(config.stateDir, 0o700);
  await ensureDir(config.tasksDir, 0o700);
  await ensureDir(config.backupsDir, 0o700);
  for (const source of tokens.all) {
    if (source.mode !== null && source.mode & 0o077) {
      log.warn("令牌文件权限过宽，建议 chmod 600", { path: source.path, mode: `0${source.mode.toString(8)}` });
    }
  }
  log.info("已加载共享令牌", { files: tokens.all.map((source) => source.path) });

  const store = new FileTaskStore({ stateDir: config.stateDir, log });
  await store.init();
  const control = new ControlFiles(config);
  const docker = new DockerCli(config, { log });
  const manifest = new ManifestSource(config, { log });
  const engine = new UpdateEngine({ config, docker, store, control, manifest, log });

  const report = await reconcileOnStartup({ config, store, control, docker, log });
  if (report.needsAttention.length > 0) {
    log.warn("存在需要人工处理的任务", { operations: report.needsAttention });
  }

  const server = await startUpdaterServer({ config, tokens, store, manifest, engine, log });
  log.info("updater 已启动", {
    version: UPDATER_VERSION,
    listen: `${config.listenHost}:${config.listenPort}`,
    composeFile: config.composeFile,
    composeProject: config.composeProject,
    service: config.service,
    imageName: config.imageName,
    deployDir: config.deployDir,
    controlDir: config.controlDir,
    stateDir: config.stateDir,
    envFile: config.envFile,
    manifestRemoteUrl: config.manifestRemoteUrl,
    reconcile: {
      checked: report.checked,
      succeeded: report.succeeded,
      restored: report.restored,
      needsAttention: report.needsAttention,
    },
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn("收到退出信号，关闭 HTTP 服务（进行中的任务由下次启动的重启核对处理）", {
      signal,
      busy: engine.isBusy(),
    });
    await server.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    log.error("未处理的 Promise 拒绝，进程退出（重启后按落盘状态核对）", { reason: String(reason) });
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    log.error("未捕获异常，进程退出（重启后按落盘状态核对）", { error: err.message });
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`[updater] 配置错误：${err.message}\n`);
  } else {
    process.stderr.write(`[updater] 启动失败：${(err as Error).message}\n`);
  }
  process.exit(1);
});
