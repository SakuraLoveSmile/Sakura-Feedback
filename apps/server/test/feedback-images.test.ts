import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getFeedback, getFeedbackImage, listUnifiedFeedbackImages } from "../src/db/repos.ts";
import {
  authorizeArchive,
  createTestImage,
  defaultSubmitBody,
  type Harness,
  makeHarness,
  submitMultipartFeedback,
} from "./helpers.ts";

const sha256Of = (buf: Buffer | Uint8Array) => createHash("sha256").update(buf).digest("hex");

type ImgDesc = { id: string; source: string; filename: string; mime: string; sha256: string };

/** 生成图片 + 描述符（sha256 自动按内容计算）。 */
async function imgPart(
  id: string,
  format: "png" | "jpeg" | "webp" = "png",
  source = "manual",
  width = 64,
  height = 64,
): Promise<{ desc: ImgDesc; part: { filename: string; buffer: Buffer; contentType: string } }> {
  const buf = await createTestImage(width, height, format);
  const ext = format === "jpeg" ? "jpg" : format;
  const mime = `image/${format}`;
  return {
    desc: { id, source, filename: `${id}.${ext}`, mime, sha256: sha256Of(buf) },
    part: { filename: `${id}.${ext}`, buffer: buf, contentType: mime },
  };
}

/** 用户回复 multipart（metadata + images/logs/screenshot 部件）。 */
async function submitMultipartReply(
  h: Harness,
  feedbackId: string,
  metadata: Record<string, unknown>,
  parts: {
    screenshot?: Buffer;
    images?: { filename: string; buffer: Buffer; contentType?: string }[];
    logs?: { filename: string; buffer: Buffer; contentType?: string }[];
    /** 平铺兼容字段（旧客户端）。 */
    flatText?: string;
    flatIdempotencyKey?: string;
  } = {},
) {
  const boundary = `----ReplyBoundary${Math.random().toString(36).slice(2)}`;
  const bodyParts: Buffer[] = [];
  bodyParts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    ),
  );
  if (parts.flatText !== undefined) {
    bodyParts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n${parts.flatText}\r\n`),
    );
  }
  if (parts.flatIdempotencyKey !== undefined) {
    bodyParts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="idempotencyKey"\r\n\r\n${parts.flatIdempotencyKey}\r\n`,
      ),
    );
  }
  if (parts.screenshot) {
    bodyParts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="screenshot"; filename="shot.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
    );
    bodyParts.push(parts.screenshot);
    bodyParts.push(Buffer.from("\r\n"));
  }
  for (const img of parts.images ?? []) {
    bodyParts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="${img.filename}"\r\nContent-Type: ${img.contentType ?? "image/png"}\r\n\r\n`,
      ),
    );
    bodyParts.push(img.buffer);
    bodyParts.push(Buffer.from("\r\n"));
  }
  for (const log of parts.logs ?? []) {
    bodyParts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="logs"; filename="${log.filename}"\r\nContent-Type: ${log.contentType ?? "text/plain"}\r\n\r\n`,
      ),
    );
    bodyParts.push(log.buffer);
    bodyParts.push(Buffer.from("\r\n"));
  }
  bodyParts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(bodyParts);
  const res = await h.feedbackApp.app.request(`/api/feedback/${feedbackId}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${h.bearer}`,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
    },
    body,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data, headers: res.headers };
}

