import { randomUUID } from "node:crypto";
import type { Db } from "./db.ts";
import { getAppByAppId } from "./repos.ts";

export type ReleaseEntryType = "added" | "improved" | "fixed";

export interface ReleaseEntry {
  type: ReleaseEntryType;
  title: string;
  description: string;
  feedbacks: { feedbackId: string; creditName: string | null }[];
}

export interface ReleaseInput {
  appId: string;
  version: string;
  releaseDate: string;
  summary: string;
  upgradeNotes: string;
  entries: ReleaseEntry[];
}

export interface Release extends ReleaseInput {
  id: string;
  revision: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ReleaseRow {
  id: string;
  app_id: string;
  version: string;
  release_date: string;
  summary: string;
  upgrade_notes: string;
  entries_json: string;
  revision: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicRelease {
  id: string;
  version: string;
  releaseDate: string;
  summary: string;
  upgradeNotes: string;
  entries: { type: ReleaseEntryType; title: string; description: string; contributors: string[] }[];
  publishedAt: string;
}

export interface PublicChangelog {
  appId: string;
  appName: string;
  items: PublicRelease[];
}

export interface ChangelogAppOption {
  appId: string;
  name: string;
  deleted: boolean;
}

export class ChangelogError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

function invalid(message: string): never {
  throw new ChangelogError("invalid_request", message, 400);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("请求必须是 JSON 对象");
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max: number, required = false, singleLine = false): string {
  if (typeof value !== "string") invalid(`${name} 必须是文字`);
  const trimmed = value.trim();
  if (trimmed.length > max || (required && !trimmed)) invalid(`${name} ${required ? "必填且" : ""}不超过 ${max} 字符`);
  if (singleLine && /[\p{Cc}\u2028\u2029]/u.test(value)) invalid(`${name} 必须是单行文字`);
  if (/\p{Cc}/u.test(value.replace(/[\t\r\n]/g, ""))) invalid(`${name} 含有无效控制字符`);
  return trimmed;
}

/** 只接收面向用户编辑过的条目；不从反馈原话或处理说明自动生成公开文本。 */
export function parseReleaseInput(value: unknown): ReleaseInput {
  const body = object(value);
  const appId = text(body.appId, "软件标识", 100, true, true);
  const version = text(body.version, "版本号", 80, true, true);
  const releaseDate = text(body.releaseDate, "发布日期", 10, true, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) invalid("发布日期必须为 YYYY-MM-DD");
  const date = new Date(`${releaseDate}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== releaseDate) {
    invalid("发布日期不是有效日历日期");
  }
  const summary = text(body.summary, "更新摘要", 2000);
  const upgradeNotes = text(body.upgradeNotes, "升级说明", 4000);
  if (!Array.isArray(body.entries) || body.entries.length < 1 || body.entries.length > 100) {
    invalid("更新条目数量须为 1..100");
  }
  const entries = body.entries.map((item): ReleaseEntry => {
    const entry = object(item);
    if (entry.type !== "added" && entry.type !== "improved" && entry.type !== "fixed") invalid("更新类型无效");
    const title = text(entry.title, "条目标题", 120, true, true);
    const description = text(entry.description, "条目说明", 2000);
    if (!Array.isArray(entry.feedbacks) || entry.feedbacks.length > 20) invalid("每条最多关联 20 条反馈");
    const ids = new Set<string>();
    const feedbacks = entry.feedbacks.map((item) => {
      const link = object(item);
      const feedbackId = text(link.feedbackId, "反馈标识", 100, true, true);
      if (ids.has(feedbackId)) invalid("同一条目不能重复关联相同反馈");
      ids.add(feedbackId);
      const creditName = link.creditName === null ? null : text(link.creditName, "公开署名", 80, true, true);
      return { feedbackId, creditName };
    });
    return { type: entry.type, title, description, feedbacks };
  });
  return { appId, version, releaseDate, summary, upgradeNotes, entries };
}

export function parseExpectedRevision(value: unknown): number {
  const revision = object(value).expectedRevision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) invalid("expectedRevision 必须是正整数");
  return revision as number;
}

function releaseView(row: ReleaseRow): Release {
  return {
    id: row.id,
    appId: row.app_id,
    version: row.version,
    releaseDate: row.release_date,
    summary: row.summary,
    upgradeNotes: row.upgrade_notes,
    entries: JSON.parse(row.entries_json) as ReleaseEntry[],
    revision: row.revision,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getRelease(db: Db, id: string): Release {
  const row = db.prepare("SELECT * FROM changelog_releases WHERE id = ?").get(id) as unknown as ReleaseRow | undefined;
  if (!row) throw new ChangelogError("not_found", "更新日志不存在", 404);
  return releaseView(row);
}

export function listReleases(db: Db, appId: string): Release[] {
  if (!appId || appId.length > 100) invalid("appId 必填且不超过 100 字符");
  return (
    db
      .prepare("SELECT * FROM changelog_releases WHERE app_id = ? ORDER BY release_date DESC, created_at DESC, id DESC")
      .all(appId) as unknown as ReleaseRow[]
  ).map(releaseView);
}

/** 历史日志不依赖反馈列表：无反馈的软件被删除后，管理页仍保留其入口。 */
export function listChangelogApps(db: Db): ChangelogAppOption[] {
  const rows = db
    .prepare(`
    WITH ids AS (
      SELECT app_id FROM apps WHERE deleted_at IS NULL
      UNION SELECT app_id FROM changelog_releases
    ), ranked_apps AS (
      SELECT app_id, name, deleted_at,
        ROW_NUMBER() OVER (
          PARTITION BY app_id
          ORDER BY (deleted_at IS NULL) DESC, deleted_at DESC, created_at DESC, id DESC
        ) AS preference
      FROM apps
    )
    SELECT ids.app_id AS appId, COALESCE(a.name, ids.app_id) AS name,
      CASE WHEN a.app_id IS NULL OR a.deleted_at IS NOT NULL THEN 1 ELSE 0 END AS deleted
    FROM ids LEFT JOIN ranked_apps a ON a.app_id = ids.app_id AND a.preference = 1
    ORDER BY COALESCE(a.name, ids.app_id) COLLATE NOCASE, ids.app_id
  `)
    .all() as unknown as { appId: string; name: string; deleted: number }[];
  return rows.map((row) => ({ appId: row.appId, name: row.name, deleted: row.deleted === 1 }));
}

function write<T>(db: Db, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function checkInputRelations(db: Db, input: ReleaseInput, existing?: Release): void {
  if (!getAppByAppId(db, input.appId)) throw new ChangelogError("not_found", "软件不存在或已删除", 404);
  const duplicate = db
    .prepare("SELECT id FROM changelog_releases WHERE app_id = ? AND version = ? AND id != ?")
    .get(input.appId, input.version, existing?.id ?? "");
  if (duplicate) throw new ChangelogError("release_exists", "该软件已存在相同版本的更新日志", 409);
  const snapshotIds = new Set(existing?.entries.flatMap((entry) => entry.feedbacks.map((link) => link.feedbackId)));
  const feedback = db.prepare("SELECT app_id, mgmt_state FROM feedbacks WHERE id = ?");
  for (const entry of input.entries) {
    for (const link of entry.feedbacks) {
      const row = feedback.get(link.feedbackId) as { app_id: string; mgmt_state: string } | undefined;
      // 历史关联已成为日志快照；源反馈删除后仍能修正文案或署名。
      // 例外只允许保留既有 ID，不能借此新增失效或跨软件的关联。
      if (
        (row && row.app_id !== input.appId) ||
        ((!row || row.mgmt_state === "trash") && !snapshotIds.has(link.feedbackId))
      ) {
        invalid("只能关联本软件中存在且未在回收站的反馈");
      }
    }
  }
}

export function createRelease(db: Db, input: ReleaseInput): Release {
  return write(db, () => {
    checkInputRelations(db, input);
    const id = randomUUID();
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO changelog_releases
        (id, app_id, version, release_date, summary, upgrade_notes, entries_json, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      input.appId,
      input.version,
      input.releaseDate,
      input.summary,
      input.upgradeNotes,
      JSON.stringify(input.entries),
      at,
      at,
    );
    return getRelease(db, id);
  });
}

function checkRevision(release: Release, expectedRevision: number): void {
  if (release.revision !== expectedRevision) {
    throw new ChangelogError("version_conflict", "更新日志已被修改，请重新加载后再操作", 409);
  }
}

export function updateRelease(db: Db, id: string, input: ReleaseInput, expectedRevision: number): Release {
  return write(db, () => {
    const release = getRelease(db, id);
    checkRevision(release, expectedRevision);
    if (release.publishedAt) throw new ChangelogError("release_published", "请先取消发布，再修改更新日志", 409);
    if (release.appId !== input.appId) invalid("更新日志的软件标识不可更改");
    checkInputRelations(db, input, release);
    db.prepare(
      `UPDATE changelog_releases SET version = ?, release_date = ?, summary = ?, upgrade_notes = ?,
        entries_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
    ).run(
      input.version,
      input.releaseDate,
      input.summary,
      input.upgradeNotes,
      JSON.stringify(input.entries),
      new Date().toISOString(),
      id,
    );
    return getRelease(db, id);
  });
}

