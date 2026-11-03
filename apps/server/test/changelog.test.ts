import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Release, ReleaseInput } from "../src/db/changelog.ts";
import { openDb } from "../src/db/db.ts";
import {
  createUserBearer,
  defaultSubmitBody,
  jsonReq,
  makeHarness,
  seedApp,
  submitFeedback,
  TEST_PASSWORD,
} from "./helpers.ts";

type Harness = Awaited<ReturnType<typeof makeHarness>>;
const harnesses: Harness[] = [];
const directories: string[] = [];

async function setup(): Promise<Harness> {
  const h = await makeHarness();
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.feedbackApp.worker.idle();
    h.feedbackApp.close();
    h.feedbackApp.db.close();
    rmSync(h.config.dataDir, { recursive: true, force: true });
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function input(overrides: Partial<ReleaseInput> = {}): ReleaseInput {
  return {
    appId: "com.test.app",
    version: "1.2.0",
    releaseDate: "2026-11-04",
    summary: "导出体验更新",
    upgradeNotes: "重启后生效。",
    entries: [{ type: "fixed", title: "修复导出卡住", description: "后台完成大文件导出。", feedbacks: [] }],
    ...overrides,
  };
}

async function create(h: Harness, body = input()): Promise<Release> {
  const result = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/changelog", { cookie: h.cookie, body });
  expect(result.status, result.text).toBe(201);
  return result.data as Release;
}

async function publish(h: Harness, release: Release): Promise<Release> {
  const result = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/changelog/${release.id}/publish`, {
    cookie: h.cookie,
    body: { expectedRevision: release.revision },
  });
  expect(result.status, result.text).toBe(200);
  return result.data as Release;
}

async function feedback(h: Harness, bearer = h.bearer, appId = h.app.appId): Promise<string> {
  const result = await submitFeedback(
    h.feedbackApp,
    bearer,
    defaultSubmitBody({ appId, text: "只供管理员阅读的原始反馈" }),
  );
  expect(result.status, result.text).toBe(201);
  await h.feedbackApp.worker.idle();
  return result.data.feedbackId as string;
}

describe("软件更新日志", () => {
  it("保存草稿、回读、显式发布署名快照；公开 DTO、Markdown、页面只含公开内容", async () => {
    const h = await setup();
    const first = await feedback(h);
    const second = await feedback(h);
    const third = await feedback(h);
    const aiCalls = h.ai.calls;
    const writes = h.kaneo.remoteWrites;
    const draft = await create(
      h,
      input({
        entries: [
          {
            type: "fixed",
            title: "修复导出卡住",
            description: "后台完成大文件导出。",
            feedbacks: [
              { feedbackId: first, creditName: "小樱" },
              { feedbackId: second, creditName: "小樱" },
              { feedbackId: third, creditName: null },
            ],
          },
        ],
      }),
    );
    expect(draft.publishedAt).toBeNull();
    expect(draft.revision).toBe(1);
    const saved = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/changelog/${draft.id}`, { cookie: h.cookie });
    expect(saved.data).toEqual(draft);
    const list = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/changelog?appId=com.test.app", {
      cookie: h.cookie,
    });
    expect(list.data.items).toEqual([draft]);
    const privateView = await jsonReq(h.feedbackApp.app, "GET", "/api/changelog/com.test.app");
    expect(privateView.data.items).toEqual([]);
    const privatePage = await h.feedbackApp.app.request("http://localhost/changelog/com.test.app");
    expect(await privatePage.text()).not.toContain("修复导出卡住");

    const published = await publish(h, draft);
    expect(published.revision).toBe(2);
    expect(published.publishedAt).toBeTruthy();
    const publicView = await jsonReq(h.feedbackApp.app, "GET", "/api/changelog/com.test.app");
    expect(publicView.status).toBe(200);
    expect(publicView.data.items[0].entries[0].contributors).toEqual(["小樱", "匿名用户"]);
    expect(Object.keys(publicView.data.items[0]).sort()).toEqual(
      ["entries", "id", "publishedAt", "releaseDate", "summary", "upgradeNotes", "version"].sort(),
    );
    expect(Object.keys(publicView.data.items[0].entries[0]).sort()).toEqual([
      "contributors",
      "description",
      "title",
      "type",
    ]);
    for (const secret of [first, second, third, "只供管理员阅读的原始反馈", "feedbacks", "userId", "kaneo"]) {
      expect(publicView.text).not.toContain(secret);
    }
    const markdown = await jsonReq(h.feedbackApp.app, "GET", "/api/changelog/com.test.app/markdown");
    expect(markdown.text).toContain("## [1.2.0] — 2026-11-04");
    expect(markdown.text).toContain("### 修复\n");
    expect(markdown.text).toContain("感谢 小樱、匿名用户 提出反馈。");
    expect(markdown.text).not.toContain("### 新增");
    expect(markdown.text).not.toContain(first);
    const page = await h.feedbackApp.app.request("http://localhost/changelog/com.test.app");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("感谢 小樱、匿名用户 提出反馈。");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(h.ai.calls).toBe(aiCalls);
    expect(h.kaneo.remoteWrites).toBe(writes);
  });

  it("同软件版本唯一，乐观锁防止覆盖，已发布必须取消发布才能编辑", async () => {
    const h = await setup();
    const draft = await create(h);
    const duplicate = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/changelog", {
      cookie: h.cookie,
      body: input(),
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.data.error.code).toBe("release_exists");
    const edits = await Promise.all(
      ["甲", "乙"].map((summary) =>
        jsonReq(h.feedbackApp.app, "PUT", `/api/admin/changelog/${draft.id}`, {
          cookie: h.cookie,
          body: { ...input({ summary }), expectedRevision: 1 },
        }),
      ),
    );
    expect(edits.map((result) => result.status).sort()).toEqual([200, 409]);
    const updated = edits.find((result) => result.status === 200)!.data as Release;
    const stale = edits.find((result) => result.status === 409)!;
    expect(stale.data.error.code).toBe("version_conflict");
    const published = await publish(h, updated);
    const same = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/changelog/${draft.id}/publish`, {
      cookie: h.cookie,
      body: { expectedRevision: published.revision },
    });
    expect(same.data).toEqual(published);
    const edit = await jsonReq(h.feedbackApp.app, "PUT", `/api/admin/changelog/${draft.id}`, {
      cookie: h.cookie,
      body: { ...input(), expectedRevision: published.revision },
    });
    expect(edit.status).toBe(409);
    expect(edit.data.error.code).toBe("release_published");
    const unpublished = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/changelog/${draft.id}/unpublish`, {
      cookie: h.cookie,
      body: { expectedRevision: published.revision },
    });
    expect(unpublished.status).toBe(200);
    expect(unpublished.data.publishedAt).toBeNull();
    expect(unpublished.data.revision).toBe(published.revision + 1);
    const visible = await jsonReq(h.feedbackApp.app, "GET", "/api/changelog/com.test.app");
    expect(visible.data.items).toEqual([]);
    const editAgain = await jsonReq(h.feedbackApp.app, "PUT", `/api/admin/changelog/${draft.id}`, {
      cookie: h.cookie,
      body: { ...input({ summary: "再次编辑" }), expectedRevision: unpublished.data.revision },
    });
    expect(editAgain.status).toBe(200);
    expect(editAgain.data.summary).toBe("再次编辑");
  });

  it("关联不能跨软件、重复、引用回收站或不存在反馈；不能更换日志所属软件", async () => {
    const h = await setup();
    const own = await feedback(h);
    await seedApp(h.feedbackApp, h.cookie, { appId: "com.other.app" });
    const other = await feedback(h, h.bearer, "com.other.app");
    const trashed = await feedback(h);
    h.feedbackApp.db.prepare("UPDATE feedbacks SET mgmt_state = 'trash' WHERE id = ?").run(trashed);
    const attempts = [
      [{ feedbackId: "nonexistent", creditName: "甲" }],
      [{ feedbackId: other, creditName: "甲" }],
      [{ feedbackId: trashed, creditName: "甲" }],
      [
        { feedbackId: own, creditName: "甲" },
        { feedbackId: own, creditName: "乙" },
      ],
    ];
    for (const feedbacks of attempts) {
      const result = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/changelog", {
        cookie: h.cookie,
        body: input({ entries: [{ type: "fixed", title: "修复", description: "", feedbacks }] }),
      });
      expect(result.status, result.text).toBe(400);
      expect(result.data.error.code).toBe("invalid_request");
    }
    const draft = await create(h);
    const changedApp = await jsonReq(h.feedbackApp.app, "PUT", `/api/admin/changelog/${draft.id}`, {
      cookie: h.cookie,
      body: { ...input({ appId: "com.other.app" }), expectedRevision: draft.revision },
    });
    expect(changedApp.status).toBe(400);
    const otherRelease = await create(h, input({ appId: "com.other.app" }));
    expect(otherRelease.appId).toBe("com.other.app");
  });

  it("校验真实日期、内容上限、单行字段、署名以及 JSON 请求体边界", async () => {
    const h = await setup();
    const id = await feedback(h);
    const invalidBodies: unknown[] = [
      null,
      [],
      "x",
      input({ releaseDate: "2026-02-30" }),
      input({ releaseDate: "2026-2-03" }),
      input({ version: "v1\n### injected" }),
      input({ entries: [] }),
      input({ summary: "x".repeat(2001) }),
      input({ entries: [{ type: "fixed", title: "", description: "", feedbacks: [] }] }),
      input({
        entries: [{ type: "fixed", title: "修复", description: "", feedbacks: [{ feedbackId: id, creditName: " " }] }],
      }),
      input({
        entries: [
          { type: "fixed", title: "修复", description: "", feedbacks: [{ feedbackId: id, creditName: "甲\n乙" }] },
        ],
      }),
    ];
    for (const body of invalidBodies) {
      const result = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/changelog", { cookie: h.cookie, body });
      expect(result.status, JSON.stringify(body)).toBe(400);
    }
    const oversized = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/changelog", {
      cookie: h.cookie,
      body: input({ summary: "x".repeat(65536) }),
    });
    expect(oversized.status).toBe(413);
    const leapDay = await create(h, input({ releaseDate: "2028-02-29" }));
    expect(leapDay.releaseDate).toBe("2028-02-29");
    const noRevision = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/changelog/${leapDay.id}/publish`, {
      cookie: h.cookie,
      body: { expectedRevision: "1" },
    });
    expect(noRevision.status).toBe(400);
  });

  it("只有管理员 Cookie 可写；公开跨域接口只允许匿名读取且不开放凭据", async () => {
    const h = await setup();
    const bearer = await createUserBearer(h, { username: "release-reader" });
    const login = await jsonReq(h.feedbackApp.app, "POST", "/api/auth/login", {
      body: { username: "release-reader", password: TEST_PASSWORD },
    });
    const userCookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    for (const auth of [{}, { cookie: userCookie }, { bearer }, { cookie: h.cookie, origin: "http://attacker.test" }]) {
      const result = await jsonReq(h.feedbackApp.app, "POST", "/api/admin/changelog", { ...auth, body: input() });
      expect([401, 403]).toContain(result.status);
    }
    const publicRead = await jsonReq(h.feedbackApp.app, "GET", "/api/changelog/com.test.app", {
      origin: "https://host.example",
    });
    expect(publicRead.status).toBe(200);
    expect(publicRead.headers.get("access-control-allow-origin")).toBe("*");
    expect(publicRead.headers.get("access-control-allow-credentials")).toBeNull();
    const preflight = await jsonReq(h.feedbackApp.app, "OPTIONS", "/api/changelog/com.test.app", {
      origin: "https://host.example",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    const publicWrite = await jsonReq(h.feedbackApp.app, "POST", "/api/changelog/com.test.app", { body: input() });
    expect(publicWrite.status).toBe(405);
    const unknown = await jsonReq(h.feedbackApp.app, "GET", "/api/changelog/com.unknown");
    expect(unknown.status).toBe(404);
  });

  it("标题/署名/软件名中的 HTML 与 Markdown 不执行；页面与导出都只用公开快照", async () => {
    const h = await setup();
    const id = await feedback(h);
    const dangerous = '<script>alert("x")</script>';
    h.feedbackApp.db.prepare("UPDATE apps SET name = ? WHERE id = ?").run(dangerous, h.app.id);
    const draft = await create(
      h,
      input({
        version: "1.0.0",
        summary: dangerous,
        entries: [
          {
            type: "added",
            title: "[查看](javascript:alert(1))",
            description: dangerous,
            feedbacks: [{ feedbackId: id, creditName: dangerous }],
          },
        ],
      }),
    );
    await publish(h, draft);
    const pageResponse = await h.feedbackApp.app.request("http://localhost/changelog/com.test.app");
    const page = await pageResponse.text();
    expect(page).not.toContain("<script>");
    expect(page).toContain("&lt;script&gt;");
    expect(page).not.toContain('href="javascript:');
    const markdownResponse = await h.feedbackApp.app.request("http://localhost/api/changelog/com.test.app/markdown");
    const markdown = await markdownResponse.text();
    expect(markdown).not.toContain("<script>");
    expect(markdown).toContain("&lt;script&gt;");
    expect(markdown).toContain("\\[查看\\]\\(javascript:alert\\(1\\)\\)");
    expect(markdown).not.toContain(id);
  });

  it("署名不随账号/反馈更改；删除软件停用公开入口，重新登记仍按 appId 保留日志", async () => {
    const h = await setup();
    const id = await feedback(h);
    const draft = await create(
      h,
      input({
        entries: [
          {
            type: "improved",
            title: "改善导出",
            description: "",
            feedbacks: [{ feedbackId: id, creditName: "原昵称" }],
          },
        ],
      }),
    );
    await publish(h, draft);
    h.feedbackApp.db.prepare("UPDATE users SET username = 'renamed', enabled = 0 WHERE username = 'admin'").run();
    h.feedbackApp.db.prepare("DELETE FROM feedbacks WHERE id = ?").run(id);
    const snapshot = await jsonReq(h.feedbackApp.app, "GET", "/api/changelog/com.test.app");
    expect(snapshot.data.items[0].entries[0].contributors).toEqual(["原昵称"]);
    h.feedbackApp.db.prepare("UPDATE users SET username = 'admin', enabled = 1 WHERE username = 'renamed'").run();
    h.feedbackApp.db.prepare("UPDATE apps SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), h.app.id);
    const deleted = await jsonReq(h.feedbackApp.app, "GET", "/api/changelog/com.test.app");
    expect(deleted.status).toBe(404);
    const management = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/changelog?appId=com.test.app", {
      cookie: h.cookie,
    });
    expect(management.data.items).toHaveLength(1);
    await seedApp(h.feedbackApp, h.cookie, { appId: "com.test.app" });
    const restored = await jsonReq(h.feedbackApp.app, "GET", "/api/changelog/com.test.app");
    expect(restored.data.items[0].entries[0].contributors).toEqual(["原昵称"]);
  });

  it("仅已发布版本按日期倒序返回，不混入其他软件", async () => {
    const h = await setup();
    const older = await create(h, input({ version: "1.0.0", releaseDate: "2026-10-01" }));
    const newer = await create(h, input({ version: "1.1.0", releaseDate: "2026-11-01" }));
    await create(h, input({ version: "2.0.0", releaseDate: "2026-12-01" }));
    await seedApp(h.feedbackApp, h.cookie, { appId: "com.other.app" });
    await publish(h, await create(h, input({ appId: "com.other.app" })));
    await publish(h, older);
    await publish(h, newer);
    const result = await jsonReq(h.feedbackApp.app, "GET", "/api/changelog/com.test.app");
    expect(result.data.items.map((release: Release) => release.version)).toEqual(["1.1.0", "1.0.0"]);
  });

  it("历史反馈删除后可保留关联修正日志并重新发布，新增关联仍须有效", async () => {
    const h = await setup();
    const id = await feedback(h);
    const body = input({
      entries: [
        { type: "fixed", title: "修复导出", description: "", feedbacks: [{ feedbackId: id, creditName: "原昵称" }] },
      ],
    });
    const published = await publish(h, await create(h, body));
    h.feedbackApp.db.prepare("DELETE FROM feedbacks WHERE id = ?").run(id);
    const unpublished = await jsonReq(h.feedbackApp.app, "POST", `/api/admin/changelog/${published.id}/unpublish`, {
      cookie: h.cookie,
      body: { expectedRevision: published.revision },
    });
    expect(unpublished.status).toBe(200);
    const invalidNewLink = await jsonReq(h.feedbackApp.app, "PUT", `/api/admin/changelog/${published.id}`, {
      cookie: h.cookie,
      body: {
        ...body,
        expectedRevision: unpublished.data.revision,
        entries: [
          {
            ...body.entries[0],
            feedbacks: [...body.entries[0]!.feedbacks, { feedbackId: "not-a-snapshot", creditName: "乙" }],
          },
        ],
      },
    });
    expect(invalidNewLink.status).toBe(400);
    const corrected = await jsonReq(h.feedbackApp.app, "PUT", `/api/admin/changelog/${published.id}`, {
      cookie: h.cookie,
      body: {
        ...body,
        expectedRevision: unpublished.data.revision,
        summary: "更正更新摘要",
        entries: [{ ...body.entries[0], feedbacks: [{ feedbackId: id, creditName: "新昵称" }] }],
      },
    });
    expect(corrected.status, corrected.text).toBe(200);
    await publish(h, corrected.data as Release);
    const visible = await jsonReq(h.feedbackApp.app, "GET", "/api/changelog/com.test.app");
    expect(visible.data.items[0].summary).toBe("更正更新摘要");
    expect(visible.data.items[0].entries[0].contributors).toEqual(["新昵称"]);
    expect(visible.text).not.toContain(id);
  });

  it("无反馈的软件删除后仍保留日志管理入口，重新登记优先活跃名称，再删除取最新历史名称", async () => {
    const h = await setup();
    const release = await publish(h, await create(h));
    await seedApp(h.feedbackApp, h.cookie, { appId: "com.empty.app" });
    const deleted = await jsonReq(h.feedbackApp.app, "DELETE", `/api/admin/apps/${h.app.id}`, { cookie: h.cookie });
    expect(deleted.status).toBe(204);
    const options = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/changelog/apps", { cookie: h.cookie });
    expect(options.status).toBe(200);
    expect(options.data.items).toEqual(
      expect.arrayContaining([
        { appId: "com.test.app", name: "测试软件", deleted: true },
        { appId: "com.empty.app", name: "测试软件", deleted: false },
      ]),
    );
    expect((await jsonReq(h.feedbackApp.app, "GET", "/api/changelog/com.test.app")).status).toBe(404);
    const history = await jsonReq(h.feedbackApp.app, "GET", `/api/admin/changelog/${release.id}`, { cookie: h.cookie });
    expect(history.data).toEqual(release);
    const replacement = await seedApp(h.feedbackApp, h.cookie, { appId: "com.test.app" });
    h.feedbackApp.db.prepare("UPDATE apps SET name = '重新登记软件' WHERE id = ?").run(replacement.id);
    const active = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/changelog/apps", { cookie: h.cookie });
    expect(active.data.items.filter((app: { appId: string }) => app.appId === "com.test.app")).toEqual([
      { appId: "com.test.app", name: "重新登记软件", deleted: false },
    ]);
    h.feedbackApp.db.prepare("UPDATE apps SET deleted_at = ? WHERE id = ?").run("2026-11-01T00:00:00.000Z", h.app.id);
    h.feedbackApp.db
      .prepare("UPDATE apps SET deleted_at = ? WHERE id = ?")
      .run("2026-11-03T00:00:00.000Z", replacement.id);
    const newest = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/changelog/apps", { cookie: h.cookie });
    expect(newest.data.items.filter((app: { appId: string }) => app.appId === "com.test.app")).toEqual([
      { appId: "com.test.app", name: "重新登记软件", deleted: true },
    ]);
  });

  it("仅日志保有的 appId 无软件记录时回退标识；无日志的已删除软件不加入选项", async () => {
    const h = await setup();
    const release = await create(h);
    h.feedbackApp.db.prepare("UPDATE changelog_releases SET app_id = 'com.missing.app' WHERE id = ?").run(release.id);
    const deleted = await jsonReq(h.feedbackApp.app, "DELETE", `/api/admin/apps/${h.app.id}`, { cookie: h.cookie });
    expect(deleted.status).toBe(204);
    const options = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/changelog/apps", { cookie: h.cookie });
    expect(options.data.items).toEqual([{ appId: "com.missing.app", name: "com.missing.app", deleted: true }]);
    const anonymous = await jsonReq(h.feedbackApp.app, "GET", "/api/admin/changelog/apps");
    expect(anonymous.status).toBe(401);
  });
});

describe("更新日志 schema 15 迁移", () => {
  it("schema 14 数据原样保留，新增版本表，重开幂等", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "feedback-changelog-migration-"));
    directories.push(directory);
    const initial = openDb(directory);
    initial.exec("DROP TABLE changelog_releases; PRAGMA user_version = 14;");
    initial.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("legacy-marker", "保留的旧配置");
    const legacyTables = initial.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    initial.close();
    const upgraded = openDb(directory);
    expect(upgraded.prepare("PRAGMA user_version").get()).toEqual({ user_version: 15 });
    expect(upgraded.prepare("SELECT value FROM settings WHERE key = 'legacy-marker'").get()).toEqual({
      value: "保留的旧配置",
    });
    expect(upgraded.prepare("SELECT COUNT(*) AS count FROM changelog_releases").get()).toEqual({ count: 0 });
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual(
      expect.arrayContaining(legacyTables),
    );
    upgraded.close();
    const reopened = openDb(directory);
    expect(reopened.prepare("PRAGMA user_version").get()).toEqual({ user_version: 15 });
    expect(reopened.prepare("SELECT value FROM settings WHERE key = 'legacy-marker'").get()).toEqual({
      value: "保留的旧配置",
    });
    reopened.close();
  });

  it("迁移建索引失败时不提前更新 schema 版本", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "feedback-changelog-migration-error-"));
    directories.push(directory);
    const initial = openDb(directory);
    initial.exec("DROP TABLE changelog_releases; CREATE TABLE changelog_releases(id TEXT); PRAGMA user_version = 14;");
    initial.close();
    expect(() => openDb(directory)).toThrow();
    const legacy = new DatabaseSync(path.join(directory, "feedback.db"));
    expect(legacy.prepare("PRAGMA user_version").get()).toEqual({ user_version: 14 });
    legacy.close();
  });
});
