/** 数据保留核验必需的基础表（对应 apps/server/src/db/db.ts 的 schema）。 */
export const REQUIRED_TABLES = ["users", "feedbacks", "feedback_screenshots", "daily_usage"] as const;
export const LOGS_TABLE = "feedback_logs" as const;

/** 加密连接配置在 settings 中的键（apps/server/src/services/ai.ts）。 */
export const ENCRYPTED_SETTING_KEYS = ["ai.apiKeyEnc"] as const;

/**
 * 探针脚本：在 feedback 容器内用 node:sqlite 只读打开数据库，输出单行 JSON。
 * BLOB 只在容器内逐行读取并计算摘要，输出绝不包含文件内容。
 */
export const DB_PROBE_SCRIPT = `(function () {
  var crypto = require("node:crypto");
  var out = { ok: false, error: null, integrity: null, userVersion: null, tableNames: [], counts: {}, settings: {}, attachments: { screenshots: [], logs: [] } };
  function summarize(row, idKey) {
    var value = row.bytes;
    if (value === null || value === undefined) throw new Error("附件字节为空: " + idKey + "=" + String(row[idKey] || ""));
    var bytes = Buffer.from(value);
    var actualByteSize = bytes.byteLength;
    var actualSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    var storedByteSize = row.storedByteSize === null || row.storedByteSize === undefined ? null : Number(row.storedByteSize);
    var storedSha256 = typeof row.storedSha256 === "string" ? row.storedSha256 : "";
    return {
      ...(idKey === "id" ? { id: String(row.id) } : {}),
      feedbackId: String(row.feedbackId),
      byteSize: actualByteSize,
      sha256: actualSha256,
      storedByteSize: Number.isInteger(storedByteSize) ? storedByteSize : null,
      storedSha256: storedSha256,
      metadataValid: storedByteSize !== null && storedByteSize === actualByteSize && storedSha256 === actualSha256
    };
  }
  try {
    var dbPath = process.env.DB_PATH;
    if (!dbPath) throw new Error("DB_PATH 未设置");
    var sqlite = require("node:sqlite");
    var db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    out.integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
    out.userVersion = db.prepare("PRAGMA user_version").get().user_version;
    var names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(function (row) { return row.name; }).sort();
    out.tableNames = names;
    ["users", "feedbacks", "feedback_screenshots", "daily_usage", "feedback_logs"].forEach(function (table) {
      out.counts[table] = names.indexOf(table) >= 0 ? db.prepare("SELECT COUNT(*) AS c FROM " + table).get().c : null;
    });
    db.prepare("SELECT key, value FROM settings").all().forEach(function (row) {
      var value = String(row.value === null || row.value === undefined ? "" : row.value);
      var shape = "text";
      if (value.indexOf("v1:") === 0) shape = "v1";
      else if (value.charAt(0) === "{" || value.charAt(0) === "[") shape = "json";
      else if (value.indexOf("http") === 0) shape = "url";
      out.settings[String(row.key)] = { present: value.length > 0, bytes: Buffer.byteLength(value, "utf8"), shape: shape };
    });
    if (names.indexOf("feedback_screenshots") >= 0) {
      var screenshotStmt = db.prepare("SELECT feedback_id AS feedbackId, png_blob AS bytes, byte_size AS storedByteSize, sha256 AS storedSha256 FROM feedback_screenshots ORDER BY feedback_id");
      for (var screenshotRow of screenshotStmt.iterate()) out.attachments.screenshots.push(summarize(screenshotRow, "feedbackId"));
    }
    if (names.indexOf("feedback_logs") >= 0) {
      var logStmt = db.prepare("SELECT id, feedback_id AS feedbackId, bytes, byte_size AS storedByteSize, sha256 AS storedSha256 FROM feedback_logs ORDER BY id");
      for (var logRow of logStmt.iterate()) out.attachments.logs.push(summarize(logRow, "id"));
    }
    db.close();
    out.ok = true;
  } catch (err) {
    out.error = String((err && err.message) || err);
  }
  console.log("PROBE:" + JSON.stringify(out));
})();`;

export interface SettingProbe {
  present: boolean;
  bytes: number;
  shape: string;
}

export interface AttachmentProbe {
  id?: string;
  feedbackId: string;
  byteSize: number;
  sha256: string;
  storedByteSize?: number | null;
  storedSha256?: string;
  metadataValid?: boolean;
}

export interface DbProbeResult {
  ok: boolean;
  error: string | null;
  integrity: string | null;
  userVersion: number | null;
  tableNames: string[];
  counts: Record<string, number | null>;
  settings: Record<string, SettingProbe>;
  attachments?: { screenshots: AttachmentProbe[]; logs: AttachmentProbe[] };
  attachmentsPresent?: boolean;
}

