import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { encryptSecret } from "../src/crypto/secret.ts";
import { openDb } from "../src/db/db.ts";
import { setSetting } from "../src/db/repos.ts";
import {
  AiError,
  buildVisionProbeImage,
  createAiClient,
  parseColorOrder,
  VISION_PROBE_BLOCK_PX,
  VISION_PROBE_BLOCKS,
  VISION_PROBE_PALETTE,
} from "../src/services/ai.ts";
import { KaneoColumnNotFound, KaneoDefiniteError, KaneoUncertainError } from "../src/services/kaneo.ts";
import { createKaneoHttpClient } from "../src/services/kaneo-http.ts";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(handler: (req: Recorded) => { status: number; body: string; contentType?: string } | (() => never)) {
  const calls: Recorded[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rec: Recorded = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(rec);
    const result = handler(rec);
    if (typeof result === "function") return (result as () => never)();
    return new Response(result.body, {
      status: result.status,
      headers: { "content-type": result.contentType ?? "application/json" },
    });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

function makeKaneo(fetchImpl: typeof fetch, baseUrl = "http://k.local:1337") {
  return createKaneoHttpClient(() => ({ baseUrl, apiKey: "test-api-key", clientUrl: "" }), fetchImpl);
}

describe("Kaneo HTTP 客户端契约", () => {
  it("test()：GET /api/project/{id} + GET /api/column/{id}，带 Bearer key", async () => {
    const f = fakeFetch((req) => {
      if (req.url.includes("/project/")) {
        return { status: 200, body: JSON.stringify({ id: "p1", name: "项目", workspaceId: "ws1", slug: "TST" }) };
      }
      return {
        status: 200,
        body: JSON.stringify([{ id: "col-db", projectId: "p1", name: "待筛选", slug: "triage", position: 1 }]),
      };
    });
    const k = makeKaneo(f.impl);
    const r = await k.test("p1");
    expect(r.project.workspaceId).toBe("ws1");
    expect(r.columns[0]?.slug).toBe("triage");
    expect(f.calls[0]?.url).toBe("http://k.local:1337/api/project/p1");
    expect(f.calls[0]?.headers.authorization).toBe("Bearer test-api-key");
  });

  it("createTask：POST body 精确为 title/description/priority=no-priority/status=slug，不含负责人或日期", async () => {
    const f = fakeFetch((req) => {
      if (req.method === "POST" && req.url.includes("/task/")) {
        return { status: 200, body: JSON.stringify({ id: "task-uuid-1", number: 42, title: "x" }) };
      }
      if (req.url.includes("/project/")) {
        return { status: 200, body: JSON.stringify({ id: "p1", workspaceId: "ws1", name: "n", slug: "T" }) };
      }
      return { status: 200, body: JSON.stringify([{ id: "c", slug: "triage", name: "待筛选" }]) };
    });
    const k = makeKaneo(f.impl);
    const ref = await k.createTask({
      projectId: "p1",
      columnSlug: "triage",
      title: "标题",
      description: "描述",
    });
    expect(ref.taskId).toBe("task-uuid-1");
    expect(ref.taskUrl).toBe("http://k.local:1337/dashboard/workspace/ws1/project/p1/task/task-uuid-1");
    const post = f.calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("http://k.local:1337/api/task/p1");
    const bodyObj = JSON.parse(post?.body ?? "{}");
    expect(Object.keys(bodyObj).sort()).toEqual(["description", "priority", "status", "title"]);
    expect(bodyObj.priority).toBe("no-priority");
    expect(bodyObj.status).toBe("triage");
  });

  it("列 slug 不存在 → KaneoColumnNotFound 且未发出 POST", async () => {
    let posted = false;
    const f = fakeFetch((req) => {
      if (req.method === "POST") {
        posted = true;
        return { status: 200, body: "{}" };
      }
      if (req.url.includes("/project/")) {
        return { status: 200, body: JSON.stringify({ id: "p1", workspaceId: "ws1" }) };
      }
      return { status: 200, body: JSON.stringify([{ id: "c", slug: "doing", name: "进行中" }]) };
    });
    const k = makeKaneo(f.impl);
    await expect(
      k.createTask({ projectId: "p1", columnSlug: "ghost", title: "t", description: "d" }),
    ).rejects.toBeInstanceOf(KaneoColumnNotFound);
    expect(posted).toBe(false);
  });

  it("创建时 4xx → 确定失败（错误体是 text/plain）", async () => {
    const f = fakeFetch((req) => {
      if (req.method === "POST") {
        return { status: 403, body: "forbidden: no task:create permission", contentType: "text/plain" };
      }
      if (req.url.includes("/project/")) return { status: 200, body: JSON.stringify({ id: "p1", workspaceId: "ws1" }) };
      return { status: 200, body: JSON.stringify([{ id: "c", slug: "triage", name: "n" }]) };
    });
    const k = makeKaneo(f.impl);
    const p = k.createTask({ projectId: "p1", columnSlug: "triage", title: "t", description: "d" });
    await expect(p).rejects.toBeInstanceOf(KaneoDefiniteError);
    await expect(p).rejects.toThrow(/forbidden/);
  });

  it("创建时网络中断/超时 → KaneoUncertainError（结果不确定）", async () => {
    const f = fakeFetch((req) => {
      if (req.method === "POST") {
        return () => {
          throw new Error("socket hang up");
        };
      }
      if (req.url.includes("/project/")) return { status: 200, body: JSON.stringify({ id: "p1", workspaceId: "ws1" }) };
      return { status: 200, body: JSON.stringify([{ id: "c", slug: "triage", name: "n" }]) };
    });
    const k = makeKaneo(f.impl);
    await expect(
      k.createTask({ projectId: "p1", columnSlug: "triage", title: "t", description: "d" }),
    ).rejects.toBeInstanceOf(KaneoUncertainError);
  });

  it("创建时 5xx → 不确定", async () => {
    const f = fakeFetch((req) => {
      if (req.method === "POST") return { status: 502, body: "bad gateway", contentType: "text/plain" };
      if (req.url.includes("/project/")) return { status: 200, body: JSON.stringify({ id: "p1", workspaceId: "ws1" }) };
      return { status: 200, body: JSON.stringify([{ id: "c", slug: "triage", name: "n" }]) };
    });
    const k = makeKaneo(f.impl);
    await expect(
      k.createTask({ projectId: "p1", columnSlug: "triage", title: "t", description: "d" }),
    ).rejects.toBeInstanceOf(KaneoUncertainError);
  });

  it("findByFeedbackId：全局搜索命中含标记描述的任务；不命中返回 null", async () => {
    const mk = (desc: string) =>
      fakeFetch((req) => {
        if (req.url.includes("/project/"))
          return { status: 200, body: JSON.stringify({ id: "p1", workspaceId: "ws1" }) };
        return {
          status: 200,
          body: JSON.stringify({ results: [{ id: "t9", projectId: "p1", description: desc }], totalCount: 1 }),
        };
      });
    const hit = mk("正文……\n\n**反馈ID**：abc-123");
    const k1 = makeKaneo(hit.impl);
    const ref = await k1.findByFeedbackId("p1", "abc-123");
    expect(ref?.taskId).toBe("t9");
    expect(
      hit.calls.some((c) => c.url.startsWith("http://k.local:1337/api/search?") && c.url.includes("workspaceId=ws1")),
    ).toBe(true);

    const miss = mk("无关任务描述");
    const k2 = makeKaneo(miss.impl);
    expect(await k2.findByFeedbackId("p1", "abc-123")).toBeNull();
  });

  it("图片上传预签名（写操作）：网络中断/5xx/响应不可解析 → 不确定；4xx → 确定", async () => {
    const route = (status: number, body: string, contentType?: string) =>
      fakeFetch((req) =>
        req.url.includes("/image-upload/") && req.method === "PUT"
          ? { status, body, contentType }
          : { status: 200, body: "{}" },
      );
    const network = fakeFetch((req) =>
      req.url.includes("/image-upload/") && req.method === "PUT"
        ? (() => {
            throw new Error("reset");
          })()
        : { status: 200, body: "{}" },
    );
    const cases: Array<[typeof network.impl, typeof KaneoUncertainError]> = [
      [route(502, "oops", "text/plain").impl, KaneoUncertainError],
      [route(200, "not-json", "text/plain").impl, KaneoUncertainError],
      [network.impl, KaneoUncertainError],
      [route(400, "bad request", "text/plain").impl, KaneoDefiniteError],
    ];
    for (const [impl, errType] of cases) {
      const k = makeKaneo(impl);
      await expect(
        k.createImageUpload("t1", { filename: "a.png", contentType: "image/png", size: 1, surface: "comment" }),
      ).rejects.toBeInstanceOf(errType as never);
    }
  });

  it("finalize（写操作）：5xx → 不确定", async () => {
    const f = fakeFetch((_req) => ({ status: 503, body: "unavailable", contentType: "text/plain" }));
    const k = makeKaneo(f.impl);
    await expect(
      k.finalizeImageUpload("t1", {
        key: "k",
        filename: "a.png",
        contentType: "image/png",
        size: 1,
        surface: "comment",
      }),
    ).rejects.toBeInstanceOf(KaneoUncertainError);
  });

  it("评论列表读取：非数组/条目全部无法解析 → 确定失败，绝不当“没有评论”；正常条目解析", async () => {
    const nonArray = fakeFetch((_req) => ({ status: 200, body: JSON.stringify({ nope: true }) }));
    const k1 = makeKaneo(nonArray.impl);
    await expect(k1.listComments("t1")).rejects.toBeInstanceOf(KaneoDefiniteError);

    const garbage = fakeFetch((_req) => ({ status: 200, body: JSON.stringify([{ x: 1 }, { y: 2 }]) }));
    const k2 = makeKaneo(garbage.impl);
    await expect(k2.listComments("t1")).rejects.toBeInstanceOf(KaneoDefiniteError);

    const okList = fakeFetch((_req) => ({
      status: 200,
      body: JSON.stringify([{ id: "c1", content: "a" }, { junk: true }, { id: "c2", content: "b" }]),
    }));
    const k3 = makeKaneo(okList.impl);
    const comments = await k3.listComments("t1");
    expect(comments.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("评论 POST 2xx 但响应不可解析 → 不确定（评论结果未知）", async () => {
    const f = fakeFetch((_req) => ({ status: 200, body: "not-json", contentType: "text/plain" }));
    const k = makeKaneo(f.impl);
    await expect(k.createComment("t1", { content: "c" })).rejects.toBeInstanceOf(KaneoUncertainError);
  });

  it("downloadAsset：200 返回字节；404/失败明确报错且注明不能证明文件不存在", async () => {
    const ok = fakeFetch((_req) => ({ status: 200, body: "PNGBYTES", contentType: "application/octet-stream" }));
    const k1 = makeKaneo(ok.impl);
    const bytes = await k1.downloadAsset("http://k.local:1337/api/asset/a1");
    expect(new TextDecoder().decode(bytes)).toBe("PNGBYTES");
    expect(ok.calls[0]?.headers.authorization).toBe("Bearer test-api-key");

    const missing = fakeFetch((_req) => ({ status: 404, body: "nope", contentType: "text/plain" }));
    const k2 = makeKaneo(missing.impl);
    await expect(k2.downloadAsset("http://k.local:1337/api/asset/x")).rejects.toThrow(/不能直接证明文件不存在/);

    const broken = fakeFetch(
      (_req) =>
        (() => {
          throw new Error("reset");
        })() as never,
    );
    const k3 = makeKaneo(broken.impl);
    await expect(k3.downloadAsset("http://k.local:1337/api/asset/x")).rejects.toBeInstanceOf(KaneoDefiniteError);
  });

  it("baseUrl 带/不带 /api 后缀均可规范化；clientUrl 覆盖链接基址", async () => {
    const f = fakeFetch((req) => {
      if (req.url.includes("/project/")) return { status: 200, body: JSON.stringify({ id: "p1", workspaceId: "ws1" }) };
      if (req.url.includes("/column/"))
        return { status: 200, body: JSON.stringify([{ id: "c", slug: "triage", name: "n" }]) };
      return { status: 200, body: JSON.stringify({ id: "t1" }) };
    });
    const k = createKaneoHttpClient(
      () => ({ baseUrl: "https://fb.example.com/api/", apiKey: "kk", clientUrl: "https://kaneo.example.com/" }),
      f.impl,
    );
    await k.test("p1");
    expect(f.calls[0]?.url).toBe("https://fb.example.com/api/project/p1");
    const ref = await k.createTask({ projectId: "p1", columnSlug: "triage", title: "t", description: "d" });
    expect(ref.taskUrl).toBe("https://kaneo.example.com/dashboard/workspace/ws1/project/p1/task/t1");
  });

  it("未配置 → 立即确定失败", async () => {
    const k = createKaneoHttpClient(() => null, fakeFetch(() => ({ status: 200, body: "{}" })).impl);
    await expect(k.test("p")).rejects.toBeInstanceOf(KaneoDefiniteError);
  });
});

describe("AI HTTP 客户端契约", () => {
  it("视觉提示优先输出像素尺寸，逻辑视口仅作回退", async () => {
    const masterKey = Buffer.alloc(32, 3);
    const db = openDb(mkdtempSync(path.join(tmpdir(), "fb-ai-px-")));
    setSetting(db, "ai.baseUrl", "https://llm.test/v1");
    setSetting(db, "ai.model", "m-1");
    setSetting(db, "ai.apiKeyEnc", encryptSecret(masterKey, "sk-1"));
    let lastBody = "";
    const f = fakeFetch(() => {
      return {
        status: 200,
        body: JSON.stringify({
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
      };
    });
    const ai = createAiClient(db, masterKey, f.impl);
    const png = Buffer.from("fake-png");
    // 有输出像素 → 只出【截图输出尺寸】，不出【视口尺寸】
    await ai.organize("a", {
      pngBuffer: png,
      viewport: { width: 1024, height: 768 },
      outputPixels: { width: 400, height: 300 },
    });
    lastBody = f.calls[0]?.body ?? "";
    expect(lastBody).toContain("【截图输出尺寸】：400 x 300 像素");
    expect(lastBody).not.toContain("【视口尺寸】");
    // 缺输出像素 → 回退【视口尺寸】
    await ai.organize("b", { pngBuffer: png, viewport: { width: 1024, height: 768 } });
    lastBody = f.calls[1]?.body ?? "";
    expect(lastBody).toContain("【视口尺寸】：1024 x 768");
    expect(lastBody).not.toContain("【截图输出尺寸】");
  });

  const masterKey = Buffer.alloc(32, 3);

  function aiDb() {
    const db = openDb(mkdtempSync(path.join(tmpdir(), "fb-ai-")));
    setSetting(db, "ai.baseUrl", "https://llm.test/v1/");
    setSetting(db, "ai.model", "m-1");
    setSetting(db, "ai.apiKeyEnc", encryptSecret(masterKey, "sk-999"));
    return db;
  }

  it("chat/completions 请求携带密钥与模型；解析 JSON 输出", async () => {
    const f = fakeFetch(() => ({
      status: 200,
      body: JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "导出问题",
                sections: { experience: "", problems: "导出卡住", suggestions: "", questions: "" },
              }),
            },
          },
        ],
      }),
    }));
    const ai = createAiClient(aiDb(), masterKey, f.impl);
    const r = await ai.organize("导出 CSV 卡住了");
    expect(r.title).toBe("导出问题");
    expect(f.calls[0]?.url).toBe("https://llm.test/v1/chat/completions");
    expect(f.calls[0]?.headers.authorization).toBe("Bearer sk-999");
    expect(JSON.parse(f.calls[0]?.body ?? "{}").model).toBe("m-1");
  });

  it("围栏包裹的 JSON 可解析；结构非法 → invalid_output 可重试", async () => {
    let n = 0;
    const f = fakeFetch(() => {
      n++;
      return n === 1
        ? {
            status: 200,
            body: JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      '```json\n{"title":"t","sections":{"experience":"","problems":"","suggestions":"","questions":""}}\n```',
                  },
                },
              ],
            }),
          }
        : { status: 200, body: JSON.stringify({ choices: [{ message: { content: "not json" } }] }) };
    });
    const ai = createAiClient(aiDb(), masterKey, f.impl);
    const fenced = await ai.organize("a"); // 围栏内容合法
    expect(fenced.title).toBe("t");
    await expect(ai.organize("b")).rejects.toMatchObject({ kind: "invalid_output", retryable: true });
  });

  it("429 → rate 可重试；401 → auth 不可重试；500 → 可重试", async () => {
    const statuses: number[] = [429, 401, 500];
    for (const st of statuses) {
      const f = fakeFetch(() => ({ status: st, body: "nope", contentType: "text/plain" }));
      const ai = createAiClient(aiDb(), masterKey, f.impl);
      const err = await ai.organize("x").catch((e) => e);
      expect(err).toBeInstanceOf(AiError);
      if (st === 429) expect((err as AiError).kind).toBe("rate");
      if (st === 401) {
        expect((err as AiError).kind).toBe("auth");
        expect((err as AiError).retryable).toBe(false);
      }
      if (st === 500) expect((err as AiError).retryable).toBe(true);
    }
  });
});