describe("v12: 多图附件（提交、校验、幂等、端点与流水线）", () => {
  it("多图提交成功：有序入库、统一列表有序返回、逐图下载原始字节", async () => {
    const h = await makeHarness();
    const a = await imgPart("img-a", "png", "capture");
    const b = await imgPart("img-b", "jpeg", "manual");
    const c = await imgPart("img-c", "webp", "edited");

    const res = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({
        idempotencyKey: "imgs-1",
        text: "三张图片的反馈",
        images: [a.desc, b.desc, c.desc],
      }),
      undefined,
      undefined,
      [a.part, b.part, c.part],
    );
    expect(res.status).toBe(201);
    const feedbackId = res.data.feedbackId as string;

    // 统一列表按 sort 返回三张
    const images = listUnifiedFeedbackImages(h.feedbackApp.db, feedbackId);
    expect(images.map((i) => i.id)).toEqual(["img-a", "img-b", "img-c"]);
    expect(images.map((i) => i.sort)).toEqual([0, 1, 2]);
    expect(images.map((i) => i.mime)).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(images.map((i) => i.source)).toEqual(["capture", "manual", "edited"]);

    // capture 元数据挂到 source='capture' 的首张（img-a）
    const row = getFeedbackImage(h.feedbackApp.db, feedbackId, "img-a");
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.capture_json ?? "null")).toBeNull();

    // 用户端逐图下载：bytes 与提交一致；跨源 Origin 下 200 二进制响应必须带 ACAO
    for (const [id, part] of [
      ["img-a", a.part],
      ["img-b", b.part],
      ["img-c", c.part],
    ] as const) {
      const got = await h.feedbackApp.app.fetch(
        new Request(`http://localhost/api/feedback/${feedbackId}/images/${id}`, {
          headers: { authorization: `Bearer ${h.bearer}`, origin: "http://host.test" },
        }),
      );
      expect(got.status).toBe(200);
      expect(got.headers.get("content-type")).toBe(part.contentType);
      expect(got.headers.get("access-control-allow-origin")).toBe("http://host.test");
      expect(got.headers.get("vary")).toContain("origin");
      expect(Buffer.from(await got.arrayBuffer())).toEqual(part.buffer);
    }

    // 管理端逐图查看
    const adminGot = await h.feedbackApp.app.fetch(
      new Request(`http://localhost/api/admin/feedback/${feedbackId}/images/img-b`, {
        headers: { cookie: h.cookie },
      }),
    );
    expect(adminGot.status).toBe(200);
    expect(adminGot.headers.get("content-type")).toBe("image/jpeg");

    // 他人与未认证访问受限
    const otherBearer = await (await import("./helpers.ts")).createUserBearer(h, { username: "other-user" });
    const denied = await h.feedbackApp.app.fetch(
      new Request(`http://localhost/api/feedback/${feedbackId}/images/img-a`, {
        headers: { authorization: `Bearer ${otherBearer}` },
      }),
    );
    expect(denied.status).toBe(404);

    // 对话接口返回有序 images 列表（含统一视图字段）
    const dlg = await h.feedbackApp.app.fetch(
      new Request(`http://localhost/api/feedback/${feedbackId}/dialogue`, {
        headers: { authorization: `Bearer ${h.bearer}` },
      }),
    );
    const dlgJson = await dlg.json();
    expect(dlgJson.feedback.images.map((i: any) => i.id)).toEqual(["img-a", "img-b", "img-c"]);
    expect(dlgJson.feedback.hasScreenshot).toBe(true);
  });

  it("图片数量上限：5 张通过、6 张拒绝 invalid_request", async () => {
    const h = await makeHarness();
    const imgs = await Promise.all(["i1", "i2", "i3", "i4", "i5"].map((id) => imgPart(id)));

    const ok = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({ idempotencyKey: "imgs-5", text: "五张", images: imgs.map((i) => i.desc) }),
      undefined,
      undefined,
      imgs.map((i) => i.part),
    );
    expect(ok.status).toBe(201);
    const list = listUnifiedFeedbackImages(h.feedbackApp.db, ok.data.feedbackId);
    expect(list).toHaveLength(5);

    const six = await Promise.all(["j1", "j2", "j3", "j4", "j5", "j6"].map((id) => imgPart(id)));
    const bad = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({ idempotencyKey: "imgs-6", text: "六张", images: six.map((i) => i.desc) }),
      undefined,
      undefined,
      six.map((i) => i.part),
    );
    expect(bad.status).toBe(400);
    expect(bad.data.error.code).toBe("invalid_request");
  });

  it("格式与内容校验：GIF 拒绝、声明 mime 与内容不符拒绝、sha256 不符拒绝", async () => {
    const h = await makeHarness();
    // GIF 字节声明为 png（文件名合法但魔数不符）→ invalid_image
    const gifBuf = Buffer.from(`GIF89a${"x".repeat(100)}`, "utf-8");
    const res1 = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({
        idempotencyKey: "img-gif",
        text: "gif",
        images: [{ id: "g1", source: "manual", filename: "g.png", mime: "image/png", sha256: sha256Of(gifBuf) }],
      }),
      undefined,
      undefined,
      [{ filename: "g.png", buffer: gifBuf, contentType: "image/png" }],
    );
    expect(res1.status).toBe(400);
    expect(res1.data.error.code).toBe("invalid_image");

    // 非法扩展名（.gif）本身就是请求形态错误 → invalid_request
    const res1b = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({
        idempotencyKey: "img-gif-ext",
        text: "gif 扩展名",
        images: [{ id: "g1", source: "manual", filename: "g.gif", mime: "image/png", sha256: sha256Of(gifBuf) }],
      }),
      undefined,
      undefined,
      [{ filename: "g.gif", buffer: gifBuf, contentType: "image/gif" }],
    );
    expect(res1b.status).toBe(400);
    expect(res1b.data.error.code).toBe("invalid_request");

    // 声明 jpeg 但内容是 png
    const png = await createTestImage(32, 32, "png");
    const res2 = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({
        idempotencyKey: "img-mime",
        text: "mime 不符",
        images: [{ id: "m1", source: "manual", filename: "m.jpg", mime: "image/jpeg", sha256: sha256Of(png) }],
      }),
      undefined,
      undefined,
      [{ filename: "m.jpg", buffer: png, contentType: "image/jpeg" }],
    );
    expect(res2.status).toBe(400);
    expect(res2.data.error.code).toBe("invalid_image");

    // sha256 不符
    const jpeg = await createTestImage(32, 32, "jpeg");
    const res3 = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({
        idempotencyKey: "img-sha",
        text: "sha 不符",
        images: [
          {
            id: "s1",
            source: "manual",
            filename: "s.jpg",
            mime: "image/jpeg",
            sha256: "0".repeat(64),
          },
        ],
      }),
      undefined,
      undefined,
      [{ filename: "s.jpg", buffer: jpeg, contentType: "image/jpeg" }],
    );
    expect(res3.status).toBe(400);
    expect(res3.data.error.code).toBe("invalid_image");
  });

  it("尺寸与体积限制：超 2048px 或超 400 万像素 → 413 too_large", async () => {
    const h = await makeHarness();
    const big = await createTestImage(2100, 64, "png"); // 长边超限
    const res = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({
        idempotencyKey: "img-edge",
        text: "超尺寸",
        images: [{ id: "b1", source: "manual", filename: "b.png", mime: "image/png", sha256: sha256Of(big) }],
      }),
      undefined,
      undefined,
      [{ filename: "b.png", buffer: big, contentType: "image/png" }],
    );
    expect(res.status).toBe(413);
    expect(res.data.error.code).toBe("too_large");

    // 像素总数超限（2000×2100 = 4.2MP > 4MP，长边合规）
    const manyPixels = await createTestImage(2000, 2100, "png");
    const res2 = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({
        idempotencyKey: "img-pixels",
        text: "超像素",
        images: [{ id: "p1", source: "manual", filename: "p.png", mime: "image/png", sha256: sha256Of(manyPixels) }],
      }),
      undefined,
      undefined,
      [{ filename: "p.png", buffer: manyPixels, contentType: "image/png" }],
    );
    expect(res2.status).toBe(413);
    expect(res2.data.error.code).toBe("too_large");
  });

  it("images 与 screenshot 互斥：同时出现一律 400 invalid_request", async () => {
    const h = await makeHarness();
    const a = await imgPart("mx1");
    const shot = await createTestImage(32, 32, "png");
    const res = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({ idempotencyKey: "img-mutex", text: "互斥", images: [a.desc] }),
      shot,
      undefined,
      [a.part],
    );
    expect(res.status).toBe(400);
    expect(res.data.error.code).toBe("invalid_request");
  });

  it("描述符与部件数量不一致 / 缺描述符 → invalid_request；id 重复 → invalid_request", async () => {
    const h = await makeHarness();
    const a = await imgPart("d1");
    const b = await imgPart("d2");

    // 部件多于描述符
    const res1 = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({ idempotencyKey: "img-cnt1", text: "数量不符", images: [a.desc] }),
      undefined,
      undefined,
      [a.part, b.part],
    );
    expect(res1.status).toBe(400);
    expect(res1.data.error.code).toBe("invalid_request");

    // 有部件无描述符
    const res2 = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({ idempotencyKey: "img-cnt2", text: "缺描述" }),
      undefined,
      undefined,
      [a.part],
    );
    expect(res2.status).toBe(400);
    expect(res2.data.error.code).toBe("invalid_request");

    // 同一次提交 id 重复
    const res3 = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({ idempotencyKey: "img-dup", text: "重复 id", images: [a.desc, a.desc] }),
      undefined,
      undefined,
      [a.part, b.part],
    );
    expect(res3.status).toBe(400);
    expect(res3.data.error.code).toBe("invalid_request");
  });

  it("幂等：相同图片摘要的重复提交重放；换图则冲突；无图旧哈希保持不变", async () => {
    const h = await makeHarness();
    // 同尺寸同格式生成像素一致 → sha256 相同；换图/换序必须让摘要真变化（改尺寸产生不同字节）。
    const a = await imgPart("idem-a", "png", "manual", 64, 64);
    const b = await imgPart("idem-b", "png", "manual", 32, 48);
    const meta = defaultSubmitBody({
      idempotencyKey: "idem-img",
      text: "带图幂等",
      images: [a.desc, b.desc],
    });

    const first = await submitMultipartFeedback(h.feedbackApp, h.bearer, meta, undefined, undefined, [a.part, b.part]);
    expect(first.status).toBe(201);
    const feedbackId = first.data.feedbackId;

    // 完全相同的重放（同 key + 同图序摘要）→ 200 replayed
    const replay = await submitMultipartFeedback(h.feedbackApp, h.bearer, meta, undefined, undefined, [a.part, b.part]);
    expect(replay.status).toBe(200);
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.feedbackId).toBe(feedbackId);

    // 同 key 但换一张图（不同尺寸 → 不同 sha256）→ 409 idempotency_conflict
    const other = await imgPart("idem-c", "png", "manual", 96, 96);
    const conflict = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      { ...meta, images: [a.desc, other.desc] },
      undefined,
      undefined,
      [a.part, other.part],
    );
    expect(conflict.status).toBe(409);
    expect(conflict.data.error.code).toBe("idempotency_conflict");

    // 同 key 但图片顺序调换 → 409（有序摘要是哈希的一部分）
    const reordered = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      { ...meta, images: [b.desc, a.desc] },
      undefined,
      undefined,
      [b.part, a.part],
    );
    expect(reordered.status).toBe(409);
    expect(reordered.data.error.code).toBe("idempotency_conflict");
  });

  it("回复幂等：附件摘要纳入比较——同键丢附件冲突而非重放", async () => {
    const h = await makeHarness();
    const base = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({ idempotencyKey: "base-fb", text: "初始反馈" }),
    );
    expect(base.status).toBe(201);
    const fbId = base.data.feedbackId as string;

    const img = await imgPart("rp1");
    const meta = { text: "带图回复", idempotencyKey: "rp-key", images: [img.desc] };
    const first = await submitMultipartReply(h, fbId, meta, { images: [img.part] });
    expect(first.status).toBe(201);

    // 完全相同的重放 → 200 replayed
    const replay = await submitMultipartReply(h, fbId, meta, { images: [img.part] });
    expect(replay.status).toBe(200);
    expect(replay.data.replayed).toBe(true);

    // 同键但附件丢失（只留文字）→ 409 conflict
    const lost = await submitMultipartReply(h, fbId, { text: "带图回复", idempotencyKey: "rp-key" });
    expect(lost.status).toBe(409);
    expect(lost.data.error.code).toBe("idempotency_conflict");

    // 回复附件入库为 kind='image' 且按 sort 排序
    const msgs = h.feedbackApp.db
      .prepare(
        "SELECT a.kind, a.mime, a.sort FROM feedback_message_attachments a JOIN feedback_messages m ON m.id = a.message_id WHERE m.feedback_id = ? ORDER BY a.sort",
      )
      .all(fbId) as { kind: string; mime: string; sort: number }[];
    expect(msgs).toEqual([{ kind: "image", mime: "image/png", sort: 0 }]);
  });

  it("v12 用户端日志下载/预览（限本人+管理员）与附件列表 mime", async () => {
    const h = await makeHarness();
    const logBuf = Buffer.from("2026-09-10 log line\n更多内容", "utf-8");
    const res = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({
        idempotencyKey: "fb-with-log",
        text: "带日志反馈",
        logs: [{ filename: "app.log", source: "auto", sha256: sha256Of(logBuf) }],
      }),
      undefined,
      [{ filename: "app.log", buffer: logBuf }],
    );
    expect(res.status).toBe(201);
    const fbId = res.data.feedbackId as string;
    const logId = (
      h.feedbackApp.db.prepare("SELECT id FROM feedback_logs WHERE feedback_id = ?").get(fbId) as { id: string }
    ).id;

    // 本人下载（跨源 Origin：200 二进制响应必须带 ACAO，否则浏览器拦截）
    const dl = await h.feedbackApp.app.fetch(
      new Request(`http://localhost/api/feedback/${fbId}/logs/${logId}/download`, {
        headers: { authorization: `Bearer ${h.bearer}`, origin: "http://host.test" },
      }),
    );
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("application/octet-stream");
    expect(dl.headers.get("access-control-allow-origin")).toBe("http://host.test");
    expect(Buffer.from(await dl.arrayBuffer())).toEqual(logBuf);

    // 本人预览（同查 ACAO）
    const pv = await h.feedbackApp.app.fetch(
      new Request(`http://localhost/api/feedback/${fbId}/logs/${logId}/preview`, {
        headers: { authorization: `Bearer ${h.bearer}`, origin: "http://host.test" },
      }),
    );
    expect(pv.status).toBe(200);
    expect(pv.headers.get("content-type")).toContain("text/plain");
    expect(pv.headers.get("access-control-allow-origin")).toBe("http://host.test");

    // 他人 404
    const otherBearer = await (await import("./helpers.ts")).createUserBearer(h, { username: "other-2" });
    const denied = await h.feedbackApp.app.fetch(
      new Request(`http://localhost/api/feedback/${fbId}/logs/${logId}/download`, {
        headers: { authorization: `Bearer ${otherBearer}` },
      }),
    );
    expect(denied.status).toBe(404);
  });

  it("组件端点二进制响应带 ACAO：旧截图与消息附件（跨源 Bearer fetch）", async () => {
    const h = await makeHarness();
    // 旧单图提交（screenshot 部件）
    const shot = await createTestImage(40, 40, "png");
    const res = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({ idempotencyKey: "cors-shot", text: "带截图反馈" }),
      shot,
    );
    expect(res.status).toBe(201);
    const fbId = res.data.feedbackId as string;

    // GET /:id/screenshot：200 二进制 + ACAO
    const shotRes = await h.feedbackApp.app.fetch(
      new Request(`http://localhost/api/feedback/${fbId}/screenshot`, {
        headers: { authorization: `Bearer ${h.bearer}`, origin: "http://host.test" },
      }),
    );
    expect(shotRes.status).toBe(200);
    expect(shotRes.headers.get("content-type")).toBe("image/png");
    expect(shotRes.headers.get("access-control-allow-origin")).toBe("http://host.test");
    expect(shotRes.headers.get("vary")).toContain("origin");

    // 兼容视图同样命中 id="screenshot" 的图片端点
    const unified = await h.feedbackApp.app.fetch(
      new Request(`http://localhost/api/feedback/${fbId}/images/screenshot`, {
        headers: { authorization: `Bearer ${h.bearer}`, origin: "http://host.test" },
      }),
    );
    expect(unified.status).toBe(200);
    expect(unified.headers.get("access-control-allow-origin")).toBe("http://host.test");

    // 回复附带日志附件 → 附件下载端点 200 + ACAO
    const reply = await submitMultipartReply(
      h,
      fbId,
      { text: "带附件回复" },
      {
        logs: [{ filename: "r.log", buffer: Buffer.from("reply log", "utf-8") }],
      },
    );
    expect(reply.status).toBe(201);
    const attId = (
      h.feedbackApp.db
        .prepare(
          "SELECT a.id FROM feedback_message_attachments a JOIN feedback_messages m ON m.id = a.message_id WHERE m.feedback_id = ?",
        )
        .get(fbId) as { id: string }
    ).id;
    const attRes = await h.feedbackApp.app.fetch(
      new Request(`http://localhost/api/feedback/messages/attachments/${attId}`, {
        headers: { authorization: `Bearer ${h.bearer}`, origin: "http://host.test" },
      }),
    );
    expect(attRes.status).toBe(200);
    expect(attRes.headers.get("access-control-allow-origin")).toBe("http://host.test");
  });

  it("归档流水线：多图逐张上传/建资产/发评论（按稳定 id 记录），resume 不重复上传", async () => {
    const h = await makeHarness();
    const a = await imgPart("arc-a", "png", "capture");
    const b = await imgPart("arc-b", "jpeg", "manual");
    const res = await submitMultipartFeedback(
      h.feedbackApp,
      h.bearer,
      defaultSubmitBody({
        idempotencyKey: "arc-imgs",
        text: "多图归档",
        images: [a.desc, b.desc],
      }),
      undefined,
      undefined,
      [a.part, b.part],
    );
    expect(res.status).toBe(201);
    const fbId = res.data.feedbackId as string;

    // 授权归档并跑 worker
    const auth = await authorizeArchive(h, fbId);
    expect(auth.status).toBe(202);
    await h.feedbackApp.worker.idle();

    const fb = getFeedback(h.feedbackApp.db, fbId)!;
    expect(fb.status).toBe("archived");

    // 每张图一条资产 + 一条评论，评论含稳定 id 与 sha256 字段（worker 读回核对靠 id+sha+资产引用）。
    const imgComments = h.kaneo.comments.filter((c) => c.content.includes(`**图片ID**：`));
    expect(imgComments.length).toBe(2);
    const contents = imgComments.map((c) => c.content);
    expect(contents.some((t) => t.includes(`**反馈ID**：${fbId}`))).toBe(true);
    expect(contents.some((t) => t.includes(`**图片ID**：arc-a`))).toBe(true);
    expect(contents.some((t) => t.includes(`**图片ID**：arc-b`))).toBe(true);
    expect(contents.some((t) => t.includes(a.desc.sha256))).toBe(true);
    expect(contents.some((t) => t.includes(b.desc.sha256))).toBe(true);

    // 归档数据按稳定 id 记录两张图片（kind='image'）
    const data = JSON.parse(fb.archive_data_json ?? "{}");
    expect(data.attachments?.["arc-a"]?.kind).toBe("image");
    expect(data.attachments?.["arc-b"]?.kind).toBe("image");
    expect(data.attachments?.["arc-a"]?.comment?.outcome).toBe("confirmed");
    expect(data.attachments?.["arc-b"]?.comment?.outcome).toBe("confirmed");

    // 再次运行（resume 语义）：不重复上传、不重复建评论
    const uploadsBefore = h.kaneo.uploads.length;
    const commentsBefore = imgComments.length;
    await h.feedbackApp.worker.idle();
    expect(h.kaneo.uploads.length).toBe(uploadsBefore);
    expect(h.kaneo.comments.filter((c) => c.content.includes(`**图片ID**：`)).length).toBe(commentsBefore);
  });
});