function invalidProbe(error: string): DbProbeResult {
  return {
    ok: false,
    error,
    integrity: null,
    userVersion: null,
    tableNames: [],
    counts: {},
    settings: {},
    attachmentsPresent: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseAttachmentList(raw: unknown, kind: "截图" | "日志"): AttachmentProbe[] | string {
  if (!Array.isArray(raw)) return `${kind}附件列表不是数组`;
  const result: AttachmentProbe[] = [];
  for (let index = 0; index < raw.length; index++) {
    const value = raw[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${kind}附件第 ${index + 1} 项不是对象`;
    const row = value as Record<string, unknown>;
    if (typeof row.feedbackId !== "string" || row.feedbackId === "")
      return `${kind}附件第 ${index + 1} 项 feedbackId 非法`;
    if (typeof row.byteSize !== "number" || !Number.isInteger(row.byteSize) || row.byteSize < 0)
      return `${kind}附件第 ${index + 1} 项 byteSize 非法`;
    if (typeof row.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.sha256))
      return `${kind}附件第 ${index + 1} 项 sha256 非法`;
    if (kind === "日志" && (typeof row.id !== "string" || row.id === ""))
      return `${kind}附件第 ${index + 1} 项 id 非法`;
    if (
      !Object.hasOwn(row, "storedByteSize") ||
      (row.storedByteSize !== null &&
        (typeof row.storedByteSize !== "number" || !Number.isInteger(row.storedByteSize) || row.storedByteSize < 0))
    )
      return `${kind}附件第 ${index + 1} 项 storedByteSize 非法`;
    if (typeof row.storedSha256 !== "string" || (row.storedSha256 !== "" && !/^[0-9a-f]{64}$/.test(row.storedSha256)))
      return `${kind}附件第 ${index + 1} 项 storedSha256 非法`;
    if (typeof row.metadataValid !== "boolean") return `${kind}附件第 ${index + 1} 项 metadataValid 非法`;
    result.push({
      ...(typeof row.id === "string" ? { id: row.id } : {}),
      feedbackId: row.feedbackId,
      byteSize: row.byteSize,
      sha256: row.sha256,
      storedByteSize: row.storedByteSize as number | null,
      storedSha256: row.storedSha256 as string,
      metadataValid: row.metadataValid as boolean,
    });
  }
  return result;
}

export function parseDbProbeOutput(stdout: string): DbProbeResult {
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("PROBE:"))
    .pop();
  if (!line) return invalidProbe(`探针未输出结果（stdout: ${stdout.trim().slice(0, 200) || "<空>"}）`);
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(line.slice("PROBE:".length));
    if (!isRecord(value)) return invalidProbe("探针输出不是对象");
    parsed = value;
  } catch (err) {
    return invalidProbe(`探针输出无法解析：${(err as Error).message}`);
  }
  if (typeof parsed.ok !== "boolean") return invalidProbe("探针 ok 字段非法");
  if (parsed.error !== null && typeof parsed.error !== "string") return invalidProbe("探针 error 字段非法");
  if (parsed.integrity !== null && typeof parsed.integrity !== "string") return invalidProbe("探针 integrity 字段非法");
  if (
    parsed.userVersion !== null &&
    (typeof parsed.userVersion !== "number" || !Number.isInteger(parsed.userVersion) || parsed.userVersion < 0)
  )
    return invalidProbe("探针 userVersion 字段非法");
  if (!Array.isArray(parsed.tableNames) || !parsed.tableNames.every((name) => typeof name === "string"))
    return invalidProbe("探针 tableNames 字段非法");
  if (new Set(parsed.tableNames).size !== parsed.tableNames.length) return invalidProbe("探针 tableNames 存在重复项");
  if (!isRecord(parsed.counts)) return invalidProbe("探针 counts 字段非法");
  for (const [table, count] of Object.entries(parsed.counts)) {
    if (count !== null && (typeof count !== "number" || !Number.isInteger(count) || count < 0))
      return invalidProbe(`探针计数非法：${table}`);
  }
  if (!isRecord(parsed.settings)) return invalidProbe("探针 settings 字段非法");
  const settings: Record<string, SettingProbe> = {};
  for (const [key, value] of Object.entries(parsed.settings)) {
    if (!isRecord(value)) return invalidProbe(`设置项 ${key} 结构非法`);
    if (typeof value.present !== "boolean" || typeof value.bytes !== "number" || typeof value.shape !== "string")
      return invalidProbe(`设置项 ${key} 字段非法`);
    if (!Number.isInteger(value.bytes) || value.bytes < 0) return invalidProbe(`设置项 ${key} bytes 非法`);
    settings[key] = { present: value.present, bytes: value.bytes, shape: value.shape };
  }
  const attachmentsPresent = parsed.attachments !== undefined;
  let screenshots: AttachmentProbe[] = [];
  let logs: AttachmentProbe[] = [];
  if (attachmentsPresent) {
    if (!isRecord(parsed.attachments)) return invalidProbe("attachments 结构非法");
    const parsedScreenshots = parseAttachmentList(parsed.attachments.screenshots, "截图");
    const parsedLogs = parseAttachmentList(parsed.attachments.logs, "日志");
    if (typeof parsedScreenshots === "string") return invalidProbe(parsedScreenshots);
    if (typeof parsedLogs === "string") return invalidProbe(parsedLogs);
    screenshots = parsedScreenshots;
    logs = parsedLogs;
  }
  return {
    ok: parsed.ok,
    error: parsed.error,
    integrity: parsed.integrity,
    userVersion: parsed.userVersion,
    tableNames: parsed.tableNames,
    counts: parsed.counts as Record<string, number | null>,
    settings,
    attachments: { screenshots, logs },
    attachmentsPresent,
  };
}

export interface DbProbeExpectation {
  dbSchemaVersion: number | null;
  /** 更新前的探针结果（可为空：旧容器读不到时只做自检）。 */
  before: DbProbeResult | null;
}

export interface DbProbeVerdict {
  ok: boolean;
  problems: string[];
  warnings: string[];
  summary: string;
}

function attachmentProblems(probe: DbProbeResult, schemaVersion: number | null): string[] {
  const problems: string[] = [];
  const needsLogs = (schemaVersion ?? probe.userVersion ?? 0) >= 4;
  const attachments = probe.attachments;
  if (!probe.attachmentsPresent) problems.push("探针缺少附件摘要列表");
  if (!attachments) return problems;
  const check = (
    kind: "截图" | "日志",
    rows: AttachmentProbe[],
    count: number | null,
    idOf: (row: AttachmentProbe) => string,
  ): void => {
    if (count !== null && rows.length !== count)
      problems.push(`${kind}附件摘要数量不一致：表计数 ${count}，探针 ${rows.length}`);
    const seen = new Set<string>();
    for (const row of rows) {
      const id = idOf(row);
      if (seen.has(id)) problems.push(`${kind}附件摘要存在重复 ID：${id}`);
      seen.add(id);
      if (row.metadataValid === false) problems.push(`${kind}附件实际字节与数据库元数据不一致：${id}`);
      if (row.storedByteSize !== undefined && row.storedByteSize !== null && row.storedByteSize !== row.byteSize)
        problems.push(`${kind}附件大小与元数据不一致：${id}`);
      if (row.storedSha256 !== undefined && row.storedSha256 !== row.sha256)
        problems.push(`${kind}附件 SHA-256 与元数据不一致：${id}`);
    }
  };
  const screenshotCount = probe.counts.feedback_screenshots;
  if (screenshotCount === undefined || (probe.tableNames.includes("feedback_screenshots") && screenshotCount === null))
    problems.push("截图附件缺少表计数");
  else check("截图", attachments.screenshots, screenshotCount, (row) => row.feedbackId);
  const logCount = probe.counts.feedback_logs;
  if (
    logCount === undefined ||
    (probe.tableNames.includes(LOGS_TABLE) && logCount === null) ||
    (needsLogs && logCount === null)
  ) {
    if (needsLogs || probe.tableNames.includes(LOGS_TABLE)) problems.push("日志附件缺少表计数");
  } else check("日志", attachments.logs, logCount, (row) => row.id ?? "<missing>");
  return problems;
}

function baseProbeProblems(probe: DbProbeResult, schemaVersion: number | null): string[] {
  const problems: string[] = [];
  if (!probe.ok) problems.push(`数据库探针失败：${probe.error ?? "未知原因"}`);
  if (probe.ok && probe.error !== null) problems.push(`数据库探针返回错误：${probe.error}`);
  if (probe.integrity !== "ok") problems.push(`数据库完整性检查未通过：${probe.integrity ?? "<空>"}`);
  if (probe.userVersion === null) problems.push("数据库 schema 版本缺失");
  for (const table of REQUIRED_TABLES) if (!probe.tableNames.includes(table)) problems.push(`数据库缺少表：${table}`);
  const requiresLogs = (schemaVersion ?? probe.userVersion ?? 0) >= 4;
  if (requiresLogs && !probe.tableNames.includes(LOGS_TABLE)) problems.push(`目标 schema 缺少表：${LOGS_TABLE}`);
  for (const table of REQUIRED_TABLES) {
    if (!Object.hasOwn(probe.counts, table) || (probe.tableNames.includes(table) && probe.counts[table] === null))
      problems.push(`探针缺少表计数：${table}`);
  }
  if (
    requiresLogs &&
    (!Object.hasOwn(probe.counts, LOGS_TABLE) ||
      (probe.tableNames.includes(LOGS_TABLE) && probe.counts[LOGS_TABLE] === null))
  )
    problems.push(`探针缺少表计数：${LOGS_TABLE}`);
  if (schemaVersion !== null && probe.userVersion !== null && probe.userVersion < schemaVersion)
    problems.push(`数据库 schema 版本过低：期望 ≥ ${schemaVersion}，实际 ${probe.userVersion}`);
  problems.push(...attachmentProblems(probe, schemaVersion));
  return problems;
}

export function compareDbProbes(after: DbProbeResult, expectation: DbProbeExpectation): DbProbeVerdict {
  const problems = baseProbeProblems(after, expectation.dbSchemaVersion);
  const warnings: string[] = [];
  if (expectation.dbSchemaVersion === null) warnings.push("清单未提供 dbSchemaVersion，跳过 schema 版本核对");
  const before = expectation.before;
  if (!before) {
    warnings.push("缺少更新前的数据基线，仅做新版自身核验");
  } else {
    const beforeProblems = baseProbeProblems(before, before.userVersion);
    if (beforeProblems.length > 0) problems.push(...beforeProblems.map((problem) => `更新前基线不可靠：${problem}`));
    for (const table of REQUIRED_TABLES) {
      const beforeCount = before.counts[table] ?? null;
      const afterCount = after.counts[table] ?? null;
      if (beforeCount === null) problems.push(`更新前缺少 ${table} 计数，无法对比`);
      else if (afterCount === null) problems.push(`新版缺少 ${table} 计数`);
      else if (afterCount < beforeCount)
        problems.push(`数据丢失：${table} 更新前 ${beforeCount} 行，更新后仅 ${afterCount} 行`);
    }
    if (before.counts[LOGS_TABLE] === null || before.counts[LOGS_TABLE] === undefined)
      warnings.push(`更新前缺少 ${LOGS_TABLE} 计数，视为旧版无日志附件`);
    for (const [key, probe] of Object.entries(before.settings)) {
      const current = after.settings[key];
      if (!current) problems.push(`既有配置项丢失：settings.${key}`);
      else {
        if (probe.present && !current.present) problems.push(`既有配置项为空：settings.${key}`);
        if (probe.shape !== current.shape)
          problems.push(`既有配置项格式变化：settings.${key} ${probe.shape} → ${current.shape}`);
      }
    }
    if (before.attachments) {
      const afterScreenshots = new Map(after.attachments?.screenshots.map((row) => [row.feedbackId, row]));
      for (const row of before.attachments.screenshots) {
        const matched = afterScreenshots.get(row.feedbackId);
        if (!matched) problems.push(`截图附件丢失：feedback_id=${row.feedbackId}`);
        else if (matched.sha256 !== row.sha256 || matched.byteSize !== row.byteSize)
          problems.push(`截图附件内容不一致：feedback_id=${row.feedbackId}`);
      }
      const afterLogs = new Map(after.attachments?.logs.map((row) => [row.id, row]));
      for (const row of before.attachments.logs) {
        const matched = afterLogs.get(row.id);
        if (!matched) problems.push(`日志附件丢失：id=${row.id} feedback_id=${row.feedbackId}`);
        else if (
          matched.feedbackId !== row.feedbackId ||
          matched.sha256 !== row.sha256 ||
          matched.byteSize !== row.byteSize
        )
          problems.push(`日志附件内容或归属不一致：id=${row.id}`);
      }
    }
  }
  for (const key of ENCRYPTED_SETTING_KEYS) {
    const probe = after.settings[key];
    if (probe?.present && probe.shape !== "v1")
      problems.push(`加密连接配置 ${key} 形态异常（期望 v1，实际 ${probe.shape}）`);
  }
  const counts = [...REQUIRED_TABLES, LOGS_TABLE].map((table) => `${table}=${after.counts[table] ?? "?"}`).join(" ");
  return {
    ok: problems.length === 0,
    problems,
    warnings,
    summary: `integrity=${after.integrity ?? "?"} user_version=${after.userVersion ?? "?"} ${counts}`,
  };
}