/**
 * P1：附件下载的凭据边界。
 * 归档恢复会读取远端截图字节做核对，下载请求携带 Kaneo API Key，
 * 因此必须保证「只向可信 Kaneo 来源携带凭据、绝不跨源跟随重定向、绝不向任意 URL 发凭据」。
 */
describe("Kaneo 资产下载：可信来源与凭据不外泄", () => {
  interface DlCall {
    url: string;
    authorization: string | undefined;
    redirect: RequestRedirect | undefined;
    accept: string | undefined;
  }

  /** 记录 authorization / redirect / accept 的 fetch mock，并支持注入 Location 头。 */
  function dlFetch(handler: (call: DlCall, index: number) => Response) {
    const calls: DlCall[] = [];
    const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const call: DlCall = {
        url: String(url),
        authorization: headers.authorization,
        redirect: init?.redirect as RequestRedirect | undefined,
        accept: headers.accept,
      };
      calls.push(call);
      return handler(call, calls.length - 1);
    };
    return { impl: impl as unknown as typeof fetch, calls };
  }

  const okPng = () =>
    new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      status: 200,
      headers: { "content-type": "image/png" },
    });

  const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });

  it("可信来源：携带 Bearer 且不自动跟随重定向（redirect=manual）", async () => {
    const f = dlFetch(() => okPng());
    const k = makeKaneo(f.impl, "http://k.local:1337");
    const bytes = await k.downloadAsset("http://k.local:1337/api/asset/abc.png");
    expect([...bytes]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.authorization).toBe("Bearer test-api-key");
    expect(f.calls[0]?.redirect).toBe("manual");
  });

  it("可信子域与 clientUrl 同为可信来源", async () => {
    const f = dlFetch(() => okPng());
    const k = createKaneoHttpClient(
      () => ({ baseUrl: "http://k.local:1337", apiKey: "test-api-key", clientUrl: "https://kaneo.example.com" }),
      f.impl,
    );
    await k.downloadAsset("http://cdn.k.local/asset/1.png");
    await k.downloadAsset("https://kaneo.example.com/api/asset/2.png");
    expect(f.calls.map((c) => c.authorization)).toEqual(["Bearer test-api-key", "Bearer test-api-key"]);
  });

  it("非可信来源：零请求发出（绝不把凭据送到任意主机）", async () => {
    const f = dlFetch(() => okPng());
    const k = makeKaneo(f.impl, "http://k.local:1337");
    const err = await k.downloadAsset("http://evil.example.com/asset.png").catch((e) => e);
    expect(err).toBeInstanceOf(KaneoDefiniteError);
    expect((err as Error).message).toContain("不在可信 Kaneo 来源内");
    expect(f.calls).toHaveLength(0); // 关键：一个字节都没发出去
  });

  it("伪造的相似域名（k.local.evil.com / notk.local）不被视为可信", async () => {
    const f = dlFetch(() => okPng());
    const k = makeKaneo(f.impl, "http://k.local:1337");
    for (const url of ["http://k.local.evil.com/a.png", "http://notk.local/a.png"]) {
      const err = await k.downloadAsset(url).catch((e) => e);
      expect(err).toBeInstanceOf(KaneoDefiniteError);
      expect((err as Error).message).toContain("不在可信 Kaneo 来源内");
    }
    expect(f.calls).toHaveLength(0);
  });

  it("非 http(s) 协议与非法 URL 一律拒绝，且零请求", async () => {
    const f = dlFetch(() => okPng());
    const k = makeKaneo(f.impl, "http://k.local:1337");
    for (const url of ["file:///etc/passwd", "not a url"]) {
      const err = await k.downloadAsset(url).catch((e) => e);
      expect(err).toBeInstanceOf(KaneoDefiniteError);
    }
    expect(f.calls).toHaveLength(0);
  });

  it("跨源重定向：第二次请求绝不携带 Authorization，且以 redirect=error 拒绝再跟随", async () => {
    const f = dlFetch((call) =>
      call.url.includes("/api/asset/") ? redirect("http://evil.example.com/leak.png") : okPng(),
    );
    const k = makeKaneo(f.impl, "http://k.local:1337");
    const bytes = await k.downloadAsset("http://k.local:1337/api/asset/abc.png");
    expect([...bytes]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]?.authorization).toBe("Bearer test-api-key");
    expect(f.calls[1]?.url).toBe("http://evil.example.com/leak.png");
    expect(f.calls[1]?.authorization).toBeUndefined(); // 关键：跨源不带凭据
    expect(f.calls[1]?.redirect).toBe("error"); // 且不再跟随
  });

  it("同源重定向：仍然携带凭据（可信来源内保留）", async () => {
    const f = dlFetch((call) => (call.url.endsWith("/old.png") ? redirect("/new.png") : okPng()));
    const k = makeKaneo(f.impl, "http://k.local:1337");
    await k.downloadAsset("http://k.local:1337/api/asset/old.png");
    expect(f.calls[1]?.url).toBe("http://k.local:1337/new.png"); // 相对 Location 按原 URL 解析
    expect(f.calls[1]?.authorization).toBe("Bearer test-api-key");
  });

  it("重定向层级过深：第二跳仍是重定向则停止跟随", async () => {
    const f = dlFetch(() => redirect("/again.png"));
    const k = makeKaneo(f.impl, "http://k.local:1337");
    const err = await k.downloadAsset("http://k.local:1337/api/asset/abc.png").catch((e) => e);
    expect(err).toBeInstanceOf(KaneoDefiniteError);
    expect((err as Error).message).toContain("重定向层级过深");
    expect(f.calls).toHaveLength(2);
  });

  it("重定向缺少 Location 头 → 明确报错", async () => {
    const f = dlFetch(() => new Response(null, { status: 302 }));
    const k = makeKaneo(f.impl, "http://k.local:1337");
    const err = await k.downloadAsset("http://k.local:1337/api/asset/abc.png").catch((e) => e);
    expect(err).toBeInstanceOf(KaneoDefiniteError);
    expect((err as Error).message).toContain("缺少 Location");
  });

  it("404 保持“不能证明文件不存在”的语义；未配置连接时零请求", async () => {
    const f = dlFetch(() => new Response("nope", { status: 404 }));
    const k = makeKaneo(f.impl, "http://k.local:1337");
    const err = await k.downloadAsset("http://k.local:1337/api/asset/abc.png").catch((e) => e);
    expect(err).toBeInstanceOf(KaneoDefiniteError);
    expect((err as Error).message).toContain("404");
    expect((err as Error).message).toContain("不能直接证明文件不存在");

    const unconfigured = createKaneoHttpClient(() => null, f.impl);
    const err2 = await unconfigured.downloadAsset("http://k.local:1337/api/asset/abc.png").catch((e) => e);
    expect(err2).toBeInstanceOf(KaneoDefiniteError);
    expect(f.calls).toHaveLength(1); // 只有 404 那一次，未配置连接没有新增请求
  });
});

