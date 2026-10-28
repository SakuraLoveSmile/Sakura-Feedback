import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/db.ts";
import {
  addFeedbackMessageAtomic,
  applyLifecycleInTx,
  confirmCancellationInTx,
  createCancellationTaskInTx,
  getCancellationTask,
  getFeedback,
  getMessageAttachment,
  getPendingCancellationTasks,
  getReadCursor,
  getUnreadSummaryForUser,
  insertFeedback,
  insertFeedbackWithScreenshot,
  listFeedbackMessages,
  listUserFeedbacks,
  markReadCursor,
  updateIssueStatusInTx,
} from "../src/db/repos.ts";

function setupTestDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "fb-dialogue-test-"));
  const db = openDb(dir);
  // 创建测试 app
  const appId = "com.test.dialogue";
  const appRowId = "app-row-1";
  db.prepare(
    `INSERT INTO apps (id, app_id, name, config_status, archive_mode, created_at, updated_at)
     VALUES (?, ?, 'Test App', 'configured', 'manual', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(appRowId, appId);

  // 创建测试用户
  const userId = "user-1";
  db.prepare(
    `INSERT INTO users (id, username, pass_hash, role, created_at)
     VALUES (?, 'testuser', 'hash', 'user', '2026-01-01T00:00:00.000Z')`,
  ).run(userId);

  const adminId = "admin-1";
  db.prepare(
    `INSERT INTO users (id, username, pass_hash, role, created_at)
     VALUES (?, 'admin', 'hash', 'admin', '2026-01-01T00:00:00.000Z')`,
  ).run(adminId);

  return { db, dir, appId, appRowId, userId, adminId };
}

describe("v11: 对话、消息、已读游标与撤销任务仓储", () => {
  it("创建反馈时自动设置 issue_status 为 open、dialogue_version 为 0、archive_round 为 1", () => {
    const { db, appRowId, appId, userId } = setupTestDb();
    const fb = insertFeedback(db, {
      appId,
      appRowId,
      userId,
      text: "初始反馈问题描述",
      contextJson: null,
      idempotencyKey: "key-1",
      contentHash: "hash-1",
    });

    expect(fb.issue_status).toBe("open");
    expect(fb.dialogue_version).toBe(0);
    expect(fb.archive_round).toBe(1);
    expect(fb.last_activity_at).toBe(fb.created_at);
  });

  it("管理员与用户消息追加：自增 seq、递增 dialogue_version、推进已读游标与时间线", () => {
    const { db, appRowId, appId, userId, adminId } = setupTestDb();
    const fb = insertFeedback(db, {
      appId,
      appRowId,
      userId,
      text: "初始反馈",
      contextJson: null,
      idempotencyKey: "key-seq",
      contentHash: "hash-seq",
    });

    // 管理员发第 1 条消息（请求补充）
    const r1 = addFeedbackMessageAtomic(db, {
      feedbackId: fb.id,
      senderType: "admin",
      senderId: adminId,
      senderName: "管理员",
      text: "请提供复现步骤与截图",
      newIssueStatus: "waiting_user",
    });

    expect(r1.kind).toBe("created");
    if (r1.kind !== "created") return;
    expect(r1.message.seq).toBe(1);
    expect(r1.dialogueVersion).toBe(1);
    expect(r1.issueStatus).toBe("waiting_user");

    // 管理员已读自动推进到 1；用户尚未读，未读数量为 1
    expect(getReadCursor(db, adminId, fb.id)).toBe(1);
    expect(getReadCursor(db, userId, fb.id)).toBe(0);

    const unread = getUnreadSummaryForUser(db, userId, appId);
    expect(unread.unreadFeedbacksCount).toBe(1);
    expect(unread.totalUnreadMessages).toBe(1);

    // 用户标记已读到 seq 1
    markReadCursor(db, userId, fb.id, 1);
    expect(getReadCursor(db, userId, fb.id)).toBe(1);
    const unreadAfter = getUnreadSummaryForUser(db, userId, appId);
    expect(unreadAfter.unreadFeedbacksCount).toBe(0);
    expect(unreadAfter.totalUnreadMessages).toBe(0);

    // 用户发回复：带附件（截图与日志），自动恢复为 waiting_admin
    const r2 = addFeedbackMessageAtomic(db, {
      feedbackId: fb.id,
      senderType: "user",
      senderId: userId,
      senderName: "testuser",
      text: "已补充截图和日志",
      idempotencyKey: "msg-idem-1",
      attachments: [
        {
          kind: "screenshot",
          filename: "shot.png",
          byteSize: 100,
          sha256: "sha-shot",
          bytes: new Uint8Array([1, 2, 3]),
          width: 800,
          height: 600,
        },
        {
          kind: "log",
          filename: "error.log",
          byteSize: 50,
          sha256: "sha-log",
          bytes: Buffer.from("error stack trace"),
        },
      ],
    });

    expect(r2.kind).toBe("created");
    if (r2.kind !== "created") return;
    expect(r2.message.seq).toBe(2);
    expect(r2.dialogueVersion).toBe(2);
    expect(r2.issueStatus).toBe("waiting_admin");
    expect(r2.attachments).toHaveLength(2);

    // 幂等重放：同键 + 同文本 + 同附件摘要 → replayed（v12：附件摘要纳入比较）
    const sameAtts = [
      {
        kind: "screenshot" as const,
        filename: "shot.png",
        byteSize: 100,
        sha256: "sha-shot",
        bytes: new Uint8Array([1, 2, 3]),
        width: 800,
        height: 600,
      },
      {
        kind: "log" as const,
        filename: "error.log",
        byteSize: 50,
        sha256: "sha-log",
        bytes: Buffer.from("error stack trace"),
      },
    ];
    const replay = addFeedbackMessageAtomic(db, {
      feedbackId: fb.id,
      senderType: "user",
      senderId: userId,
      senderName: "testuser",
      text: "已补充截图和日志",
      idempotencyKey: "msg-idem-1",
      attachments: sameAtts,
    });
    expect(replay.kind).toBe("replayed");

    // 同键但附件摘要不同 → conflict（v12：不再允许带附件回复在丢附件的情况下被判重放）
    const replayNoAtt = addFeedbackMessageAtomic(db, {
      feedbackId: fb.id,
      senderType: "user",
      senderId: userId,
      senderName: "testuser",
      text: "已补充截图和日志",
      idempotencyKey: "msg-idem-1",
    });
    expect(replayNoAtt.kind).toBe("conflict");

    // 检查列表查询与附件读取
    const list = listFeedbackMessages(db, fb.id);
    expect(list).toHaveLength(2);
    expect(list[0]?.sender_type).toBe("admin");
    expect(list[1]?.sender_type).toBe("user");
    expect(list[1]?.attachments).toHaveLength(2);

    const firstAtt = list[1]?.attachments[0];
    expect(firstAtt).toBeDefined();
    const att = getMessageAttachment(db, firstAtt!.id);
    expect(att).not.toBeNull();
    expect(att?.filename).toBe("shot.png");
    expect(att?.width).toBe(800);
  });

  it("已解决反馈收到用户回复后自动恢复为 waiting_admin", () => {
    const { db, appRowId, appId, userId } = setupTestDb();
    const fb = insertFeedback(db, {
      appId,
      appRowId,
      userId,
      text: "初始反馈",
      contextJson: null,
      idempotencyKey: "key-resolved-flow",
      contentHash: "hash-resolved",
    });

    // 管理员标记已解决
    const updateRes = updateIssueStatusInTx(db, fb.id, "resolved", { id: "admin-1", username: "admin" });
    expect(updateRes.ok).toBe(true);
    expect(getFeedback(db, fb.id)?.issue_status).toBe("resolved");

    // 用户回复：自动恢复为 waiting_admin
    const r = addFeedbackMessageAtomic(db, {
      feedbackId: fb.id,
      senderType: "user",
      senderId: userId,
      senderName: "testuser",
      text: "问题依然存在，请重新核实",
    });
    expect(r.kind).toBe("created");
    if (r.kind !== "created") return;
    expect(r.issueStatus).toBe("waiting_admin");
    expect(getFeedback(db, fb.id)?.issue_status).toBe("waiting_admin");
  });

  it("已同步到 Kaneo 的反馈收到用户回复：移回收件箱、暂停自动归档，但不创建撤销任务（v12）", () => {
    const { db, appRowId, appId, userId } = setupTestDb();
    const fb = insertFeedback(db, {
      appId,
      appRowId,
      userId,
      text: "已同步反馈",
      contextJson: null,
      idempotencyKey: "key-kaneo-cancel",
      contentHash: "hash-kaneo",
    });

    // 模拟已同步状态与远端任务
    db.prepare(
      `UPDATE feedbacks
       SET status = 'archived',
           mgmt_state = 'archived',
           kaneo_task_id = 'task-12345',
           kaneo_task_url = 'https://kaneo.example.com/task/12345',
           archive_data_json = ?
       WHERE id = ?`,
    ).run(
      JSON.stringify({
        target: {
          apiBase: "https://kaneo.example.com/api",
          projectId: "proj-1",
          workspaceId: "ws-1",
        },
      }),
      fb.id,
    );

    // 用户发出回复
    const res = addFeedbackMessageAtomic(db, {
      feedbackId: fb.id,
      senderType: "user",
      senderId: userId,
      senderName: "testuser",
      text: "补充说明",
    });

    expect(res.kind).toBe("created");

    // 检查反馈状态变化
    const updated = getFeedback(db, fb.id);
    expect(updated?.mgmt_state).toBe("inbox"); // 移回收件箱
    expect(updated?.resume_paused).toBe(1); // 暂停自动归档
    expect(updated?.issue_status).toBe("waiting_admin");

    // v12：不再登记撤销任务；原 Kaneo 任务链接保留，round 不递增。
    const cancelTask = getCancellationTask(db, fb.id, 1);
    expect(cancelTask).toBeNull();
    expect(getPendingCancellationTasks(db).some((p) => p.feedback_id === fb.id)).toBe(false);

    const keptFb = getFeedback(db, fb.id);
    expect(keptFb?.kaneo_task_id).toBe("task-12345");
    expect(keptFb?.kaneo_task_url).toBe("https://kaneo.example.com/task/12345");
    expect(keptFb?.archive_round).toBe(1);
  });

  it("彻底删除保护：未完成 Kaneo 撤销任务时阻止永久删除；撤销完成后允许彻底删除并清理对话", () => {
    const { db, appRowId, appId, userId, adminId } = setupTestDb();
    const fb = insertFeedback(db, {
      appId,
      appRowId,
      userId,
      text: "彻底删除测试",
      contextJson: null,
      idempotencyKey: "key-purge-guard",
      contentHash: "hash-purge",
    });

    // 移入回收站
    db.prepare("UPDATE feedbacks SET mgmt_state = 'trash' WHERE id = ?").run(fb.id);

    // 模拟存在尚未完成的撤销任务
    createCancellationTaskInTx(db, {
      ...fb,
      kaneo_task_id: "task-pending-del",
    });

    // 尝试彻底删除：应被阻止
    const purgeBlocked = applyLifecycleInTx(db, fb.id, {
      action: "purge",
      expectedVersion: 0,
      actor: { id: adminId, username: "admin" },
    });
    expect(purgeBlocked.kind).toBe("invalid_state");

    // 确认撤销完成
    confirmCancellationInTx(db, fb.id, 1, "2026-01-01T02:00:00.000Z");

    // 再次尝试彻底删除：成功
    const purgeSuccess = applyLifecycleInTx(db, fb.id, {
      action: "purge",
      expectedVersion: 0,
      actor: { id: adminId, username: "admin" },
    });
    expect(purgeSuccess.kind).toBe("purged");

    // 确认数据与关联对话、附件已被彻底清除
    expect(getFeedback(db, fb.id)).toBeNull();
    expect(listFeedbackMessages(db, fb.id)).toHaveLength(0);
  });

  it("用户历史列表：分页、排序与未读标识", () => {
    const { db, appRowId, appId, userId, adminId } = setupTestDb();

    // 插入两条反馈
    const fb1 = insertFeedback(db, {
      appId,
      appRowId,
      userId,
      text: "反馈 1",
      contextJson: null,
      idempotencyKey: "key-u-1",
      contentHash: "hash-u-1",
    });

    const fb2 = insertFeedback(db, {
      appId,
      appRowId,
      userId,
      text: "反馈 2",
      contextJson: null,
      idempotencyKey: "key-u-2",
      contentHash: "hash-u-2",
    });

    // 毫秒精度下，新消息可能与反馈创建时间相同；活动时间仍须推进。
    // 取 fb1 活动时间 +1s 保证 fb1 严格排在 fb2 之前（等时则由 id 降序决定，见下方 tied 用例）。
    vi.useFakeTimers();
    vi.setSystemTime(new Date(new Date(fb1.last_activity_at).getTime() + 1000));
    try {
      addFeedbackMessageAtomic(db, {
        feedbackId: fb1.id,
        senderType: "admin",
        senderId: adminId,
        senderName: "管理员",
        text: "回复 fb1",
      });
    } finally {
      vi.useRealTimers();
    }

    const list = listUserFeedbacks(db, userId, { appId, page: 1, limit: 10 });
    expect(list.total).toBe(2);
    expect(list.unreadTotal).toBe(1);
    // fb1 应该排在第一位（lastActivityAt 更新）
    expect(list.items[0]?.id).toBe(fb1.id);
    expect(list.items[0]?.unread).toBe(true);
    expect(list.items[0]?.messageCount).toBe(1);
    expect(list.items[0]?.latestMessage?.text).toBe("回复 fb1");

    expect(list.items[1]?.id).toBe(fb2.id);
    expect(list.items[1]?.unread).toBe(false);

    // 活动时间完全相同时，UUID 降序是稳定的分页 tie-breaker。
    db.prepare("UPDATE feedbacks SET last_activity_at = ? WHERE id IN (?, ?)").run(
      "2026-01-01T00:00:00.000Z",
      fb1.id,
      fb2.id,
    );
    const tied = listUserFeedbacks(db, userId, { appId, page: 1, limit: 10 });
    expect(tied.items.map((item) => item.id)).toEqual([fb1.id, fb2.id].sort((a, b) => b.localeCompare(a)));
  });
});

describe("S1: listUserFeedbacks 输出 appName 与附件计数", () => {
  function makeImg(id: string): import("../src/db/repos.ts").FeedbackImageInput {
    return {
      id,
      mime: "image/png",
      filename: `${id}.png`,
      byteSize: 3,
      sha256: `sha-${id}`,
      bytes: new Uint8Array([1, 2, 3]),
      width: 10,
      height: 10,
      captureJson: null,
      source: "manual",
    };
  }
  function makeLog(id: string): import("../src/db/repos.ts").LogInput {
    return {
      id,
      filename: `${id}.log`,
      source: "manual",
      bytes: new Uint8Array([9, 9]),
      byteSize: 2,
      sha256: `sha-log-${id}`,
    };
  }

  it("同一用户跨两个项目提交：各条目携带正确的 appName（改造核心动机）", () => {
    const { db, appRowId, appId, userId } = setupTestDb();
    // 第二个项目
    const appRowId2 = "app-row-2";
    const appId2 = "com.test.other";
    db.prepare(
      `INSERT INTO apps (id, app_id, name, config_status, archive_mode, created_at, updated_at)
       VALUES (?, ?, 'Other App', 'configured', 'manual', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(appRowId2, appId2);

    const fbA = insertFeedback(db, {
      appId,
      appRowId,
      userId,
      text: "项目 A 的反馈",
      contextJson: null,
      idempotencyKey: "cross-a",
      contentHash: "h-cross-a",
    });
    const fbB = insertFeedback(db, {
      appId: appId2,
      appRowId: appRowId2,
      userId,
      text: "项目 B 的反馈",
      contextJson: null,
      idempotencyKey: "cross-b",
      contentHash: "h-cross-b",
    });

    const list = listUserFeedbacks(db, userId, { page: 1, limit: 10 });
    const byId = new Map(list.items.map((i) => [i.id, i]));
    expect(byId.get(fbA.id)?.appName).toBe("Test App");
    expect(byId.get(fbA.id)?.appId).toBe(appId);
    expect(byId.get(fbB.id)?.appName).toBe("Other App");
    expect(byId.get(fbB.id)?.appId).toBe(appId2);
  });

  it("图片计数=两表之和，日志计数=feedback_logs 行数；无附件为 0", () => {
    const { db, appRowId, appId, userId } = setupTestDb();

    // 多图 + 多日志
    const fbMulti = insertFeedbackWithScreenshot(
      db,
      {
        appId,
        appRowId,
        userId,
        text: "多图多日志",
        contextJson: null,
        idempotencyKey: "cnt-multi",
        contentHash: "h1",
      },
      null,
      [makeLog("l1"), makeLog("l2"), makeLog("l3")],
      [makeImg("i1"), makeImg("i2")],
    );
    // 旧单图截图（feedback_screenshots）
    const fbShot = insertFeedbackWithScreenshot(
      db,
      { appId, appRowId, userId, text: "单截图", contextJson: null, idempotencyKey: "cnt-shot", contentHash: "h2" },
      { pngBlob: new Uint8Array([1, 2, 3]), width: 10, height: 10, byteSize: 3, sha256: "s", captureJson: null },
    );
    // 无任何附件
    const fbNone = insertFeedback(db, {
      appId,
      appRowId,
      userId,
      text: "无附件",
      contextJson: null,
      idempotencyKey: "cnt-none",
      contentHash: "h3",
    });

    const list = listUserFeedbacks(db, userId, { page: 1, limit: 10 });
    const byId = new Map(list.items.map((i) => [i.id, i]));
    expect(byId.get(fbMulti.id)?.imageCount).toBe(2);
    expect(byId.get(fbMulti.id)?.logCount).toBe(3);
    expect(byId.get(fbShot.id)?.imageCount).toBe(1);
    expect(byId.get(fbShot.id)?.logCount).toBe(0);
    expect(byId.get(fbNone.id)?.imageCount).toBe(0);
    expect(byId.get(fbNone.id)?.logCount).toBe(0);
  });

  it("同一反馈同时存在旧截图与新图片时，imageCount 为两表相加（口径：截图至多 1 行，不去重轮次）", () => {
    const { db, appRowId, appId, userId } = setupTestDb();
    // 先建带 1 张 feedback_images 的反馈，再手工补一行旧截图，构造两表都有行的异常状态。
    const fb = insertFeedbackWithScreenshot(
      db,
      { appId, appRowId, userId, text: "两表并存", contextJson: null, idempotencyKey: "both", contentHash: "hb" },
      null,
      null,
      [makeImg("x1")],
    );
    db.prepare(
      `INSERT INTO feedback_screenshots (feedback_id, png_blob, width, height, byte_size, sha256, created_at)
       VALUES (?, ?, 8, 8, 3, 'ss', '2026-01-01T00:00:00.000Z')`,
    ).run(fb.id, new Uint8Array([4, 5, 6]));

    const list = listUserFeedbacks(db, userId, { appId, page: 1, limit: 10 });
    // feedback_screenshots 以 feedback_id 为主键，物理上每反馈至多 1 行，不存在「多轮归档截图」重复；
    // 因此计数口径为 feedback_images 行数 + feedback_screenshots 行数（此处 1 + 1 = 2）。
    expect(list.items.find((i) => i.id === fb.id)?.imageCount).toBe(2);
  });

  it("apps 行缺失时 appName 为 null 且不抛错", () => {
    const { db, appId, userId } = setupTestDb();
    db.exec("PRAGMA foreign_keys = OFF");
    const fb = insertFeedback(db, {
      appId,
      appRowId: "missing-app-row",
      userId,
      text: "指向不存在的项目行",
      contextJson: null,
      idempotencyKey: "noapp",
      contentHash: "hn",
    });
    const list = listUserFeedbacks(db, userId, { page: 1, limit: 10 });
    const item = list.items.find((i) => i.id === fb.id);
    expect(item?.appName).toBeNull();
    // 前端可回退显示 appId
    expect(item?.appId).toBe(appId);
  });

  it("apps 行被软删时 appName 为 null", () => {
    const { db, appRowId, appId, userId } = setupTestDb();
    const fb = insertFeedback(db, {
      appId,
      appRowId,
      userId,
      text: "项目已软删",
      contextJson: null,
      idempotencyKey: "softdel",
      contentHash: "hs",
    });
    db.prepare("UPDATE apps SET deleted_at = ? WHERE id = ?").run("2026-02-01T00:00:00.000Z", appRowId);
    const list = listUserFeedbacks(db, userId, { page: 1, limit: 10 });
    expect(list.items.find((i) => i.id === fb.id)?.appName).toBeNull();
  });

  it("按 appId 过滤时 total 与 items 一致（防 LEFT JOIN apps 造成行数放大回归）", () => {
    const { db, appRowId, appId, userId } = setupTestDb();
    const appRowId2 = "app-row-2";
    const appId2 = "com.test.other";
    db.prepare(
      `INSERT INTO apps (id, app_id, name, config_status, archive_mode, created_at, updated_at)
       VALUES (?, ?, 'Other App', 'configured', 'manual', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(appRowId2, appId2);

    // 项目 A：3 条（其中 1 条带图片/日志附件，验证 JOIN 不因附件子查询放大）
    for (let i = 0; i < 3; i++) {
      insertFeedbackWithScreenshot(
        db,
        {
          appId,
          appRowId,
          userId,
          text: `A-${i}`,
          contextJson: null,
          idempotencyKey: `fa-${i}`,
          contentHash: `ca-${i}`,
        },
        i === 0
          ? { pngBlob: new Uint8Array([1]), width: 1, height: 1, byteSize: 1, sha256: "z", captureJson: null }
          : null,
        i === 0 ? [makeLog("la"), makeLog("lb")] : null,
      );
    }
    // 项目 B：2 条
    for (let i = 0; i < 2; i++) {
      insertFeedback(db, {
        appId: appId2,
        appRowId: appRowId2,
        userId,
        text: `B-${i}`,
        contextJson: null,
        idempotencyKey: `fb-${i}`,
        contentHash: `cb-${i}`,
      });
    }

    const filtered = listUserFeedbacks(db, userId, { appId, page: 1, limit: 10 });
    expect(filtered.total).toBe(3);
    expect(filtered.items).toHaveLength(3);
    expect(filtered.items.every((i) => i.appId === appId)).toBe(true);
    // 全量：total 与页内条目数一致，且每条 appName 唯一对应其项目
    const all = listUserFeedbacks(db, userId, { page: 1, limit: 10 });
    expect(all.total).toBe(5);
    expect(all.items).toHaveLength(5);
  });

  /**
   * v13 往同一条 SELECT 加了 appName 与三个计数子查询。它们**没有**新增 `?`，
   * 而这正是最容易顺手加错的地方：`.all(userId, ...params, limit, offset)` 按**语句文本顺序**
   * 绑定，语句里第一个 `?` 是未读子查询的 `rc.user_id`，其后才是 user_id / app_id / issue_status
   * 与 LIMIT / OFFSET。既有 6 处用例都只压了其中一部分占位符，本用例把四类同时压上：
   * 任何一位错位，total / items / 翻页 / unread 至少一项对不上。
   */
  it("appId + issueStatus + offset 与未读游标同时生效时 ? 绑定顺序不错位", () => {
    const { db, appRowId, appId, userId, adminId } = setupTestDb();
    const appRowId2 = "app-row-2";
    const appId2 = "com.test.other";
    db.prepare(
      `INSERT INTO apps (id, app_id, name, config_status, archive_mode, created_at, updated_at)
       VALUES (?, ?, 'Other App', 'configured', 'manual', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(appRowId2, appId2);

    // 目标项目 4 条 open，把后两条改成 resolved：issueStatus 的 `?` 必须只剩 2 条
    const target: string[] = [];
    for (let i = 0; i < 4; i++) {
      const fb = insertFeedback(db, {
        appId,
        appRowId,
        userId,
        text: `绑定 ${i}`,
        contextJson: null,
        idempotencyKey: `bind-${i}`,
        contentHash: `cb-${i}`,
      });
      target.push(fb.id);
    }
    db.prepare("UPDATE feedbacks SET issue_status = 'resolved' WHERE id IN (?, ?)").run(
      target[2] as string,
      target[3] as string,
    );

    // 噪声：另一个项目也放 4 条 open —— appId 的 `?` 一旦错位就会串进来
    for (let i = 0; i < 4; i++) {
      insertFeedback(db, {
        appId: appId2,
        appRowId: appRowId2,
        userId,
        text: `其他 ${i}`,
        contextJson: null,
        idempotencyKey: `other-${i}`,
        contentHash: `co-${i}`,
      });
    }

    const filtered = listUserFeedbacks(db, userId, { appId, issueStatus: "open", page: 1, limit: 10 });
    expect(filtered.total).toBe(2);
    expect(filtered.items).toHaveLength(2);
    expect(filtered.items.every((i) => i.appId === appId && i.issueStatus === "open")).toBe(true);
    expect(new Set(filtered.items.map((i) => i.id))).toEqual(new Set([target[0], target[1]]));
    // 新增投影在同一条过滤链路上仍逐条对得上所属项目
    for (const item of filtered.items) {
      expect(item.appName).toBe("Test App");
      expect(item.imageCount).toBe(0);
      expect(item.logCount).toBe(0);
    }

    // LIMIT / OFFSET 两个 `?` 必须落在末位：limit=1 的第 2 页要换一条，且 total 不受分页影响
    const p1 = listUserFeedbacks(db, userId, { appId, page: 1, limit: 1 });
    const p2 = listUserFeedbacks(db, userId, { appId, page: 2, limit: 1 });
    expect(p1.total).toBe(4);
    expect(p2.total).toBe(4);
    expect(p1.items).toHaveLength(1);
    expect(p2.items).toHaveLength(1);
    expect(p1.items[0]?.id).not.toBe(p2.items[0]?.id);

    // rc.user_id 的 `?`：加一条管理员消息后，只有该条 unread 为 true（游标按本人计算）
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
    try {
      addFeedbackMessageAtomic(db, {
        feedbackId: target[0] as string,
        senderType: "admin",
        senderId: adminId,
        senderName: "管理员",
        text: "在吗",
      });
    } finally {
      vi.useRealTimers();
    }
    const withUnread = listUserFeedbacks(db, userId, { appId, issueStatus: "open", page: 1, limit: 10 });
    expect(withUnread.items.find((i) => i.id === target[0])?.unread).toBe(true);
    expect(withUnread.items.find((i) => i.id === target[1])?.unread).toBe(false);
    expect(withUnread.unreadTotal).toBe(1);
    // 管理员消息不改 issue_status（本用例的 open 过滤依赖这一点）
    expect(withUnread.items.find((i) => i.id === target[0])?.issueStatus).toBe("open");
  });
});
