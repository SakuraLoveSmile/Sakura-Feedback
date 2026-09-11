import {
  type KaneoClient,
  type KaneoColumn,
  KaneoColumnNotFound,
  KaneoDefiniteError,
  type KaneoProjectInfo,
  type KaneoSettings,
  type KaneoTaskRef,
  KaneoUncertainError,
  type KaneoWorkspace,
} from "./kaneo.ts";

/** 归一化 Kaneo API 基址：根去掉尾部斜杠，不含 /api 后缀则补上（恢复目标固定与客户端共用同一规则）。 */
export function normalizeKaneoApiBase(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, "");
  return /\/api$/.test(root) ? root : `${root}/api`;
}

/**
 * 可信 Kaneo 主机名集合：API 基址与 Web 基址（clientUrl）各自的主机名。
 * 附件下载/重定向只允许落在这些主机及其子域内，避免把 API Key 发给任意 URL。
 */
export function trustedKaneoHosts(settings: { baseUrl: string; clientUrl?: string }): string[] {
  const hosts = new Set<string>();
  for (const raw of [settings.baseUrl, settings.clientUrl ?? ""]) {
    if (!raw) continue;
    try {
      const u = new URL(normalizeKaneoApiBase(raw));
      if (u.hostname) hosts.add(u.hostname.toLowerCase());
    } catch {
      /* 非法 URL 由 requireSettings 统一报错 */
    }
  }
  return [...hosts];
}

/** 主机名是否可信：完全一致，或为其子域（如 files.kaneo.example.com 之于 kaneo.example.com）。 */
export function isTrustedKaneoHost(hostname: string, trustedHosts: string[]): boolean {
  const h = hostname.toLowerCase();
  return trustedHosts.some((t) => h === t || h.endsWith(`.${t}`));
}

/** 校验一个附件地址是否可携带凭据访问。 */
function assertTrustedAssetUrl(raw: string, trustedHosts: string[]): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new KaneoDefiniteError("资产地址不是合法 URL，已拒绝携带凭据访问");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new KaneoDefiniteError(`资产地址协议不受支持（${u.protocol}），已拒绝携带凭据访问`);
  }
  if (trustedHosts.length === 0) {
    throw new KaneoDefiniteError("Kaneo 连接未配置，无法确认资产地址是否可信，已拒绝访问");
  }
  if (!isTrustedKaneoHost(u.hostname, trustedHosts)) {
    throw new KaneoDefiniteError(
      `资产地址不在可信 Kaneo 来源内（${u.origin}，可信主机：${trustedHosts.join(", ")}），已拒绝携带凭据访问`,
    );
  }
  return u;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Kaneo HTTP 客户端（依据 Kaneo v2.x 源码只读调研的契约）：
 * - 认证：Authorization: Bearer <api-key>（或 x-api-key），key 在 Kaneo Web UI 签发。
 * - 创建任务：POST {api}/task/{projectId}，body 必填 title/description/priority/status(列 slug)，
 *   不发送 userId/startDate/dueDate/milestoneId 以保持无负责人/无日期默认。
 * - 任务链接：{clientUrl}/dashboard/workspace/{ws}/project/{p}/task/{id}。
 * - 待核对恢复：GET {api}/search/?q=<反馈ID>&workspaceId=<ws>&type=tasks 按描述文本定位。
 * - 错误响应体是 text/plain，读取 text 而非 json。
 */