export function setReleasePublished(db: Db, id: string, publish: boolean, expectedRevision: number): Release {
  return write(db, () => {
    const release = getRelease(db, id);
    checkRevision(release, expectedRevision);
    if (Boolean(release.publishedAt) === publish) return release;
    if (publish && !getAppByAppId(db, release.appId)) {
      throw new ChangelogError("not_found", "软件不存在或已删除", 404);
    }
    const at = new Date().toISOString();
    db.prepare(
      "UPDATE changelog_releases SET published_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
    ).run(publish ? at : null, at, id);
    return getRelease(db, id);
  });
}

/** 公开字段白名单：绝不展开 Release，防止内部关联与原话随接口扩展泄漏。 */
export function publicRelease(release: Release): PublicRelease {
  if (!release.publishedAt) throw new Error("cannot expose a draft release");
  return {
    id: release.id,
    version: release.version,
    releaseDate: release.releaseDate,
    summary: release.summary,
    upgradeNotes: release.upgradeNotes,
    entries: release.entries.map((entry) => ({
      type: entry.type,
      title: entry.title,
      description: entry.description,
      contributors: [...new Set(entry.feedbacks.map((link) => link.creditName ?? "匿名用户"))],
    })),
    publishedAt: release.publishedAt,
  };
}

export function getPublicChangelog(db: Db, appId: string): PublicChangelog {
  const app = getAppByAppId(db, appId);
  if (!app) throw new ChangelogError("not_found", "软件不存在或已删除", 404);
  return {
    appId,
    appName: app.name,
    items: (
      db
        .prepare(
          `SELECT * FROM changelog_releases WHERE app_id = ? AND published_at IS NOT NULL
           ORDER BY release_date DESC, created_at DESC, id DESC`,
        )
        .all(appId) as unknown as ReleaseRow[]
    ).map((row) => publicRelease(releaseView(row))),
  };
}

