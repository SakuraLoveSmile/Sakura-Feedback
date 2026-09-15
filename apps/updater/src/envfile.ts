import fs from "node:fs/promises";
import { writeFileAtomic } from "./fsx.ts";

export class EnvFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvFileError";
  }
}

export interface DeployEnvFile {
  path: string;
  content: string;
  mode: number;
  values: Map<string, string>;
}

const LINE_PATTERN = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
    // 行尾注释：仅在非引号值上剥离 " #..." 形式
    const hashIndex = trimmed.indexOf(" #");
    if (hashIndex > 0) return trimmed.slice(0, hashIndex).trim();
  }
  return trimmed;
}

/** 解析 KEY=VALUE 形式的环境文件；后出现的定义覆盖先出现的（与 shell 语义一致）。 */
export function parseEnvFile(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = LINE_PATTERN.exec(trimmed);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2];
    if (!key || rawValue === undefined) continue;
    values.set(key, unquote(rawValue));
  }
  return values;
}

/**
 * 就地替换指定键的值，其余行（注释、空行、其它键）逐字节保留。
 * 键缺失时抛错：更新需要部署时登记的镜像与数据卷引用，缺失说明首次安装未完成。
 */
export function renderUpdatedEnvFile(content: string, updates: Record<string, string>): string {
  const pending = new Map(Object.entries(updates));
  const lines = content.split("\n");
  const rendered = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const match = LINE_PATTERN.exec(trimmed);
    if (!match?.[1]) return line;
    const key = match[1];
    const next = pending.get(key);
    if (next === undefined) return line;
    return `${key}=${next}`;
  });
  if (pending.size > 0) {
    const applied = new Set(
      rendered
        .map((line) => LINE_PATTERN.exec(line.trim())?.[1])
        .filter((key): key is string => typeof key === "string"),
    );
    const missing = [...pending.keys()].filter((key) => !applied.has(key));
    if (missing.length > 0) {
      throw new EnvFileError(
        `部署环境文件缺少键：${missing.join(", ")}；请先执行 deploy/install-updater.sh 完成首次安装登记`,
      );
    }
  }
  return rendered.join("\n");
}

export async function readDeployEnvFile(path: string): Promise<DeployEnvFile> {
  let content: string;
  let mode = 0o600;
  try {
    const stat = await fs.stat(path);
    mode = stat.mode & 0o777;
    content = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new EnvFileError(`部署环境文件不存在：${path}（容器内路径应与宿主一致）`);
    }
    throw err;
  }
  return { path, content, mode, values: parseEnvFile(content) };
}

export async function writeDeployEnvFile(file: DeployEnvFile, content: string): Promise<void> {
  await writeFileAtomic(file.path, content, file.mode);
}

export const ENV_IMAGE_KEY = "FEEDBACK_IMAGE";
export const ENV_DATA_VOLUME_KEY = "FEEDBACK_DATA_VOLUME";

export function hasSecureMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}
