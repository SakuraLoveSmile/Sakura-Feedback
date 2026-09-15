import path from "node:path";
import type { UpdaterConfig } from "./config.ts";
import type { ControlPort } from "./control.ts";
import { DB_PROBE_SCRIPT, parseDbProbeOutput } from "./db-probe.ts";
import type { ContainerInfo, DockerPort } from "./docker.ts";
import { type DeployEnvFile, ENV_DATA_VOLUME_KEY, ENV_IMAGE_KEY, readDeployEnvFile } from "./envfile.ts";
import type { Logger } from "./log.ts";
import { addEvidence, type TaskOutcome, type TaskRecord, type TaskStorePort, touch } from "./state.ts";

export interface ReconcileDeps {
  config: UpdaterConfig;
  store: TaskStorePort;
  control: ControlPort;
  docker: DockerPort;
  log: Logger;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  confirmTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ReconcileReport {
  checked: number;
  succeeded: string[];
  restored: string[];
  needsAttention: string[];
  stalePauseCleared: boolean;
  corrupt: string[];
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function dataDirOf(container: ContainerInfo): string {
  for (const entry of container.env) {
    const match = /^FEEDBACK_DATA_DIR=(.*)$/.exec(entry);
    if (match?.[1]) return match[1];
  }
  return "/data";
}

function dataVolumeOf(container: ContainerInfo): string | null {
  const dataDir = dataDirOf(container);
  return container.mounts.find((entry) => entry.destination === dataDir)?.name ?? null;
}

/**
 * 重启核对：进程启动时读取已落盘任务、控制文件与 Docker 实际状态。
 * 只在「能确凿判定」时给出结论，绝不盲目重复更新或回退：
 *   - 放行标记与运行中镜像 digest 一致 → 判定更新已完成
 *   - 环境文件已切到新镜像 → 记为需要处理（不自动回退）
 *   - 环境文件仍指向旧镜像 → 确认旧服务运行后解除暂停，记为「已恢复旧版本」
 *   - 无法判定 → 记为需要处理
 */
export async function reconcileOnStartup(deps: ReconcileDeps): Promise<ReconcileReport> {
  const { config, store, control, docker, log } = deps;
  const now = deps.clock ?? (() => new Date());
  const sleep = deps.sleep ?? sleepDefault;
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? 60_000;
  const pollIntervalMs = deps.pollIntervalMs ?? 2_000;

  const report: ReconcileReport = {
    checked: 0,
    succeeded: [],
    restored: [],
    needsAttention: [],
    stalePauseCleared: false,
    corrupt: [],
  };

  const { records, corrupt } = await store.listLenient();
  report.corrupt = corrupt;
  const runningTasks = records.filter((record) => record.status === "running");
  report.checked = runningTasks.length;

  let env: DeployEnvFile | null = null;
  let envError: string | null = null;
  try {
    env = await readDeployEnvFile(config.envFile);
  } catch (err) {
    envError = (err as Error).message;
  }
  const release = await control.readRelease();
  const paused = await control.readPaused();

  const inspectContainer = async (): Promise<ContainerInfo | null> => {
    try {
      const id = await docker.serviceContainerId();
      if (!id) return null;
      return await docker.inspectContainer(id);
    } catch (err) {
      log.warn("重启核对：读取容器状态失败", { error: (err as Error).message });
      return null;
    }
  };

  const containerDigest = async (container: ContainerInfo | null): Promise<string | null> => {
    if (!container) return null;
    try {
      const info = await docker.imageInfo(container.imageId);
      const match = info.digests
        .map((entry) => /@(sha256:[0-9a-f]{64})$/.exec(entry)?.[1] ?? null)
        .find((entry): entry is string => entry !== null);
      return match ?? null;
    } catch {
      return null;
    }
  };

  for (const record of runningTasks) {
    const container = await inspectContainer();
    const digest = await containerDigest(container);
    const taskLog = log.child({ operationId: record.operationId, phase: record.phase });

    // A. 放行已授权：以运行中的实际状态定论
    if (release.state === "ok" && release.marker.operationId === record.operationId) {
      if (container?.running && digest === record.digest && paused.state === "absent") {
        addEvidence(
          record,
          now(),
          record.phase,
          "重启核对",
          true,
          "放行标记存在，运行中镜像 digest 与目标一致，判定更新已完成",
        );
        await control.clearPaused();
        touch(record, now(), "done", "重启核对：放行完成，更新成功");
        record.status = "succeeded";
        record.outcome = "succeeded";
        record.finishedAt = now().toISOString();
        await store.save(record);
        report.succeeded.push(record.operationId);
        continue;
      }
      await markNeedsAttention(
        record,
        "重启核对时放行无法确认",
        `放行标记存在，但运行状态/digest/暂停标记无法全部确认（运行中=${container?.running === true}，实际 digest=${
          digest ?? "未知"
        }，暂停标记=${paused.state}）。执行器不自动回退，也不重复更新。`,
      );
      report.needsAttention.push(record.operationId);
      continue;
    }

    // B. 环境文件已切到新镜像：中断发生在切换之后
    if (env && record.newImageRef && env.values.get(ENV_IMAGE_KEY) === record.newImageRef) {
      await markNeedsAttention(
        record,
        "重启发生在切换镜像与数据卷之后",
        `部署环境文件已指向新镜像 ${record.newImageRef} 与数据卷 ${env.values.get(ENV_DATA_VOLUME_KEY) ?? "?"}；` +
          `为避免把新数据静默覆盖回旧卷，执行器不自动回退。`,
      );
      report.needsAttention.push(record.operationId);
      continue;
    }

    // C. 环境文件仍指向旧镜像：确认旧服务运行后解除暂停
    if (!env) {
      await markNeedsAttention(record, "无法读取部署环境文件", envError ?? "未知原因");
      report.needsAttention.push(record.operationId);
      continue;
    }
    if (record.previousImage && env.values.get(ENV_IMAGE_KEY) !== record.previousImage) {
      await markNeedsAttention(
        record,
        "部署环境文件与任务记录不一致",
        `环境文件镜像=${env.values.get(ENV_IMAGE_KEY) ?? "?"}，任务记录旧镜像=${record.previousImage}`,
      );
      report.needsAttention.push(record.operationId);
      continue;
    }

    taskLog.warn("重启核对：任务在更新过程中中断，尝试确认旧服务");
    let current = await inspectContainer();
    if (!current?.running) {
      try {
        await docker.startFeedback();
      } catch (err) {
        await markNeedsAttention(record, "启动旧服务失败", (err as Error).message);
        report.needsAttention.push(record.operationId);
        continue;
      }
    }
    const deadline = now().getTime() + confirmTimeoutMs;
    const permanent = new Set(["image_mismatch", "volume_mismatch"]);
    let verdict = await confirmOldService(docker, record, env);
    while (!verdict.ok && !permanent.has(verdict.reason) && now().getTime() < deadline) {
      await sleep(pollIntervalMs);
      verdict = await confirmOldService(docker, record, env);
      current = await inspectContainer();
    }
    if (!verdict.ok && current?.running && verdict.reason === "image_mismatch") {
      // 运行中但不是登记的旧镜像：不猜测，交给人工
      await markNeedsAttention(record, "旧服务镜像与登记值不符", verdict.detail);
      report.needsAttention.push(record.operationId);
      continue;
    }
    if (!verdict.ok) {
      await markNeedsAttention(record, "旧服务未通过确认检查", verdict.detail);
      report.needsAttention.push(record.operationId);
      continue;
    }
    await control.clearPaused();
    addEvidence(record, now(), record.phase, "重启核对", true, verdict.detail);
    touch(record, now(), "done", `重启核对：未发生切换，已确认旧服务运行并解除暂停（${verdict.detail}）`);
    record.status = "failed";
    record.outcome = "failed_restored";
    record.finishedAt = now().toISOString();
    record.recoveryHint = null;
    await store.save(record);
    report.restored.push(record.operationId);
  }

  // 没有进行中的任务时，清理「已终态且已知安全」的过期暂停标记
  if (runningTasks.length === 0 && paused.state !== "absent") {
    const referenced =
      paused.state === "ok" ? records.find((record) => record.operationId === paused.marker.operationId) : undefined;
    const safeOutcomes: TaskOutcome[] = ["succeeded", "failed_restored", "failed_no_changes"];
    if (referenced?.outcome && safeOutcomes.includes(referenced.outcome)) {
      const cleared = await control.clearPaused();
      report.stalePauseCleared = cleared;
      log.warn("清理过期暂停标记", { operationId: referenced.operationId, outcome: referenced.outcome });
    } else {
      log.warn("暂停标记无法安全清理，保持不动等待人工处理", {
        pauseState: paused.state,
        operationId: paused.state === "ok" ? paused.marker.operationId : null,
      });
    }
  }

  log.info("重启核对完成", {
    checked: report.checked,
    succeeded: report.succeeded.length,
    restored: report.restored.length,
    needsAttention: report.needsAttention.length,
    stalePauseCleared: report.stalePauseCleared,
    corrupt: report.corrupt.length,
  });
  return report;

  async function markNeedsAttention(record: TaskRecord, reason: string, detail: string): Promise<void> {
    addEvidence(record, now(), record.phase, "重启核对", false, `${reason}：${detail}`);
    const hint =
      `${reason}。${detail} 执行器不自动重复更新或回退：旧镜像、原数据卷与（若已创建的）新数据卷全部保留。` +
      `请人工核对服务与数据后按 docs/deployment.md「升级与回退」处理；任务证据见 ${path.join(
        config.tasksDir,
        `${record.operationId}.json`,
      )}。`;
    record.recoveryHint = hint;
    touch(record, now(), "done", `需要人工处理：${reason}`);
    record.status = "needs_attention";
    record.outcome = "needs_attention";
    record.finishedAt = now().toISOString();
    await store.save(record);
  }
}

async function confirmOldService(
  docker: DockerPort,
  record: TaskRecord,
  env: DeployEnvFile,
): Promise<{ ok: boolean; reason: string; detail: string }> {
  const id = await docker.serviceContainerId();
  if (!id) return { ok: false, reason: "container_missing", detail: "未找到旧服务容器" };
  const container = await docker.inspectContainer(id);
  if (!container.running) return { ok: false, reason: "container_not_running", detail: "旧服务容器未运行" };
  const expectedImage = record.previousImage ?? env.values.get(ENV_IMAGE_KEY) ?? null;
  if (expectedImage && container.imageRef !== expectedImage) {
    return {
      ok: false,
      reason: "image_mismatch",
      detail: `运行中镜像 ${container.imageRef || container.imageId} 与登记值 ${expectedImage} 不一致`,
    };
  }
  const expectedVolume = record.previousVolume ?? env.values.get(ENV_DATA_VOLUME_KEY) ?? null;
  const volume = dataVolumeOf(container);
  if (expectedVolume && volume !== expectedVolume) {
    return {
      ok: false,
      reason: "volume_mismatch",
      detail: `数据卷挂载 ${volume ?? "无"} 与登记值 ${expectedVolume} 不一致`,
    };
  }
  try {
    const stdout = await docker.execNode(container.id, DB_PROBE_SCRIPT, {
      DB_PATH: path.posix.join(dataDirOf(container), "feedback.db"),
    });
    const probe = parseDbProbeOutput(stdout);
    if (!probe.ok || probe.integrity !== "ok") {
      return {
        ok: false,
        reason: "db_verify_failed",
        detail: `旧服务数据库探针未通过：${probe.error ?? probe.integrity ?? "未知"}`,
      };
    }
  } catch (err) {
    return { ok: false, reason: "db_verify_failed", detail: `数据库探针执行失败：${(err as Error).message}` };
  }
  return {
    ok: true,
    reason: "ok",
    detail: `旧服务运行中：镜像 ${container.imageRef || container.imageId.slice(0, 19)}，数据卷 ${volume ?? "?"}`,
  };
}
