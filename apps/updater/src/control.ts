import type { UpdaterConfig } from "./config.ts";
import { readJsonFile, readTextFileIfExists, removeFileIfExists, writeJsonAtomic } from "./fsx.ts";
import type { PhaseId } from "./state.ts";

export interface PauseMarker {
  operationId: string;
  requestId: string;
  version: string;
  digest: string;
  phase: PhaseId;
  message: string;
  startedAt: string;
  updatedAt: string;
}

export interface ReleaseMarker {
  operationId: string;
  requestId: string;
  version: string;
  digest: string;
  imageRef: string;
  volume: string | null;
  releasedAt: string;
}

export type MarkerState<T> = { state: "absent" } | { state: "ok"; marker: T } | { state: "invalid"; error: string };

export interface ControlPort {
  readPaused(): Promise<MarkerState<PauseMarker>>;
  writePaused(marker: PauseMarker): Promise<void>;
  /** 原子解除暂停：unlink 是原子操作，feedback 服务看到文件消失即恢复写入。 */
  clearPaused(): Promise<boolean>;
  readRelease(): Promise<MarkerState<ReleaseMarker>>;
  writeRelease(marker: ReleaseMarker): Promise<void>;
  clearRelease(): Promise<boolean>;
}

async function readMarker<T>(file: string): Promise<MarkerState<T>> {
  const raw = await readTextFileIfExists(file);
  if (raw === null) return { state: "absent" };
  try {
    const parsed = JSON.parse(raw) as T;
    if (!parsed || typeof parsed !== "object") return { state: "invalid", error: "标记内容不是 JSON 对象" };
    return { state: "ok", marker: parsed };
  } catch (err) {
    return { state: "invalid", error: (err as Error).message };
  }
}

/**
 * 控制目录（feedback 服务只读挂载）：
 *   paused        存在即暂停写入；内容为可读 JSON，供后台展示当前阶段
 *   release       放行标记；记录已放行的版本、镜像引用与数据卷
 *   state/        任务状态与备份（见 state.ts）
 * 所有写入都是同目录临时文件 + rename 的原子写。
 */
export class ControlFiles implements ControlPort {
  private readonly config: UpdaterConfig;

  constructor(config: UpdaterConfig) {
    this.config = config;
  }

  async readPaused(): Promise<MarkerState<PauseMarker>> {
    return readMarker<PauseMarker>(this.config.pausedFile);
  }

  async writePaused(marker: PauseMarker): Promise<void> {
    await writeJsonAtomic(this.config.pausedFile, marker, 0o644);
  }

  async clearPaused(): Promise<boolean> {
    return removeFileIfExists(this.config.pausedFile);
  }

  async readRelease(): Promise<MarkerState<ReleaseMarker>> {
    return readMarker<ReleaseMarker>(this.config.releaseFile);
  }

  async writeRelease(marker: ReleaseMarker): Promise<void> {
    await writeJsonAtomic(this.config.releaseFile, marker, 0o644);
  }

  async clearRelease(): Promise<boolean> {
    return removeFileIfExists(this.config.releaseFile);
  }

  /** 供重启核对读取磁盘原始内容（不做 JSON 解析），用于诊断日志。 */
  async rawPaused(): Promise<string | null> {
    return readTextFileIfExists(this.config.pausedFile);
  }
}

export async function readJsonOrNull<T>(file: string): Promise<T | null> {
  try {
    return await readJsonFile<T>(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
