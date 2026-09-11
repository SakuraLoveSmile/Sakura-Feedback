import type { ProcessedFeedback } from "../types.ts";

export interface KaneoColumn {
  id: string;
  slug: string;
  name: string;
}

export interface KaneoTaskRef {
  taskId: string;
  taskUrl: string;
}

/** 目标列不存在/失效。属于确定性失败，调用保证未发出创建请求。 */
export class KaneoColumnNotFound extends Error {}

/** 请求可能已到达 Kaneo 但结果不确定（超时/连接中断/写入后 5xx）。 → 待核对 */
export class KaneoUncertainError extends Error {}

/** 明确的业务拒绝（4xx 等），未创建任务。 */
export class KaneoDefiniteError extends Error {}

export interface KaneoSettings {
  baseUrl: string; // API 基址（含或不含 /api 后缀均可，内部规范化）
  apiKey: string;
  clientUrl: string; // Web 基址，用于拼任务链接
}

export interface KaneoWorkspace {
  id: string;
  name: string;
}

export interface KaneoProjectInfo {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
}

export interface KaneoUploadPresigned {
  key: string;
  uploadUrl: string;
  headers: Record<string, string>;
}

export interface KaneoFinalizedAsset {
  id: string;
  url: string;
}

export interface KaneoComment {
  id: string;
  content: string;
}

export interface KaneoClient {
  /**
   * 固定一份连接配置：返回的客户端在本次操作（含其中全部重试步骤）内恒用该配置，
   * 并持有独立的项目缓存，绝不在请求之间重新读取可能已被修改的全局配置。
   */
  bind(settings: KaneoSettings): KaneoClient;
  /** 连接测试：校验项目存在并返回其下所有列（用于管理页选择、保存真实 slug）。 */
  test(projectId: string): Promise<{
    project: { id: string; name: string; workspaceId: string; slug: string };
    columns: KaneoColumn[];
  }>;
  /** 读取项目信息（恢复目标固定用：workspaceId 只能由 Kaneo 提供）。只读请求，失败不会产生远端写入。 */
  getProjectInfo(projectId: string): Promise<{ id: string; workspaceId: string; name: string; slug: string }>;
  /** 列出密钥可见的工作区与项目（管理页选择目标项目用）。 */
  listProjects(): Promise<{ workspaces: KaneoWorkspace[]; projects: KaneoProjectInfo[] }>;
  /** 先解析 columnSlug（查不到抛 KaneoColumnNotFound，保证未发出写请求），再创建任务。 */
  createTask(input: {
    projectId: string;
    columnSlug: string;
    title: string;
    description: string;
  }): Promise<KaneoTaskRef>;
  /** 按描述中的反馈 ID 标记搜索任务（待核对恢复）。 */
  findByFeedbackId(projectId: string, feedbackId: string): Promise<KaneoTaskRef | null>;
  /** 申请任务图片上传预签名地址。 */
  createImageUpload(
    taskId: string,
    input: { filename: string; contentType: string; size: number; surface: "comment" },
  ): Promise<KaneoUploadPresigned>;
  /** 上传图片二进制至预签名地址（绝不携带 Kaneo API Key）。 */
  uploadImageToPresigned(uploadUrl: string, headers: Record<string, string>, bytes: Buffer | Uint8Array): Promise<void>;
  /** 登记已上传资产。 */
  finalizeImageUpload(
    taskId: string,
    input: { key: string; filename: string; contentType: string; size: number; surface: "comment" },
  ): Promise<KaneoFinalizedAsset>;
  /** 添加评论。 */
  createComment(taskId: string, input: { content: string }): Promise<{ id: string }>;
  /** 获取任务所有评论列表。 */
  listComments(taskId: string): Promise<KaneoComment[]>;
  /**
   * 经现有鉴权资产下载接口读取资产字节（确认远端真实文件用，比对本地 PNG SHA-256）。
   * 只读请求；任何失败（含 404）都不可当作“文件不存在”的证明，调用方必须保持恢复状态。
   *
   * 安全约束：地址必须落在可信 Kaneo 来源内，且绝不向跨源重定向目标携带 API Key。
   */
  downloadAsset(assetUrl: string): Promise<Uint8Array>;
}

/** 生成截图评论内容。 */
export function buildScreenshotComment(meta: {
  feedbackId: string;
  assetUrl: string;
  sha256: string;
  width: number;
  height: number;
}): string {
  return [
    `![反馈截图](${meta.assetUrl})`,
    "---",
    `**反馈ID**：${meta.feedbackId}`,
    `**截图摘要**：\`${meta.sha256}\` · ${meta.width}×${meta.height}`,
  ].join("\n\n");
}

/** 归档任务描述：AI 整理结果在前，来源与原话由服务端追加，AI 不可改写。 */
export function buildTaskDescription(
  feedbackId: string,
  processed: ProcessedFeedback,
  meta: {
    appName: string;
    appId: string;
    appVersion?: string;
    pageLabel?: string;
    submittedAt: string;
    text: string;
  },
): string {
  const parts: string[] = [];
  const section = (name: string, body: string) => {
    if (body) parts.push(`## ${name}\n\n${body}`);
  };
  section("使用体验", processed.sections.experience);
  section("问题", processed.sections.problems);
  section("建议", processed.sections.suggestions);
  section("待确认事项", processed.sections.questions);

  const sourceBits = [`${meta.appName}（${meta.appId}）`];
  if (meta.appVersion) sourceBits.push(`版本 ${meta.appVersion}`);
  if (meta.pageLabel) sourceBits.push(`页面 ${meta.pageLabel}`);

  parts.push("---");
  parts.push(`**来源**：${sourceBits.join(" · ")}`);
  parts.push(`**提交时间**：${meta.submittedAt}`);
  const quoted = meta.text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  parts.push(`**用户原话**：\n\n${quoted}`);
  parts.push(`**反馈ID**：${feedbackId}`);
  return parts.join("\n\n");
}
