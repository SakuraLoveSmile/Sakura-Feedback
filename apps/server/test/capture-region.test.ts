import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encryptSecret } from "../src/crypto/secret.ts";
import { openDb } from "../src/db/db.ts";
import { getFeedbackImagesMeta, listUnifiedFeedbackImages, setSetting } from "../src/db/repos.ts";
import { createAiClient, mapReleasePointToRegion } from "../src/services/ai.ts";
import { createTestImage, defaultSubmitBody, type Harness, makeHarness, submitMultipartFeedback } from "./helpers.ts";

/** 最小 AI fetch 记录器（记录请求体以便断言 prompt）。 */
function recordingFetch() {
  const calls: { url: string; body?: string }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: typeof init?.body === "string" ? init.body : undefined });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "t",
                sections: { experience: "", problems: "", suggestions: "", questions: "" },
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const VALID_REGION = { x: 0.25, y: 0.5, width: 0.5, height: 0.25 };

async function submitCaptureMeta(h: Harness, key: string, capture: unknown) {
  const buf = await createTestImage(32, 32, "png");
  const desc = {
    id: `region-${key}`,
    source: "capture",
    filename: `region-${key}.png`,
    mime: "image/png",
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
  return submitMultipartFeedback(
    h.feedbackApp,
    h.bearer,
    defaultSubmitBody({
      idempotencyKey: key,
      text: "局部截图反馈",
      capture,
      images: [desc],
    }),
    undefined,
    undefined,
    [{ filename: desc.filename, buffer: buf, contentType: "image/png" }],
  );
}

describe("capture.region 提交契约", () => {
  it("合法 region 随多图提交入库并原样持久化", async () => {
    const h = await makeHarness();
    const res = await submitCaptureMeta(h, "region-ok", {
      viewportWidth: 1440,
      viewportHeight: 900,
      pixelWidth: 720,
      pixelHeight: 360,
      releasePoint: { x: 0.5, y: 0.6 },
      region: VALID_REGION,
    });
    expect(res.status).toBe(201);

    const rows = getFeedbackImagesMeta(h.feedbackApp.db, res.data.feedbackId as string);
    const stored = JSON.parse(rows[0]?.capture_json ?? "null");
    expect(stored.region).toEqual(VALID_REGION);
    // 原始捕获视口语义不变，输出像素为裁剪后尺寸
    expect(stored.viewportWidth).toBe(1440);
    expect(stored.viewportHeight).toBe(900);
    expect(stored.pixelWidth).toBe(720);
    expect(stored.releasePoint).toEqual({ x: 0.5, y: 0.6 });

    // 统一图片列表（管理端详情用）同样暴露 capture，供「局部截图」标记使用
    const unified = listUnifiedFeedbackImages(h.feedbackApp.db, res.data.feedbackId as string);
    expect(unified).toHaveLength(1);
    expect(unified[0]?.capture?.region).toEqual(VALID_REGION);
    expect(unified[0]?.capture?.viewportWidth).toBe(1440);
  });

  it("缺省 region 的旧客户端提交保持兼容（不新增字段）", async () => {
    const h = await makeHarness();
    const res = await submitCaptureMeta(h, "region-absent", {
      viewportWidth: 1280,
      viewportHeight: 800,
      releasePoint: { x: 0.1, y: 0.2 },
    });
    expect(res.status).toBe(201);
    const rows = getFeedbackImagesMeta(h.feedbackApp.db, res.data.feedbackId as string);
    const stored = JSON.parse(rows[0]?.capture_json ?? "null");
    expect("region" in stored).toBe(false);
  });

  const invalids: [string, unknown][] = [
    ["region 非对象", 0.5],
    ["region 为 null", null],
    ["缺少 height", { x: 0, y: 0, width: 0.5 }],
    ["含非数字", { x: 0, y: 0, width: 0.5, height: "0.5" }],
    ["含非有限数", { x: Number.NaN, y: 0, width: 0.5, height: 0.5 }],
    ["宽为 0", { x: 0, y: 0, width: 0, height: 0.5 }],
    ["超出视口右边界", { x: 0.75, y: 0, width: 0.5, height: 0.5 }],
    ["负坐标", { x: -0.1, y: 0, width: 0.5, height: 0.5 }],
  ];

  for (const [name, region] of invalids) {
    it(`非法 region 被拒绝且不落盘：${name}`, async () => {
      const h = await makeHarness();
      const res = await submitCaptureMeta(h, `region-bad-${name}`, {
        viewportWidth: 1440,
        viewportHeight: 900,
        region,
      });
      expect(res.status).toBe(400);
      expect(res.data?.error?.code).toBe("invalid_request");
    });
  }
});

describe("AI 消费局部图片的落点换算", () => {
  it("区域内落点换算为截图内坐标，区域外落点不提供提示", () => {
    const region = VALID_REGION;
    // 区域中心 (0.5, 0.625)
    expect(mapReleasePointToRegion({ x: 0.5, y: 0.625 }, region)).toEqual({ x: 0.5, y: 0.5 });
    // 区域左上角
    expect(mapReleasePointToRegion({ x: 0.25, y: 0.5 }, region)).toEqual({ x: 0, y: 0 });
    // 区域右下角（闭区间）
    expect(mapReleasePointToRegion({ x: 0.75, y: 0.75 }, region)).toEqual({ x: 1, y: 1 });
    // 区域外 → null
    expect(mapReleasePointToRegion({ x: 0.1, y: 0.1 }, region)).toBeNull();
    expect(mapReleasePointToRegion({ x: 0.9, y: 0.9 }, region)).toBeNull();
    // 退化区域 → null
    expect(mapReleasePointToRegion({ x: 0.5, y: 0.5 }, { x: 0, y: 0, width: 0, height: 1 })).toBeNull();
  });

  async function organizePrompt(visual: Parameters<ReturnType<typeof createAiClient>["organize"]>[1]) {
    const masterKey = Buffer.alloc(32, 7);
    const db = openDb(mkdtempSync(path.join(tmpdir(), "fb-region-ai-")));
    setSetting(db, "ai.baseUrl", "https://llm.test/v1");
    setSetting(db, "ai.model", "m-1");
    setSetting(db, "ai.apiKeyEnc", encryptSecret(masterKey, "sk-1"));
    const f = recordingFetch();
    const ai = createAiClient(db, masterKey, f.impl);
    await ai.organize("导出 CSV 卡住了", visual);
    return f.calls[0]?.body ?? "";
  }

  const images = [{ buffer: Buffer.from("fake-png"), mime: "image/png" }];

  it("带 region 时提示换算为截图内坐标", async () => {
    const body = await organizePrompt({
      images,
      releasePoint: { x: 0.5, y: 0.625 },
      region: VALID_REGION,
      outputPixels: { width: 720, height: 225 },
    });
    expect(body).toContain("本图为局部截图");
    expect(body).toContain("x=0.50 (50%)");
    expect(body).toContain("y=0.50 (50%)");
    expect(body).toContain("【截图输出尺寸】：720 x 225 像素");
  });

  it("落点在最终裁剪范围外则完全不提供落点提示", async () => {
    const body = await organizePrompt({
      images,
      releasePoint: { x: 0.05, y: 0.05 },
      region: VALID_REGION,
      outputPixels: { width: 720, height: 225 },
    });
    expect(body).not.toContain("【用户关注落点】");
    expect(body).toContain("【截图输出尺寸】");
  });

  it("无 region（整窗截图）保持原有视口措辞", async () => {
    const body = await organizePrompt({
      images,
      releasePoint: { x: 0.5, y: 0.63 },
      viewport: { width: 1440, height: 900 },
    });
    expect(body).toContain("【用户关注落点】：归一化坐标");
    expect(body).not.toContain("本图为局部截图");
    expect(body).toContain("【视口尺寸】：1440 x 900");
  });
});
