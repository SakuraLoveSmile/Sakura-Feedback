import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** 目录不存在则创建（默认 700：状态目录含恢复证据，不对外放开）。 */
export async function ensureDir(dir: string, mode = 0o700): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode });
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function fileMode(file: string): Promise<number | null> {
  try {
    const stat = await fs.stat(file);
    return stat.mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * 原子写入：同目录临时文件 → fsync → rename → fsync 目录。
 * 阶段边界与放行记录都依赖它，避免半截 JSON 被 feedback 服务读到。
 */
export async function writeFileAtomic(file: string, data: string, mode?: number): Promise<void> {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  const handle = await fs.open(tmp, "w", mode ?? 0o600);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  if (mode !== undefined) await fs.chmod(file, mode);
  await syncDir(dir);
}

export async function writeJsonAtomic(file: string, value: unknown, mode?: number): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export async function readJsonFile<T = unknown>(file: string): Promise<T> {
  const text = await fs.readFile(file, "utf8");
  return JSON.parse(text) as T;
}

export async function readTextFileIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function removeFileIfExists(file: string): Promise<boolean> {
  try {
    await fs.unlink(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function copyFileWithMode(from: string, to: string, mode?: number): Promise<void> {
  const content = await fs.readFile(from);
  await ensureDir(path.dirname(to));
  const handle = await fs.open(to, "w", mode ?? 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (mode !== undefined) await fs.chmod(to, mode);
}

async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // 某些平台/文件系统不支持目录 fsync（macOS 可能 EINVAL）；重命名本身已是原子的。
  }
}