export const RELEASE_GROUPS: { type: ReleaseEntryType; label: string }[] = [
  { type: "added", label: "新增" },
  { type: "improved", label: "改进" },
  { type: "fixed", label: "修复" },
];

/** Markdown 也是公开产物；将 HTML 与 Markdown 标记当成普通文字。 */
function markdownText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]()#+!|~>-]/g, "\\$&")
    .replace(/^(\s*\d+)\.(?=\s)/gm, "$1\\.");
}

export function releaseMarkdown(release: PublicRelease): string {
  const lines = [`## [${markdownText(release.version)}] — ${release.releaseDate}`];
  if (release.summary) lines.push("", markdownText(release.summary));
  for (const group of RELEASE_GROUPS) {
    const entries = release.entries.filter((entry) => entry.type === group.type);
    if (!entries.length) continue;
    lines.push("", `### ${group.label}`, "");
    for (const entry of entries) {
      lines.push(
        `- **${markdownText(entry.title)}**${entry.description ? `：${markdownText(entry.description).replace(/\n/g, "\n  ")}` : ""}`,
      );
      if (entry.contributors.length) lines.push(`  感谢 ${entry.contributors.map(markdownText).join("、")} 提出反馈。`);
    }
  }
  if (release.upgradeNotes) lines.push("", "### 升级说明", "", markdownText(release.upgradeNotes));
  return `${lines.join("\n")}\n`;
}

export function changelogMarkdown(changelog: PublicChangelog): string {
  return `# ${markdownText(changelog.appName)} 更新日志\n\n${changelog.items.map(releaseMarkdown).join("\n")}`;
}