/**
 * 视觉能力探针：必须真正读图才能通过。
 * 期望排列由服务端随机生成且不出现在提示词里，因此“接口收下图片但模型忽略图片”
 * （例如只回固定话术）必然得到 ok:false，不会被标为通过。
 */
describe("AI 视觉探针：随机色块顺序", () => {
  const masterKey = Buffer.alloc(32, 7);

  function aiDb() {
    const db = openDb(mkdtempSync(path.join(tmpdir(), "fb-vision-")));
    setSetting(db, "ai.baseUrl", "https://llm.test/v1");
    setSetting(db, "ai.model", "m-vision");
    setSetting(db, "ai.apiKeyEnc", encryptSecret(masterKey, "sk-vision"));
    return db;
  }

  /** 从请求体里取回服务端生成的探针图（模拟"模型真正收到的那张图"）。 */
  function pngFromBody(body: string): Buffer {
    const parsed = JSON.parse(body) as {
      messages: { content: ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] }[];
    };
    const parts = parsed.messages[0]!.content as { type: string; text?: string; image_url?: { url: string } }[];
    const url = parts.find((p) => p.type === "image_url")?.image_url?.url ?? "";
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    return Buffer.from(url.slice("data:image/png;base64,".length), "base64");
  }

  /** 提示词文本（用于断言答案没有泄漏进提示词）。 */
  function textFromBody(body: string): string {
    const parsed = JSON.parse(body) as {
      messages: { content: { type: string; text?: string }[] }[];
    };
    return (parsed.messages[0]!.content as { type: string; text?: string }[])
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
  }

  /** 独立于被测代码地从像素还原颜色顺序：直接采样每个色块中心像素。 */
  async function orderFromPng(png: Buffer): Promise<string[]> {
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const names: string[] = [];
    for (let b = 0; b < VISION_PROBE_BLOCKS; b++) {
      const x = b * VISION_PROBE_BLOCK_PX + Math.floor(VISION_PROBE_BLOCK_PX / 2);
      const y = Math.floor(info.height / 2);
      const o = (y * info.width + x) * info.channels;
      const rgb: [number, number, number] = [data[o]!, data[o + 1]!, data[o + 2]!];
      let best = "";
      let bestDist = Number.POSITIVE_INFINITY;
      for (const c of VISION_PROBE_PALETTE) {
        const d = (c.rgb[0] - rgb[0]) ** 2 + (c.rgb[1] - rgb[1]) ** 2 + (c.rgb[2] - rgb[2]) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = c.name;
        }
      }
      names.push(best);
    }
    return names;
  }

  it("探针图：3 个互不相同的色块，尺寸与调色板一致", async () => {
    const { png, expected } = await buildVisionProbeImage();
    expect(expected).toHaveLength(VISION_PROBE_BLOCKS);
    expect(new Set(expected).size).toBe(VISION_PROBE_BLOCKS); // 不重复，顺序才有意义
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(VISION_PROBE_BLOCK_PX * VISION_PROBE_BLOCKS);
    expect(meta.height).toBe(VISION_PROBE_BLOCK_PX);
    // 从像素还原出的顺序必须与 expected 完全一致
    expect(await orderFromPng(png)).toEqual(expected);
  });

  it("调色板自检：每个色块最近的命名色就是它自己的标签（堵住假失败）", () => {
    // 探针判定的是「模型有没有真的看图」。模型看图后照实念出的名字取决于色值，而非我们的意图。
    // 若某色块的"最近命名色"不是它的标签，模型读对了图也会被判失败 —— 那是仪器缺陷，不是能力不足。
    // 历史教训：purple=rgb(140,50,190) 最近的是 darkorchid，实测约 1/15 被误判。
    const CSS_NAMED: Record<string, [number, number, number]> = {
      red: [255, 0, 0],
      crimson: [220, 20, 60],
      firebrick: [178, 34, 34],
      green: [0, 128, 0],
      lime: [0, 255, 0],
      forestgreen: [34, 139, 34],
      blue: [0, 0, 255],
      navy: [0, 0, 128],
      royalblue: [65, 105, 225],
      yellow: [255, 255, 0],
      gold: [255, 215, 0],
      olive: [128, 128, 0],
      orange: [255, 165, 0],
      darkorange: [255, 140, 0],
      amber: [255, 191, 0],
      purple: [128, 0, 128],
      magenta: [255, 0, 255],
      violet: [238, 130, 238],
      blueviolet: [138, 43, 226],
      darkorchid: [153, 50, 204],
      indigo: [75, 0, 130],
      pink: [255, 192, 203],
      brown: [165, 42, 42],
      gray: [128, 128, 128],
    };
    const d2 = (a: [number, number, number], b: [number, number, number]) =>
      (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

    for (const c of VISION_PROBE_PALETTE) {
      const nearest = Object.entries(CSS_NAMED)
        .map(([n, rgb]) => [n, d2(rgb, c.rgb)] as const)
        .sort((x, y) => x[1] - y[1])[0]!;
      expect(
        nearest[0],
        `色块 ${c.name}=rgb(${c.rgb.join(",")}) 最近的命名色是 ${nearest[0]}；模型照实念就会被判失败`,
      ).toBe(c.name);
    }

    // 色块之间也要分得开，避免 orderFromPng 的"采样像素→就近匹配"自洽还原互相混淆
    for (let i = 0; i < VISION_PROBE_PALETTE.length; i++) {
      for (let j = i + 1; j < VISION_PROBE_PALETTE.length; j++) {
        const a = VISION_PROBE_PALETTE[i]!;
        const b = VISION_PROBE_PALETTE[j]!;
        expect(Math.sqrt(d2(a.rgb, b.rgb)), `${a.name} 与 ${b.name} 太接近`).toBeGreaterThan(60);
      }
    }
  });

  it("提示词不含任何调色板颜色名（答案只留在服务端）", async () => {
    const f = fakeFetch(() => ({
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: "red,green,blue" } }] }),
    }));
    const ai = createAiClient(aiDb(), masterKey, f.impl);
    await ai.testVision();
    const text = textFromBody(f.calls[0]?.body ?? "{}").toLowerCase();
    for (const c of VISION_PROBE_PALETTE) {
      expect(text).not.toContain(c.name);
    }
  });

  it("模型读出真实顺序 → ok:true", async () => {
    const calls: string[] = [];
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "{}";
      calls.push(body);
      const order = await orderFromPng(pngFromBody(body));
      return new Response(JSON.stringify({ choices: [{ message: { content: order.join(",") } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const ai = createAiClient(aiDb(), masterKey, impl);
    const r = await ai.testVision();
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("回答顺序错误 → ok:false 且给出明确原因（不静默通过）", async () => {
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "{}";
      const order = await orderFromPng(pngFromBody(body));
      const wrong = [...order].reverse().join(",");
      return new Response(JSON.stringify({ choices: [{ message: { content: wrong } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const ai = createAiClient(aiDb(), masterKey, impl);
    const r = await ai.testVision();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("视觉识别不匹配");
    expect(r.reply).toBeTruthy();
  });

  it("忽略图片只回固定话术（旧探针的通过条件）→ ok:false", async () => {
    const f = fakeFetch(() => ({
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: "视觉连接测试成功" } }] }),
    }));
    const ai = createAiClient(aiDb(), masterKey, f.impl);
    const r = await ai.testVision();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("视觉识别不匹配");
  });

  it("parseColorOrder 容错：同义词归一、忽略中文与解释文字", () => {
    expect(parseColorOrder("Violet, green , BLUE")).toEqual(["purple", "green", "blue"]);
    expect(parseColorOrder("从左到右是 red,green,blue")).toEqual(["red", "green", "blue"]);
    expect(parseColorOrder("视觉连接测试成功")).toEqual([]);
  });
});