export function createKaneoHttpClient(
  getSettings: () => KaneoSettings | null,
  fetchImpl: typeof fetch = globalThis.fetch,
): KaneoClient {
  // 轻量缓存：projectId → {workspaceId, slug, name}，避免每次归档额外一次项目查询
  const projectCache = new Map<string, { workspaceId: string; name: string; slug: string }>();

  function requireSettings(): KaneoSettings & { api: string; clientUrl: string } {
    const s = getSettings();
    if (!s?.baseUrl || !s?.apiKey) {
      throw new KaneoDefiniteError("Kaneo 连接未配置");
    }
    let url: URL;
    try {
      url = new URL(s.baseUrl);
    } catch {
      throw new KaneoDefiniteError("Kaneo baseUrl 不是合法 URL");
    }
    const root = url.toString().replace(/\/+$/, "");
    const api = normalizeKaneoApiBase(url.toString());
    let clientUrl = s.clientUrl?.trim();
    if (!clientUrl) clientUrl = root.replace(/\/api$/, "");
    clientUrl = clientUrl.replace(/\/+$/, "");
    return { ...s, api, clientUrl };
  }

  async function req(
    path: string,
    init: { method?: string; body?: string; timeoutMs: number; uncertainOnNetwork: boolean },
  ): Promise<Response> {
    const { api, apiKey } = requireSettings();
    let res: Response;
    try {
      res = await fetchImpl(`${api}${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: init.body,
        signal: AbortSignal.timeout(init.timeoutMs),
      });
    } catch (err) {
      const msg = (err as Error).message?.slice(0, 160) ?? String(err);
      // 创建请求发出后的网络错误结果未知；只读请求安全地归为确定失败
      if (init.uncertainOnNetwork) throw new KaneoUncertainError(`Kaneo 连接中断: ${msg}`);
      throw new KaneoDefiniteError(`Kaneo 无法访问: ${msg}`);
    }
    return res;
  }

  async function bodyText(res: Response): Promise<string> {
    try {
      return (await res.text()).slice(0, 300);
    } catch {
      return "";
    }
  }

  interface KaneoProject {
    id: string;
    name: string;
    workspaceId: string;
    slug: string;
  }

  async function getProject(projectId: string): Promise<KaneoProject> {
    const res = await req(`/project/${encodeURIComponent(projectId)}`, {
      timeoutMs: 15_000,
      uncertainOnNetwork: false,
    });
    if (res.status === 401 || res.status === 403) {
      throw new KaneoDefiniteError(`Kaneo 认证失败或无权限 (${res.status})：${await bodyText(res)}`);
    }
    if (!res.ok) {
      throw new KaneoDefiniteError(`Kaneo 项目不可用 (${res.status})：${await bodyText(res)}`);
    }
    const p = (await res.json()) as Partial<KaneoProject> & Record<string, unknown>;
    if (typeof p.id !== "string" || typeof p.workspaceId !== "string") {
      throw new KaneoDefiniteError("Kaneo 项目响应缺少 id/workspaceId 字段");
    }
    const proj: KaneoProject = {
      id: p.id,
      workspaceId: p.workspaceId,
      name: typeof p.name === "string" ? p.name : projectId,
      slug: typeof p.slug === "string" ? p.slug : "",
    };
    projectCache.set(proj.id, { workspaceId: proj.workspaceId, name: proj.name, slug: proj.slug });
    return proj;
  }

  async function listColumns(projectId: string): Promise<KaneoColumn[]> {
    const res = await req(`/column/${encodeURIComponent(projectId)}`, {
      timeoutMs: 15_000,
      uncertainOnNetwork: false,
    });
    if (res.status === 401 || res.status === 403) {
      throw new KaneoDefiniteError(`Kaneo 认证失败或无权限 (${res.status})`);
    }
    if (!res.ok) {
      throw new KaneoDefiniteError(`Kaneo 列列表获取失败 (${res.status})：${await bodyText(res)}`);
    }
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) throw new KaneoDefiniteError("Kaneo 列响应不是数组");
    return rows
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      .map((r) => ({
        id: String(r.id ?? ""),
        slug: String(r.slug ?? ""),
        name: String(r.name ?? ""),
      }))
      .filter((c) => c.slug !== "");
  }

  function taskUrl(projectId: string, workspaceId: string, taskId: string): string {
    const { clientUrl } = requireSettings();
    return `${clientUrl}/dashboard/workspace/${encodeURIComponent(workspaceId)}/project/${encodeURIComponent(
      projectId,
    )}/task/${encodeURIComponent(taskId)}`;
  }

  return {
    /** 固定配置：返回独立实例（独立项目缓存），此后不再读取变化的全局配置。 */
    bind(settings) {
      return createKaneoHttpClient(() => settings, fetchImpl);
    },

    async test(projectId) {
      const project = await getProject(projectId);
      const columns = await listColumns(projectId);
      return {
        project: { id: project.id, name: project.name, workspaceId: project.workspaceId, slug: project.slug },
        columns,
      };
    },

    async getProjectInfo(projectId) {
      const project = await getProject(projectId);
      return { id: project.id, workspaceId: project.workspaceId, name: project.name, slug: project.slug };
    },

    async listProjects() {
      const wsRes = await req("/auth/organization/list", { timeoutMs: 15_000, uncertainOnNetwork: false });
      if (wsRes.status === 401 || wsRes.status === 403) {
        throw new KaneoDefiniteError(`Kaneo 认证失败或无权限 (${wsRes.status})：${await bodyText(wsRes)}`);
      }
      if (!wsRes.ok) {
        throw new KaneoDefiniteError(`Kaneo 工作区列表获取失败 (${wsRes.status})：${await bodyText(wsRes)}`);
      }
      const wsData: unknown = await wsRes.json().catch(() => []);
      const wsRows: unknown[] = Array.isArray(wsData)
        ? wsData
        : Array.isArray((wsData as { data?: unknown[] } | null)?.data)
          ? ((wsData as { data: unknown[] }).data ?? [])
          : [];
      const workspaces: KaneoWorkspace[] = wsRows
        .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
        .filter((r) => typeof r.id === "string")
        .map((r) => ({ id: String(r.id), name: String(r.name ?? r.slug ?? r.id) }));

      const projects: KaneoProjectInfo[] = [];
      for (const w of workspaces) {
        const pr = await req(`/project?workspaceId=${encodeURIComponent(w.id)}`, {
          timeoutMs: 15_000,
          uncertainOnNetwork: false,
        });
        if (!pr.ok) continue; // 单个工作区不可用时尽力而为
        const rows: unknown = await pr.json().catch(() => []);
        if (!Array.isArray(rows)) continue;
        for (const p of rows) {
          if (typeof p !== "object" || p === null) continue;
          const r = p as Record<string, unknown>;
          if (typeof r.id !== "string") continue;
          projects.push({
            id: r.id,
            workspaceId: String(r.workspaceId ?? w.id),
            name: String(r.name ?? ""),
            slug: String(r.slug ?? ""),
          });
        }
      }
      return { workspaces, projects };
    },

    async createTask({ projectId, columnSlug, title, description }) {
      // —— 写入前置检查（只读；任何失败都不会产生任务） ——
      const project = await getProject(projectId);
      const columns = await listColumns(projectId);
      const column = columns.find((c) => c.slug === columnSlug);
      if (!column) {
        throw new KaneoColumnNotFound(`项目 ${projectId} 中不存在 slug 为 "${columnSlug}" 的列`);
      }

      // —— 创建请求：此后一切异常按“结果不确定”处理 ——
      const res = await req(`/task/${encodeURIComponent(projectId)}`, {
        method: "POST",
        body: JSON.stringify({
          title,
          description,
          priority: "no-priority", // 固定，无负责人/日期/里程碑字段即保持空
          status: column.slug,
        }),
        timeoutMs: 30_000,
        uncertainOnNetwork: true,
      });
      if (res.status >= 500) {
        throw new KaneoUncertainError(`Kaneo 返回 ${res.status}，创建结果不确定`);
      }
      if (!res.ok) {
        throw new KaneoDefiniteError(`Kaneo 拒绝创建 (${res.status})：${await bodyText(res)}`);
      }
      const t = (await res.json().catch(() => null)) as { id?: unknown } | null;
      if (!t || typeof t.id !== "string") {
        throw new KaneoUncertainError("Kaneo 创建响应缺少任务 id");
      }
      return { taskId: t.id, taskUrl: taskUrl(projectId, project.workspaceId, t.id) } satisfies KaneoTaskRef;
    },

    async findByFeedbackId(projectId, feedbackId) {
      const cached = projectCache.get(projectId);
      const workspaceId = cached?.workspaceId ?? (await getProject(projectId)).workspaceId;
      const res = await req(
        `/search?q=${encodeURIComponent(feedbackId)}&workspaceId=${encodeURIComponent(
          workspaceId,
        )}&type=tasks&limit=20`,
        { timeoutMs: 15_000, uncertainOnNetwork: false },
      );
      if (!res.ok) {
        throw new KaneoDefiniteError(`Kaneo 搜索失败 (${res.status})：${await bodyText(res)}`);
      }
      const data = (await res.json()) as { results?: Record<string, unknown>[] };
      for (const item of data.results ?? []) {
        if (typeof item.id !== "string") continue;
        if (item.projectId !== projectId) continue;
        const desc = typeof item.description === "string" ? item.description : "";
        // 描述需同时含“反馈ID”标记与反馈 ID 本身（uuid 几乎不可能撞车）
        if (desc.includes("反馈ID") && desc.includes(feedbackId)) {
          return { taskId: item.id, taskUrl: taskUrl(projectId, workspaceId, item.id) };
        }
      }
      return null;
    },

    async createImageUpload(taskId, input) {
      // 写操作（分配预签名地址）：网络失败/5xx/响应不可解析 → 结果不确定（4.3 错误分类）
      const res = await req(`/task/image-upload/${encodeURIComponent(taskId)}`, {
        method: "PUT",
        body: JSON.stringify({
          filename: input.filename,
          contentType: input.contentType,
          size: input.size,
          surface: input.surface,
        }),
        timeoutMs: 15_000,
        uncertainOnNetwork: true,
      });
      if (res.status >= 500) {
        throw new KaneoUncertainError(`Kaneo 返回 ${res.status}，预签名分配结果不确定`);
      }
      if (!res.ok) {
        throw new KaneoDefiniteError(`Kaneo 申请图片上传地址失败 (${res.status})：${await bodyText(res)}`);
      }
      let data: { key?: unknown; uploadUrl?: unknown; headers?: unknown } | null = null;
      try {
        data = (await res.json()) as { key?: unknown; uploadUrl?: unknown; headers?: unknown };
      } catch {
        data = null;
      }
      if (!data || typeof data.key !== "string" || typeof data.uploadUrl !== "string") {
        throw new KaneoUncertainError("Kaneo 图片上传响应不可解析，分配结果不确定");
      }
      const headers: Record<string, string> = {};
      if (typeof data.headers === "object" && data.headers !== null) {
        for (const [k, v] of Object.entries(data.headers)) {
          if (typeof v === "string") headers[k] = v;
        }
      }
      return { key: data.key, uploadUrl: data.uploadUrl, headers };
    },

    async uploadImageToPresigned(uploadUrl, headers, bytes) {
      let res: Response;
      try {
        res = await fetchImpl(uploadUrl, {
          method: "PUT",
          headers, // 仅发送预签名要求的请求头，绝不向存储地址携带 Kaneo API Key
          body: bytes as unknown as BodyInit,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        throw new KaneoUncertainError(`图片上传至存储服务连接异常: ${(err as Error).message?.slice(0, 150)}`);
      }
      if (!res.ok) {
        throw new KaneoDefiniteError(`图片上传至存储服务失败 (${res.status})`);
      }
    },

    async finalizeImageUpload(taskId, input) {
      const res = await req(`/task/image-upload/${encodeURIComponent(taskId)}/finalize`, {
        method: "POST",
        body: JSON.stringify({
          key: input.key,
          filename: input.filename,
          contentType: input.contentType,
          size: input.size,
          surface: input.surface,
        }),
        timeoutMs: 15_000,
        uncertainOnNetwork: true,
      });
      if (res.status >= 500) {
        throw new KaneoUncertainError(`Kaneo 返回 ${res.status}，资产登记结果不确定`);
      }
      if (!res.ok) {
        throw new KaneoDefiniteError(`Kaneo 登记图片资产失败 (${res.status})：${await bodyText(res)}`);
      }
      let data: { id?: unknown; url?: unknown } | null = null;
      try {
        data = (await res.json()) as { id?: unknown; url?: unknown };
      } catch {
        data = null;
      }
      if (!data || typeof data.id !== "string" || typeof data.url !== "string") {
        throw new KaneoUncertainError("Kaneo 登记图片资产响应不可解析，登记结果不确定");
      }
      return { id: data.id, url: data.url };
    },

    async createComment(taskId, input) {
      const res = await req(`/comment/${encodeURIComponent(taskId)}`, {
        method: "POST",
        body: JSON.stringify({
          content: input.content,
        }),
        timeoutMs: 15_000,
        uncertainOnNetwork: true,
      });
      if (res.status >= 500) {
        throw new KaneoUncertainError(`Kaneo 评论返回 ${res.status}，评论结果不确定`);
      }
      if (!res.ok) {
        throw new KaneoDefiniteError(`Kaneo 添加评论失败 (${res.status})：${await bodyText(res)}`);
      }
      let data: { id?: unknown } | null = null;
      try {
        data = (await res.json()) as { id?: unknown };
      } catch {
        data = null;
      }
      if (!data || typeof data.id !== "string") {
        // 2xx 但响应不可解析：评论结果不确定（可能已创建），走待核对
        throw new KaneoUncertainError("Kaneo 评论响应不可解析，评论结果不确定");
      }
      return { id: data.id };
    },

    async listComments(taskId) {
      const res = await req(`/comment/${encodeURIComponent(taskId)}`, {
        method: "GET",
        timeoutMs: 15_000,
        uncertainOnNetwork: false,
      });
      if (!res.ok) {
        throw new KaneoDefiniteError(`Kaneo 获取评论列表失败 (${res.status})：${await bodyText(res)}`);
      }
      // 读取失败/格式错误绝不能当作“没有评论”（4.3）
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        throw new KaneoDefiniteError("Kaneo 评论列表响应不是 JSON，无法核对");
      }
      if (!Array.isArray(data)) {
        throw new KaneoDefiniteError("Kaneo 评论列表响应不是数组，无法核对");
      }
      const parsed = data
        .filter(
          (item): item is { id: string; content: string } =>
            typeof item === "object" &&
            item !== null &&
            typeof item.id === "string" &&
            typeof item.content === "string",
        )
        .map((item) => ({ id: item.id, content: item.content }));
      if (data.length > 0 && parsed.length === 0) {
        throw new KaneoDefiniteError("Kaneo 评论列表条目全部无法解析，无法核对");
      }
      return parsed;
    },

    async downloadAsset(assetUrl) {
      // 经现有鉴权资产下载接口读字节（确认远端真实文件用）。只读请求：
      // 任何失败（含 404）都不可当作“文件不存在”的证明，由调用方保持恢复状态。
      //
      // 安全约束（P1）：只向可信 Kaneo 来源携带 API Key；重定向按 manual 处理，
      // 跨源重定向目标绝不携带 Authorization。
      const settings = requireSettings();
      const trustedHosts = trustedKaneoHosts(settings);
      const first = assertTrustedAssetUrl(assetUrl, trustedHosts);
      const accept = "application/octet-stream";

      async function fetchNoFollow(target: URL, withCredential: boolean): Promise<Response> {
        try {
          return await fetchImpl(target, {
            method: "GET",
            headers: withCredential ? { authorization: `Bearer ${settings.apiKey}`, accept } : { accept },
            redirect: withCredential ? "manual" : "error",
            signal: AbortSignal.timeout(30_000),
          });
        } catch (err) {
          throw new KaneoDefiniteError(`资产下载连接异常: ${(err as Error).message?.slice(0, 150)}`);
        }
      }

      let res = await fetchNoFollow(first, true);
      if (isRedirectStatus(res.status)) {
        const location = res.headers.get("location");
        if (!location) throw new KaneoDefiniteError("资产下载被重定向但缺少 Location 头");
        let next: URL;
        try {
          next = new URL(location, first);
        } catch {
          throw new KaneoDefiniteError("资产下载重定向目标不是合法 URL");
        }
        // 可信来源内保留凭据；跨源一律不带 Authorization（避免凭据泄漏到任意主机）。
        const sameTrust = isTrustedKaneoHost(next.hostname, trustedHosts);
        res = await fetchNoFollow(next, sameTrust);
        if (isRedirectStatus(res.status)) {
          throw new KaneoDefiniteError("资产下载重定向层级过深，已停止跟随");
        }
      }
      if (!res.ok) {
        throw new KaneoDefiniteError(
          res.status === 404 ? `资产下载返回 404（不能直接证明文件不存在）` : `资产下载失败 (${res.status})`,
        );
      }
      try {
        return new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        throw new KaneoDefiniteError(`资产下载读取失败: ${(err as Error).message?.slice(0, 150)}`);
      }
    },
  };
}
