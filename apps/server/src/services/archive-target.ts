import { type KaneoClient, KaneoDefiniteError } from "./kaneo.ts";

/**
 * 归档目标的“实时核对”结果。
 * 人工归档与管理页选项、自动归档授权共用同一份实现，避免两条路径对
 * “项目 / 列 / 工作区标签 / 负责人是否有效”产生不一致的判断。
 */
export interface ResolvedArchiveTarget {
  project: { id: string; name: string; workspaceId: string };
  column: { id: string; slug: string; name: string };
  labels: Array<{ id: string; name: string }>;
  assigneeId: string | null;
  assigneeName: string | null;
}

/**
 * 解析失败的两类语义（T3）：
 * - `config`：Kaneo 可达，但所选目标已失效（列被删、标签不再是工作区级、负责人已离开工作区）
 *   ——属于**配置问题**，等待管理员修正，不做退避重试；
 * - `retryable`：Kaneo 不可达 / 网络或鉴权临时故障 —— 可恢复，按有上限的退避重试。
 */
export type TargetResolveResult =
  | { ok: true; target: ResolvedArchiveTarget }
  | { ok: false; kind: "config"; reason: string }
  | { ok: false; kind: "retryable"; reason: string };

/** 目标列在该项目中不存在、或标签/负责人不合法时抛出的配置类错误。 */
export class ArchiveTargetInvalidError extends Error {}

/**
 * 实时读取并核对归档目标。只读请求，绝不产生远端写入。
 * 已知的业务拒绝（4xx 等）按配置问题处理；其余按可恢复故障处理。
 */
export async function resolveArchiveTarget(
  kaneo: KaneoClient,
  input: { projectId: string; columnId: string; labelIds: string[]; assigneeId: string | null },
): Promise<TargetResolveResult> {
  let project: { id: string; name: string; workspaceId: string };
  let columns: { id: string; slug: string; name: string }[];
  let labels: { id: string; name: string }[];
  let members: { id: string; name: string }[];
  try {
    const info = await kaneo.getProjectInfo(input.projectId);
    project = { id: info.id, name: info.name, workspaceId: info.workspaceId };
    const [cols, allLabels, mems] = await Promise.all([
      kaneo.listColumns(project.id),
      kaneo.listWorkspaceLabels(project.workspaceId),
      kaneo.listWorkspaceMembers(project.workspaceId),
    ]);
    columns = cols.map((x) => ({ id: x.id, slug: x.slug, name: x.name }));
    // 只接受工作区级标签（taskId 为 null），避免把其他任务上的标签搬走。
    labels = allLabels.filter((l) => l.taskId === null).map((l) => ({ id: l.id, name: l.name }));
    members = mems.map((m) => ({ id: m.id, name: m.name }));
  } catch (errObj) {
    const message = (errObj as Error).message?.slice(0, 200) ?? String(errObj);
    // 明确的业务拒绝说明目标本身有问题（项目不存在 / 无权访问）：按配置问题处理。
    if (errObj instanceof KaneoDefiniteError) {
      return { ok: false, kind: "config", reason: `Kaneo 拒绝读取目标：${message}` };
    }
    return { ok: false, kind: "retryable", reason: `无法读取 Kaneo 目标：${message}` };
  }

  if (!project.id) return { ok: false, kind: "config", reason: "Kaneo 未返回有效的项目信息" };

  const column = columns.find((x) => x.id === input.columnId);
  if (!column) return { ok: false, kind: "config", reason: "所选目标列在该项目中不存在，请重新选择" };

  const labelMap = new Map(labels.map((l) => [l.id, l] as const));
  const pickedLabels: { id: string; name: string }[] = [];
  for (const labelId of input.labelIds) {
    const hit = labelMap.get(labelId);
    if (!hit) {
      return { ok: false, kind: "config", reason: "所选标签不是该工作区的工作区级标签，请重新选择" };
    }
    pickedLabels.push({ id: hit.id, name: hit.name });
  }

  let assigneeName: string | null = null;
  if (input.assigneeId) {
    const member = members.find((m) => m.id === input.assigneeId);
    if (!member) return { ok: false, kind: "config", reason: "所选负责人不是该工作区成员，请重新选择" };
    assigneeName = member.name;
  }

  return {
    ok: true,
    target: { project, column, labels: pickedLabels, assigneeId: input.assigneeId, assigneeName },
  };
}
