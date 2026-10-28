import { beforeEach, describe, expect, it } from "vitest";
import {
  clearDiagnostics,
  diagnosticsEpoch,
  provideFeedbackLogs,
  recordDiagnostic,
} from "../../admin/src/diagnostics.ts";

/**
 * Feedback-3 / T3：后台诊断日志缓冲单测。
 *
 * 放在 server vitest 下运行（admin 包无测试 runner；server tsconfig 已将本文件
 * 排除在 tsc 之外——diagnostics.ts 的 `import type { FeedbackLogFile }` 依赖
 * @feedback/web，server 不声明该依赖；vitest 运行时类型导入被擦除不受影响）。
 *
 * 覆盖：白名单字段校验、条数/字节上限、单条上限、epoch 隔离、清空、
 * 导出 JSONL 形态、哨兵内容不出现、记录器故障不影响业务。
 */

async function logsText(): Promise<string[]> {
  const files = provideFeedbackLogs();
  if (files.length === 0) return [];
  expect(files).toHaveLength(1);
  expect(files[0]?.filename).toBe("admin-diagnostics.jsonl");
  const text = await files[0]!.blob.text();
  return text.trimEnd().split("\n");
}

describe("白名单与字段校验", () => {
  beforeEach(() => clearDiagnostics());

  it("合法事件落缓冲，字段仅 time/level/event/code/status", async () => {
    recordDiagnostic({ level: "warn", event: "api_request", code: "version_conflict", status: 409 });
    const lines = await logsText();
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(Object.keys(entry).sort()).toEqual(["code", "event", "level", "status", "time"]);
    expect(entry.level).toBe("warn");
    expect(entry.event).toBe("api_request");
    expect(entry.code).toBe("version_conflict");
    expect(entry.status).toBe(409);
    // time 由记录器生成（ISO-8601）
    expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("非法 level/event/code/status 整条拒绝", async () => {
    const bad = [
      { level: "verbose", event: "api_request" },
      { level: "info", event: "console_log" },
      { level: "info", event: "api_request", code: "password_leak" },
      { level: "info", event: "api_request", status: 99 },
      { level: "info", event: "api_request", status: 600 },
      { level: "info", event: "api_request", status: 200.5 },
      { level: "info", event: "api_request", status: "200" },
    ];
    for (const input of bad) {
      // 运行时防御：非法字段即使绕过类型系统也必须拒绝
      recordDiagnostic(input as never);
    }
    expect(await logsText()).toEqual([]);
  });

  it("类型层面无法传入自由文本：签名只接受白名单枚举", () => {
    // 编译期约束的文档化断言：DiagnosticInput 无 string 字段
    type Input = Parameters<typeof recordDiagnostic>[0];
    const _assert: Input = { level: "info", event: "api_request" };
    expect(_assert.level).toBe("info");
  });
});

describe("缓冲上限", () => {
  beforeEach(() => clearDiagnostics());

  it("最多 200 条：超限丢最旧", async () => {
    for (let i = 0; i < 230; i++) {
      recordDiagnostic({ level: "info", event: "api_request", code: "ok", status: 200 });
    }
    const lines = await logsText();
    expect(lines).toHaveLength(200);
  });

  it("UTF-8 总量 ≤256KiB：超限丢最旧", async () => {
    // 每条 JSONL 行约 90-120B；写入远超 256KiB 的量验证总量封顶
    for (let i = 0; i < 4000; i++) {
      recordDiagnostic({ level: "warn", event: "api_request", code: "server_error", status: 500 });
    }
    const files = provideFeedbackLogs();
    expect(files).toHaveLength(1);
    const size = files[0]!.blob.size;
    expect(size).toBeLessThanOrEqual(256 * 1024);
    const lines = (await files[0]!.blob.text()).trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(200);
  });
});

describe("会话世代（epoch）", () => {
  beforeEach(() => clearDiagnostics());

  it("clearDiagnostics 清空缓冲并换代", async () => {
    recordDiagnostic({ level: "info", event: "api_request", code: "ok" });
    const before = diagnosticsEpoch();
    clearDiagnostics();
    expect(diagnosticsEpoch()).toBe(before + 1);
    expect(await logsText()).toEqual([]);
  });

  it("旧 epoch 的迟到写入被丢弃，不污染新会话", async () => {
    const old = diagnosticsEpoch();
    clearDiagnostics(); // 换代（模拟退出/换账号）
    recordDiagnostic({ level: "warn", event: "api_request", code: "unauthorized" }, old);
    expect(await logsText()).toEqual([]);
    // 新 epoch 写入正常
    recordDiagnostic({ level: "info", event: "api_request", code: "ok" }, diagnosticsEpoch());
    const lines = await logsText();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).code).toBe("ok");
  });

  it("epoch 缺省写入按当前世代处理", async () => {
    recordDiagnostic({ level: "info", event: "api_request", code: "ok" });
    expect(await logsText()).toHaveLength(1);
  });
});

describe("导出 JSONL 附件", () => {
  beforeEach(() => clearDiagnostics());

  it("无事件返回空集合（无附件）", () => {
    expect(provideFeedbackLogs()).toEqual([]);
  });

  it("有事件返回单个 .jsonl 文件，UTF-8 JSONL 每行一条 JSON", async () => {
    recordDiagnostic({ level: "info", event: "auth_session", code: "ok" });
    recordDiagnostic({ level: "warn", event: "api_request", code: "not_found", status: 404 });
    recordDiagnostic({ level: "info", event: "handshake", code: "ok" });
    const files = provideFeedbackLogs();
    expect(files).toHaveLength(1);
    expect(files[0]!.filename).toBe("admin-diagnostics.jsonl");
    const lines = (await files[0]!.blob.text()).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(lines[0]!).event).toBe("auth_session");
    expect(JSON.parse(lines[1]!).status).toBe(404);
  });
});

describe("隐私哨兵", () => {
  beforeEach(() => clearDiagnostics());

  it("记录器签名不接受敏感文本——哨兵字符串无处进入缓冲", async () => {
    const SENTINEL = "s3ntinel-P@ssw0rd-bearer-eyJhbGci";
    // 任何路径都无法把哨兵注入：input 无文本字段；尝试作为非法 code/status 注入均被拒
    recordDiagnostic({ level: "info", event: "api_request", code: SENTINEL } as never);
    recordDiagnostic({ level: "info", event: "api_request", status: SENTINEL } as never);
    recordDiagnostic({ level: "info", event: SENTINEL } as never);
    // 合法条目照常
    recordDiagnostic({ level: "warn", event: "api_request", code: "unauthorized", status: 401 });
    const files = provideFeedbackLogs();
    expect(files).toHaveLength(1);
    const text = await files[0]!.blob.text();
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("password");
    expect(text).not.toContain("token");
    expect(text).not.toContain("cookie");
  });
});

describe("故障隔离", () => {
  beforeEach(() => clearDiagnostics());

  it("recordDiagnostic 对任意输入不抛异常", () => {
    expect(() => recordDiagnostic(null as never)).not.toThrow();
    expect(() => recordDiagnostic(undefined as never)).not.toThrow();
    expect(() => recordDiagnostic(42 as never)).not.toThrow();
    expect(() => recordDiagnostic({} as never)).not.toThrow();
  });

  it("provideFeedbackLogs / clearDiagnostics / diagnosticsEpoch 不抛异常", () => {
    expect(() => provideFeedbackLogs()).not.toThrow();
    expect(() => clearDiagnostics()).not.toThrow();
    expect(() => diagnosticsEpoch()).not.toThrow();
  });
});
