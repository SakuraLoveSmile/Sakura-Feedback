import path from "node:path";
import { ensureDir, listFiles, readJsonFile, removeFileIfExists, writeJsonAtomic } from "./fsx.ts";
import type { Logger } from "./log.ts";

export type PhaseId =
  | "accepted"
  | "preflight_pull"
  | "pause_stop"
  | "backup_copy"
  | "start_paused"
  | "verify_new"
  | "release"
  | "done";

export const PHASE_ORDER: readonly PhaseId[] = [
  "accepted",
  "preflight_pull",
  "pause_stop",
  "backup_copy",
  "start_paused",
  "verify_new",
  "release",
  "done",
];

export const PHASE_LABELS: Record<PhaseId, string> = {
  accepted: "已受理",
  preflight_pull: "①预检并拉取",
  pause_stop: "②暂停并停服",
  backup_copy: "③保留备份并复制",
  start_paused: "④启动验证",
  verify_new: "⑤核验新版",
  release: "⑥放行",
  done: "完成",
};

export type TaskStatus = "running" | "succeeded" | "failed" | "needs_attention";

/** 终态语义（前台据此区分「已恢复旧版本」与「需要处理」）。 */
export type TaskOutcome = "succeeded" | "failed_no_changes" | "failed_restored" | "needs_attention";

export interface TaskEvidence {
  at: string;
  phase: PhaseId;
  step: string;
  ok: boolean;
  detail?: string;
}

export interface TaskRecord {
  operationId: string;
  requestId: string;
  version: string;
  digest: string;
  status: TaskStatus;
  outcome: TaskOutcome | null;
  phase: PhaseId;
  phaseLabel: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  previousImage: string | null;
  newImageRef: string | null;
  previousVolume: string | null;
  newVolume: string | null;
  previousContainerId: string | null;
  backupDir: string | null;
  restore: { attempted: boolean; confirmed: boolean; note: string | null } | null;
  failure: { phase: PhaseId; code: string; message: string } | null;
  recoveryHint: string | null;
  warnings: string[];
  evidence: TaskEvidence[];
}

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

export interface TaskStorePort {
  create(record: TaskRecord): Promise<void>;
  save(record: TaskRecord): Promise<void>;
  get(operationId: string): Promise<TaskRecord | null>;
  findByRequestId(requestId: string): Promise<TaskRecord | null>;
  list(): Promise<TaskRecord[]>;
  /** 宽松列举：损坏的任务文件只记录文件名，不阻塞重启核对。 */
  listLenient(): Promise<{ records: TaskRecord[]; corrupt: string[] }>;
  findRunning(): Promise<TaskRecord | null>;
}

const MAX_EVIDENCE = 200;
const MAX_RECORDS_SCANNED = 500;

export function createTaskRecord(input: {
  operationId: string;
  requestId: string;
  version: string;
  digest: string;
  now: Date;
}): TaskRecord {
  const ts = input.now.toISOString();
  return {
    operationId: input.operationId,
    requestId: input.requestId,
    version: input.version,
    digest: input.digest,
    status: "running",
    outcome: null,
    phase: "accepted",
    phaseLabel: PHASE_LABELS.accepted,
    message: "任务已受理，等待执行",
    createdAt: ts,
    updatedAt: ts,
    startedAt: null,
    finishedAt: null,
    previousImage: null,
    newImageRef: null,
    previousVolume: null,
    newVolume: null,
    previousContainerId: null,
    backupDir: null,
    restore: null,
    failure: null,
    recoveryHint: null,
    warnings: [],
    evidence: [],
  };
}

export function touch(record: TaskRecord, now: Date, phase: PhaseId, message: string): TaskRecord {
  record.phase = phase;
  record.phaseLabel = PHASE_LABELS[phase];
  record.message = message;
  record.updatedAt = now.toISOString();
  return record;
}

export function addEvidence(
  record: TaskRecord,
  now: Date,
  phase: PhaseId,
  step: string,
  ok: boolean,
  detail?: string,
): TaskRecord {
  const entry: TaskEvidence = { at: now.toISOString(), phase, step, ok };
  if (detail !== undefined) entry.detail = detail.length > 1000 ? `${detail.slice(0, 1000)}…` : detail;
  record.evidence.push(entry);
  if (record.evidence.length > MAX_EVIDENCE) record.evidence = record.evidence.slice(-MAX_EVIDENCE);
  record.updatedAt = entry.at;
  return record;
}

function isTaskRecord(value: unknown): value is TaskRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.operationId === "string" && typeof record.requestId === "string" && typeof record.status === "string"
  );
}

function normalizeRecord(raw: TaskRecord): TaskRecord {
  return {
    ...raw,
    phaseLabel: raw.phaseLabel ?? PHASE_LABELS[raw.phase] ?? raw.phase,
    evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
    restore: raw.restore ?? null,
    failure: raw.failure ?? null,
    recoveryHint: raw.recoveryHint ?? null,
    outcome: raw.outcome ?? null,
  };
}

/**
 * 任务状态落盘：状态目录 = UPDATER_STATE_DIR，任务文件 state/tasks/<operationId>.json。
 * feedback 后台与重启核对都读取同一批文件，因此写入必须是原子的。
 */
export class FileTaskStore implements TaskStorePort {
  private readonly dir: string;
  private readonly log: Logger | undefined;

  constructor(options: { stateDir: string; log?: Logger }) {
    this.dir = path.join(options.stateDir, "tasks");
    this.log = options.log;
  }

  async init(): Promise<void> {
    await ensureDir(this.dir, 0o700);
  }

  fileFor(operationId: string): string {
    return path.join(this.dir, `${operationId}.json`);
  }

  async create(record: TaskRecord): Promise<void> {
    await ensureDir(this.dir, 0o700);
    await writeJsonAtomic(this.fileFor(record.operationId), record, 0o600);
  }

  async save(record: TaskRecord): Promise<void> {
    await ensureDir(this.dir, 0o700);
    await writeJsonAtomic(this.fileFor(record.operationId), record, 0o600);
  }

  async get(operationId: string): Promise<TaskRecord | null> {
    try {
      const raw = await readJsonFile<TaskRecord>(this.fileFor(operationId));
      if (!isTaskRecord(raw)) throw new StateError(`任务文件结构异常：${operationId}`);
      return normalizeRecord(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async listLenient(): Promise<{ records: TaskRecord[]; corrupt: string[] }> {
    const files = (await listFiles(this.dir)).filter((name) => name.endsWith(".json")).sort();
    const corrupt: string[] = [];
    const records: TaskRecord[] = [];
    for (const file of files.slice(-MAX_RECORDS_SCANNED)) {
      try {
        const raw = await readJsonFile<TaskRecord>(path.join(this.dir, file));
        if (!isTaskRecord(raw)) throw new StateError(`任务文件结构异常：${file}`);
        records.push(normalizeRecord(raw));
      } catch (err) {
        corrupt.push(file);
        this.log?.warn("任务状态文件无法解析", { file, error: (err as Error).message });
      }
    }
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { records, corrupt };
  }

  async list(): Promise<TaskRecord[]> {
    return (await this.listLenient()).records;
  }

  async findByRequestId(requestId: string): Promise<TaskRecord | null> {
    const { records } = await this.listLenient();
    const matches = records.filter((record) => record.requestId === requestId);
    return matches[matches.length - 1] ?? null;
  }

  async findRunning(): Promise<TaskRecord | null> {
    const { records } = await this.listLenient();
    return records.find((record) => record.status === "running") ?? null;
  }

  async remove(operationId: string): Promise<void> {
    await removeFileIfExists(this.fileFor(operationId));
  }
}
