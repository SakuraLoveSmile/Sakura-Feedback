import {
  ApiError,
  MAX_TEXT,
  codePointLength,
  collectionWaitingText,
  fetchAttachmentBlob,
  getFeedback,
  getFeedbackDialogue,
  getFeatures,
  getUnreadSummary,
  getSession,
  joinApi,
  listMyFeedbacks,
  login,
  markFeedbackRead,
  parseCapabilities,
  sendFeedbackReply,
  submitFeedback,
  uuid,
  type AuthUser,
  type FeedbackCaptureInfo,
  type FeedbackCaptureRegion,
  type FeedbackContext,
  type FeedbackDialogueResponse,
  type FeedbackImageInput,
  type FeedbackImageSource,
  type FeedbackLogAttachment,
  type FeedbackRecord,
  type FeedbackStatus,
  type IssueStatus,
  type Quota,
  type UserFeedbackListItem,
} from './api';
import {
  ImageInputError,
  MAX_IMAGES,
  countUndrawableContent,
  decodeImage,
  exportEditedImage,
  normalizeImageFilename,
  prepareImageForUpload,
  type PreparedImage,
} from './images';
import { openImageEditor, type ImageEditorHandle } from './image_editor';
import { wrapFetch, type FeedbackDiagnosticsRecorder } from './diagnostics';
import type { FetchLike } from './api';
import {
  normalizeServerBase,
  serverOverrideStorageKey,
  writeServerOverride,
} from './server_pref';
import { loginErrorMessage, webClientLabel } from './auth';
import { STYLES } from './styles';
import {
  normalizeAppId,
  projectColor,
  projectDisplayName,
  projectStyleVars,
} from './project_color';
import {
  CAPTURE_FAILURE_MESSAGE,
  CaptureError,
  captureViewport,
  countVisibleSensitiveRegions,
  logicalViewport,
  validateProviderResult,
  type CaptureProvider,
} from './capture';
import {
  REGION_HANDLES,
  REGION_KEY_STEP,
  cropFrozenRegion,
  initialRegionSelection,
  moveRegion,
  normalizeRegion,
  regionFromDrag,
  resizeRegion,
  type RegionHandle,
  type RegionRect,
  type RegionViewport,
} from './region';

export interface FeedbackLogFile {
  filename: string;
  blob: Blob;
}

export type FeedbackLogProvider = () =>
  | Promise<FeedbackLogFile | FeedbackLogFile[] | null | undefined>
  | FeedbackLogFile
  | FeedbackLogFile[]
  | null
  | undefined;

export interface FeedbackHostSession {
  accessToken: string;
  expiresAt: number | string;
}

export interface FeedbackSessionStore {
  loadSession(): Promise<FeedbackHostSession | null> | FeedbackHostSession | null;
  saveSession(session: FeedbackHostSession): Promise<void> | void;
  clearSession(): Promise<void> | void;
}

export interface FeedbackHostBridge {
  sessionStore?: FeedbackSessionStore;
  onPanelOpen?: (detail: { page?: string }) => void;
  onPanelClose?: () => void;
  onSaveAttachment?: (file: { name: string; mimeType: string; dataUrl?: string }) => void | Promise<void>;
  onOpenExternal?: (url: string) => void;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const base64 = typeof btoa === 'function' ? btoa(binary) : '';
  return `data:${blob.type || 'application/octet-stream'};base64,${base64}`;
}

/** v12 用户端统一显示文案（docs/api.md：open 待处理 / waiting_admin 待管理员回复）。 */
export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  open: '待处理',
  waiting_user: '待补充',
  waiting_admin: '等待回复',
  resolved: '已解决',
};

/**
 * 状态 -> `.fb-tag` 修饰类（styles.ts 既有 `waiting-admin` / `waiting-user` / `resolved`）。
 * `open` 历史上没有修饰类（落到 `.fb-tag` 默认灰），S2 补齐 `open`，使待处理行有独立色。
 */
const ISSUE_STATUS_TAG_CLASS: Record<IssueStatus, string> = {
  open: 'open',
  waiting_user: 'waiting-user',
  waiting_admin: 'waiting-admin',
  resolved: 'resolved',
};

/**
 * 状态 -> 行修饰类（styles.ts v13 区块）。
 *
 * 必须走白名单而不是 `` `fb-issue--${status}` `` 直接插值：`issueStatus` 来自服务端 JSON
 * （`listUserFeedbacks` 只做了 `as IssueStatus` 断言，没有运行期校验），插值时任意含空格的
 * 字符串都会变成**额外的 class token 写进 Shadow DOM**。那虽不是 HTML 注入，却能让远端
 * 命中组件既有样式（如 `fb-tag`、`fb-hidden` 之类），把行悄悄改色/改布局。
 * 未登记的状态一律归到 `fb-issue--unknown`（无样式规则）：只失去配色，不引入新 token。
 */
const ISSUE_ROW_MODIFIER_CLASS: Record<IssueStatus, string> = {
  open: 'fb-issue--open',
  waiting_user: 'fb-issue--waiting_user',
  waiting_admin: 'fb-issue--waiting_admin',
  resolved: 'fb-issue--resolved',
};

/** 行修饰类兜底：状态缺失/异常时使用，styles.ts 里刻意不给它任何规则。 */
const UNKNOWN_ISSUE_ROW_CLASS = 'fb-issue--unknown';

/**
 * 附件/动态计数兜底：旧服务端不返回、返回 null 或 NaN 时一律视为「无数据」，
 * 绝不把 undefined/NaN 写进 UI（渲染为 0 也会被正数过滤掉）。
 */
function positiveCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** 列表行的时间文案：lastActivityAt 优先，缺失/非法时退回 createdAt，仍非法则不显示。 */
function historyTimeText(item: UserFeedbackListItem): string | null {
  const raw = item.lastActivityAt || item.createdAt;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString();
}

/** 「我的反馈」当前页的分组结果（见 `groupHistoryItems`）。 */
interface HistoryProjectGroup {
  /** 归一化后的 appId（空串 = 未知项目）。 */
  key: string;
  /** 分组头文案；`null` 表示不渲染分组头。 */
  label: string | null;
  /** 不分组时是否在行内保留项目 chip。 */
  showInlineProjectChip: boolean;
  items: UserFeedbackListItem[];
}

const ISSUE_NEXT_STEPS: Record<IssueStatus, string> = {
  open: '反馈已收到，等待管理员处理。你可以继续补充信息。',
  waiting_user: '管理员需要更多信息，请查看回复并在下方补充。',
  waiting_admin: '等待管理员回复。你可以继续补充信息。',
  resolved: '问题已标记为解决。如仍有问题，可在原反馈中继续补充，管理员会继续跟进。',
};

function trackingErrorText(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if (/^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/i.test(error.message)) {
    return '无法连接反馈服务，请检查网络';
  }
  return error.message || fallback;
}

/**
 * 草稿图片（v12 多图模型）：自动截图与用户手动添加的图片共存于同一列表。
 * `source` 为提交口径（capture/manual/edited）；`origin` 记录最初来源，
 * 用于「重新截图」定位该替换哪一张（编辑过的截图仍视为截图）。
 */
export interface DraftImage {
  /** 稳定 ID（提交描述符复用；编辑保存替换内容时 ID 不变）。 */
  id: string;
  blob: Blob;
  /** 预览用对象 URL（断开重连时按 blob 重建）。 */
  url: string;
  source: FeedbackImageSource;
  /** 最初来源：'capture' 表示该图由截图产生（含后续编辑），重拍/移除截图针对它。 */
  origin: 'capture' | 'manual';
  filename: string;
  mime: string;
  width: number;
  height: number;
  /** 截图元数据（仅截图来源图片携带）。 */
  captureInfo?: FeedbackCaptureInfo | null;
  /** 捕获时检测到不可绘制内容（跨源 iframe / 无 CORS 图像）→ 预览旁提示。 */
  hasUndrawable?: boolean;
  /** 客户端收缩后仍 >5 MiB：提示用户并保留草稿（服务端会按 413 拒绝）。 */
  oversize?: boolean;
}

interface DraftState {
  text: string;
  /** v12：有序图片草稿（≤5，截图与手动并存）。 */
  images: DraftImage[];
  logs: FeedbackLogAttachment[];
  logsCollected: boolean;
  /** 草稿版本号：每次内容变更递增，用于判定提交快照是否与当前草稿一致。 */
  version: number;
}

/**
 * 提交时冻结的快照（实施计划 3.x）：HTTP 只读快照字段，提交期间的草稿编辑
 * 不会影响本次请求；重试在草稿未变时复用同一快照（同 key 同字节）。
 */
interface SubmitSnapshot {
  /** 请求标识（幂等键）。 */
  key: string;
  /** 应用与来源。 */
  apiBase: string;
  appId: string;
  context: FeedbackContext;
  /** 原话。 */
  text: string;
  /** 有序图片快照（冻结的 FeedbackImageInput；blob 引用与草稿共享，ID/文件名冻结）。 */
  images: FeedbackImageInput[];
  /** 截图元数据（随首个 origin=capture 的图片冻结）。 */
  captureInfo: FeedbackCaptureInfo | null;
  /** 日志附件快照（冻结）。 */
  logs: FeedbackLogAttachment[];
  /** 草稿版本：与当前草稿一致时快照可复用（重试同 key 同字节）。 */
  draftVersion: number;
  /** 上一次尝试结果未知（网络错误 / 5xx）：草稿被修改时先保留原请求供核对。 */
  unknownOutcome: boolean;
}

export interface FeedbackSubmittedDetail {
  feedbackId: string;
  status: FeedbackStatus;
  replayed: boolean;
}

/**
 * 已完成遮挡捕获、尚未写入草稿的**冻结全视口位图**与元数据：
 * - 直接路径（面板内截图 / 重拍 / 呼出）在捕获成功后立即 commit 到草稿；
 * - 局部选区路径（灵感球拖拽）先冻结，待用户「使用此区域 / 截取整个窗口」确认后
 *   才裁剪并提交到草稿，「取消」则整体丢弃（不覆盖原草稿、不报失败）。
 */
interface FrozenCapture {
  blob: Blob;
  /** 原始捕获视口（逻辑 CSS 像素）：region 归一化的分母，语义不变。 */
  viewportWidth: number;
  viewportHeight: number;
  /** 原始整窗输出像素。 */
  pixelWidth: number;
  pixelHeight: number;
  capturedAt: string;
  releasePoint?: { x: number; y: number };
  undrawableCount: number;
}

/** 局部选区覆盖层会话：身份世代校验 + 冻结位图 + 当前选区与坐标换算。 */
interface RegionSession {
  /** 打开时的身份世代：切换账号 / api-base 后一切操作一律作废。 */
  epoch: number;
  frozen: FrozenCapture;
  /** 冻结位图的对象 URL（关闭时回收）。 */
  url: string;
  /** 选区坐标系 = 捕获视口逻辑像素。 */
  viewport: RegionViewport;
  /** 覆盖层显示尺寸 = 打开时的窗口内尺寸（位图铺满该区域显示）。 */
  overlay: RegionViewport;
  sel: RegionRect;
  dragging:
    | { mode: 'move' | 'new'; startX: number; startY: number; startSel: RegionRect }
    | { mode: 'resize'; handle: RegionHandle; startX: number; startY: number; startSel: RegionRect }
    | null;
}

type Phase =
  | 'idle' // 可编辑可提交
  | 'submitting' // POST 进行中
  | 'tracking' // 201/200 后轮询（已接收/处理中）
  | 'archived' // 终态：已归档
  | 'failed' // 提交未成功（接口/网络报错）或服务端处理失败（failed/needs_review）
  | 'quota' // 每日额度用尽（明确未接收；非「结果未知」）
  | 'needs_review'; // 服务端标记需要人工核对

const POLL_START_MS = 2000;
const POLL_MAX_MS = 5000;
const POLL_BUDGET_MS = 120000; // ~2 分钟

/**
 * 额度用尽后的重试间隔（T1-B）：后台调高额度后，持续打开的面板最多 30 秒
 * 即可恢复提交，无需关闭重开。用量未用尽时只在 resetAt 排单次查询。
 * 被在途查询 / 登录忙碌挡下的「待立即刷新」优先于本规则——旧查询结束后
 * 或忙碌结束后立即补发一次（见 consumeQuotaRefreshIntent）。
 */
const QUOTA_RETRY_MS = 30_000;

/**
 * 额度定时查询的最大等待。服务端 `resetAt` 正常在 24 小时内（北京时间日切）；
 * 异常 / 超远时间不得直接交给宿主定时器——超过 2^31-1 ms 的延时会被截断为
 * 立即触发，形成对服务端的紧密循环请求。
 */
const QUOTA_MAX_DELAY_MS = 86_400_000;

/**
 * 面板内截图入口的文案：
 * `capture-mode="off"` 表示**关闭自动截图**（不是关闭截图能力），
 * 用户在面板里仍可手动截图——「截取当前页面」就是那条入口。
 */
const CAPTURE_ACTION_LABEL = '截取当前页面';
const CAPTURE_BUSY_LABEL = '截取中…';

/** 记录已进入终态：轮询（或手动刷新）拿到后不再继续跟踪。 */
function isTerminalStatus(status: FeedbackStatus): boolean {
  return status === 'archived' || status === 'failed' || status === 'needs_review';
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

const MAX_LOG_FILES = 3;
const MAX_LOG_BYTES = 1024 * 1024; // 1 MiB
const ALLOWED_LOG_EXTENSIONS = new Set(['.log', '.txt', '.json', '.jsonl']);

function getLogExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return '';
  return name.slice(dot).toLowerCase();
}

function areLogsEqual(a: FeedbackLogAttachment[], b: FeedbackLogAttachment[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const itemA = a[i];
    const itemB = b[i];
    if (!itemA || !itemB) return false;
    if (itemA.blob !== itemB.blob || itemA.filename !== itemB.filename || itemA.source !== itemB.source) {
      return false;
    }
  }
  return true;
}

/** 图片草稿与提交快照是否一致：有序，逐项比 id + blob 引用（编辑替换即 blob 变化）。 */
function areImagesEqual(a: FeedbackImageInput[], b: FeedbackImageInput[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.id !== b[i]?.id || a[i]?.blob !== b[i]?.blob) return false;
  }
  return true;
}

/** 草稿图片 → 提交用 FeedbackImageInput（冻结 id/filename/source/mime，blob 共享）。 */
function toImageInput(img: DraftImage): FeedbackImageInput {
  return {
    id: img.id,
    source: img.source,
    filename: img.filename,
    blob: img.blob,
  };
}

async function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') {
    return await blob.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob, 'utf-8');
  });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgFeedbackIcon(cls: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    'M17 10.5a5.5 5.5 0 0 1-5.5 5.5c-1.1 0-2.1-.3-3-.9L4 16l.9-4.5A5.5 5.5 0 1 1 17 10.5z',
  );
  svg.append(path);
  return svg;
}

/**
 * 注册灵感球的动画自定义属性。
 *
 * Shadow DOM 里的 `@property` 规则不生效（Chrome 156 实测：注册后 documentElement 上
 * 能读到 initial-value，仅靠影子树里的 `@property` 读不到）。未注册的自定义属性在
 * 关键帧里是**离散**的——呼吸会退化成方波——transition 也无法插值。因此注册必须由 JS 做。
 */
function registerOrbProperties(): boolean {
  if (typeof CSS === 'undefined' || typeof CSS.registerProperty !== 'function') return false;
  const defs = [
    ['--fb-orb-breath', '<number>', '0'],
    ['--fb-orb-state-scale', '<number>', '1'],
    ['--fb-orb-breath-weight', '<number>', '1'],
    ['--fb-orb-drag-angle', '<angle>', '0rad'],
    ['--fb-orb-stretch-along', '<number>', '1'],
    ['--fb-orb-glow-x', '<length>', '0px'],
    ['--fb-orb-glow-y', '<length>', '0px'],
  ] as const;
  for (const [name, syntax, initialValue] of defs) {
    try {
      CSS.registerProperty({ name, syntax, inherits: true, initialValue });
    } catch {
      /* 已注册（多实例 / 宿主同时在 light DOM 里加载同一份样式）时仍视为可用 */
    }
  }
  return true;
}

const orbRegisteredPropertiesAvailable = registerOrbProperties();

/** 灵感球的四层视觉 + 焦点环；badge 在组装时独立置于最上方。 */
function orbLayers() {
  const layers = {
    bloom: el('span', 'fb-orb-bloom'),
    glow: el('span', 'fb-orb-glow'),
    sweep: el('span', 'fb-orb-sweep'),
    core: el('span', 'fb-orb-core'),
    focusRing: el('span', 'fb-orb-focus-ring'),
  };
  for (const layer of Object.values(layers)) {
    layer.setAttribute('aria-hidden', 'true');
  }
  return layers;
}

function svgCloseIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  p1.setAttribute('x1', '5');
  p1.setAttribute('y1', '5');
  p1.setAttribute('x2', '15');
  p1.setAttribute('y2', '15');

  const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  p2.setAttribute('x1', '15');
  p2.setAttribute('y1', '5');
  p2.setAttribute('x2', '5');
  p2.setAttribute('y2', '15');

  svg.append(p1, p2);
  return svg;
}

/** 设置图标（齿轮）：描边风格与 fb-close 一致。 */
function svgGearIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const hub = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  hub.setAttribute('cx', '10');
  hub.setAttribute('cy', '10');
  hub.setAttribute('r', '2.4');
  svg.append(hub);
  for (const [x1, y1, x2, y2] of [
    [10, 2.2, 10, 4.4],
    [10, 15.6, 10, 17.8],
    [2.2, 10, 4.4, 10],
    [15.6, 10, 17.8, 10],
    [4.5, 4.5, 6.1, 6.1],
    [13.9, 13.9, 15.5, 15.5],
    [4.5, 15.5, 6.1, 13.9],
    [13.9, 6.1, 15.5, 4.5],
  ]) {
    const spoke = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    spoke.setAttribute('x1', String(x1));
    spoke.setAttribute('y1', String(y1));
    spoke.setAttribute('x2', String(x2));
    spoke.setAttribute('y2', String(y2));
    svg.append(spoke);
  }
  return svg;
}

export class FeedbackWidget extends HTMLElement {
  /** Shadow DOM 模式：默认 open；注册前可设 FeedbackWidget.shadowMode='closed'。 */
  static shadowMode: 'open' | 'closed' = 'open';

  static get observedAttributes(): string[] {
    return [
      'api-base',
      'app-id',
      'app-name',
      'app-version',
      'page-label',
      'side',
      'theme',
      'show-launcher',
      'launcher-bottom',
      'launcher-mode',
      'capture-mode',
    ];
  }

  private readonly root: ShadowRoot;
  private launcher!: HTMLButtonElement;
  private orb!: HTMLButtonElement;
  private panel!: HTMLDivElement;
  private metaInfo!: HTMLSpanElement;
  /** 截图区 = 图片网格（有图才可见）+ 提示 + 操作区（没有截图时是「截取当前页面」）。 */
  private shotArea!: HTMLDivElement;
  private screenshotWrap!: HTMLDivElement;
  private screenshotThumbBox!: HTMLDivElement;
  private screenshotThumb!: HTMLImageElement;
  /** v12：手动添加图片入口与隐藏文件选择器。 */
  private addImageBtn!: HTMLButtonElement;
  private imageFileInput!: HTMLInputElement;
  /** 预览旁提示：部分内容可能未入图 / 服务端单图降级。 */
  private shotHintEl!: HTMLParagraphElement;
  /** 图片错误提示（类型不符、超限等）。 */
  private shotErrorEl!: HTMLParagraphElement;
  /** 首个截图入口（无截图时显示）：默认 capture-mode=off 宿主唯一的手动截图方式。 */
  private captureBtn!: HTMLButtonElement;
  private retakeBtn!: HTMLButtonElement;
  private removeBtn!: HTMLButtonElement;
  private zoomModal!: HTMLDivElement;
  private zoomImg!: HTMLImageElement;
  private zoomCloseBtn!: HTMLButtonElement;
  private textarea!: HTMLTextAreaElement;
  private counter!: HTMLSpanElement;
  private submitBtn!: HTMLButtonElement;
  private statusRegion!: HTMLDivElement;
  private errorRegion!: HTMLDivElement;
  /** 今日剩余额度（登录后显示；未登录/未取得时隐藏）。 */
  private quotaInfo!: HTMLSpanElement;
  /** 额度用尽提示（含下次可提交时间）。 */
  private quotaBlockedInfo!: HTMLParagraphElement;
  /** 面板内登录表单（点击「登录并提交」展开，不打开新窗口）。 */
  private loginPanel!: HTMLDivElement;
  private loginUsername!: HTMLInputElement;
  private loginPassword!: HTMLInputElement;
  private loginErrorEl!: HTMLParagraphElement;
  private loginConfirmBtn!: HTMLButtonElement;
  private loginCancelBtn!: HTMLButtonElement;

  /** T6：面板主体（设置视图展开时整体隐藏）。 */
  private body!: HTMLDivElement;
  /** T6：服务器设置入口与视图。 */
  private settingsBtn!: HTMLButtonElement;
  private settingsView!: HTMLDivElement;
  private settingsInput!: HTMLInputElement;
  private settingsCurrent!: HTMLSpanElement;
  private settingsDefaultRow!: HTMLParagraphElement;
  private settingsDefaultText!: HTMLSpanElement;
  private settingsErrorEl!: HTMLParagraphElement;
  private settingsHintEl!: HTMLParagraphElement;
  private settingsSaveBtn!: HTMLButtonElement;
  private settingsRestoreBtn!: HTMLButtonElement;
  private settingsCancelBtn!: HTMLButtonElement;
  private settingsConfirmEl!: HTMLDivElement;
  private settingsConfirmText!: HTMLParagraphElement;

  /** 日志附件区 */
  private logsArea!: HTMLDivElement;
  private logsCountEl!: HTMLSpanElement;
  private logsList!: HTMLUListElement;
  private addLogBtn!: HTMLButtonElement;
  private logFileInput!: HTMLInputElement;
  private logStatusEl!: HTMLSpanElement;
  private logErrorEl!: HTMLDivElement;
  /** 采集失败时的显式重试入口（挂在 logErrorEl 内，错误清空时随之移除）。 */
  private logRetryBtn!: HTMLButtonElement;
  private logPreviewModal!: HTMLDivElement;
  private logPreviewTitle!: HTMLHeadingElement;
  private logPreviewBody!: HTMLPreElement;
  private logPreviewCloseBtn!: HTMLButtonElement;

  /** v11 对话与未读徽标 */
  private launcherBadge!: HTMLSpanElement;
  private orbBadge!: HTMLSpanElement;
  private navTabs!: HTMLDivElement;
  private tabComposeBtn!: HTMLButtonElement;
  private tabHistoryBtn!: HTMLButtonElement;
  private tabHistoryBadge!: HTMLSpanElement;
  private activeTab: 'compose' | 'history' = 'compose';
  private unreadCount = 0;
  private summaryPollTimer: ReturnType<typeof setInterval> | null = null;

  /** 历史与对话视图 */
  private historyContainer!: HTMLDivElement;
  private historyListView!: HTMLDivElement;
  private dialogueView!: HTMLDivElement;
  private activeDialogueId: string | null = null;
  private dialoguePollTimer: ReturnType<typeof setInterval> | null = null;
  /** v12 我的反馈列表：当前页码与状态筛选。 */
  private historyPage = 1;
  private historyIssueStatus: IssueStatus | '' = '';
  /** 对话视图中已渲染到的最大消息 seq（增量追加用）。 */
  private dialogueRenderedSeq = 0;
  /** Bearer 附件转出的对象 URL（对话关闭/重建时统一回收）。 */
  private readonly attachmentUrls = new Set<string>();
  /** 回复草稿图片（v12 多图，与新建反馈同一模型）。 */
  private dialogueReplyImages: DraftImage[] = [];
  private dialogueSupported = false;
  private submittedFeedbackEpoch: number | null = null;
  private historyRequestSeq = 0;
  private dialogueRequestSeq = 0;
  private summaryRequestSeq = 0;
  private replySending = false;
  private readonly replyRequests = new Set<string>();
  private readonly replyErrors = new Map<string, string>();
  private replyControls: { id: string; textarea: HTMLTextAreaElement; sendBtn: HTMLButtonElement; addImgBtn: HTMLButtonElement; addLogBtn: HTMLButtonElement; filesPreview: HTMLDivElement; replyError: HTMLParagraphElement; updateFilesPreview: () => void } | null = null;
  private dialogueRequestInFlight = 0;
  private replyDraftEpoch = 0;
  private replyDraftId: string | null = null;
  private readonly replyDrafts = new Map<string, { text: string; images: DraftImage[]; logs: File[] }>();

  /** v12 能力：服务端声明的最大图片数；未确认时按多图乐观放行（登录后由会话校准）。 */
  private maxImages = MAX_IMAGES;
  /** 服务端是否已明确返回 capabilities（缺 images → 单图模式 + 升级提示）。 */
  private capabilitiesKnown = false;
  /** features 探测在途标记（避免重复请求）。 */
  private featuresProbing = false;
  /** 当前打开的图片编辑器句柄（同时最多一个）。 */
  private editorHandle: ImageEditorHandle | null = null;

  /** v12 诊断记录器：宿主可选注入；身份世代递增（服务/账号切换）时清空缓冲。 */
  private _diagnostics: FeedbackDiagnosticsRecorder | undefined;
  private _diagnosticsFetch: FetchLike | null = null;

  get diagnosticsRecorder(): FeedbackDiagnosticsRecorder | undefined {
    return this._diagnostics;
  }
  set diagnosticsRecorder(r: FeedbackDiagnosticsRecorder | undefined) {
    this._diagnostics = r;
    this._diagnosticsFetch = null; // 包装缓存按 recorder 失效
  }

  /** 组件内部请求使用的 fetch：注入记录器时经 wrapFetch 记录（白名单字段）。 */
  private get apiFetch(): FetchLike {
    const r = this._diagnostics;
    if (!r) return fetch.bind(globalThis);
    if (!this._diagnosticsFetch) {
      this._diagnosticsFetch = wrapFetch(r, (input, init) => fetch(input, init));
    }
    return this._diagnosticsFetch;
  }

  private _logProvider?: FeedbackLogProvider;
  private logsCollecting = false;
  private logTimeout: ReturnType<typeof setTimeout> | null = null;

  private phase: Phase = 'idle';
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollDelay = POLL_START_MS;
  private pollStartedAt = 0;
  private openState = false;
  private authRequired = false;
  /** 当前登录账号（登录响应提供；仅用于展示与额度归属）。 */
  private authUser: AuthUser | null = null;
  /** 最近一次取得的每日额度；resetAt 之后重新查询，不在本地擅自重置。 */
  private quota: Quota | null = null;
  private loginVisible = false;
  private loginBusy = false;
  private loginError = '';
  private visibilityHandler: (() => void) | null = null;
  /** 手动刷新服务端记录状态进行中（按钮禁用 + 防重入）。 */
  private refreshing = false;

  /**
   * T4：当前记录的「等待项」提示（等待配置 / 等待来源确认 / 等待人工归档）。
   * 非空表示记录已妥善保存、只是在等管理员操作——此时**不轮询**（等待不是处理中，
   * 无限轮询没有意义），改为提示 + 手动刷新；管理员处理后刷新即可看到结果。
   */
  private waitingNotice: string | null = null;

  /**
   * 登录操作序号（T1-A）：每次发起登录递增；面板关闭 / 取消登录 /
   * 组件卸载 / 服务身份变化都会递增使在途登录失效，并清除密码、
   * 登录忙碌状态与待自动提交标记。
   *
   * 登录回调返回后必须同时满足「序号未变 + 身份世代未变 + 组件仍连接」，
   * 才允许写入令牌、更新界面或自动提交；失败回调同样校验，
   * 防止旧登录的错误覆盖新登录。由于 close() 也会递增序号，
   * 「序号仍有效」等价于「面板自登录发起以来没有被关闭」。
   */
  private loginSeq = 0;

  /**
   * 额度查询序号（T1-B）：提交成功 / 收到额度错误 / 关闭 / 卸载 /
   * 退到后台 / 身份变化都会递增使在途查询失效；查询结果除校验身份、
   * 令牌外还要校验该序号，避免旧查询覆盖刚扣除后的次数。
   */
  private quotaSeq = 0;
  /** 额度查询定时器（resetAt 单次 或 额度用尽后每 30 秒）；同时最多一个。 */
  private quotaTimer: ReturnType<typeof setTimeout> | null = null;
  /** 额度查询进行中：同一时刻最多一个额度查询。 */
  private quotaInFlight = false;
  /** 最近一次额度刷新失败（网络等）：保留旧额度，30 秒后重试。 */
  private quotaRefreshFailed = false;
  /**
   * 「待立即刷新」标记（T1-B）：打开面板 / 回到前台的刷新被旧查询或登录
   * 忙碌挡下时登记，不得丢弃；旧查询结束后或忙碌结束后立即补发一次。
   * 多次登记合并为一次；关闭 / 卸载 / 退到后台 / 身份变化 / 401 时清除，
   * 重新打开按当前身份重新登记。
   */
  private quotaRefreshPending = false;

  /**
   * 服务身份世代（epoch）：`api-base` 或 `app-id` 变化时递增。
   * 每个异步操作在开始时捕获当前 epoch，恢复后先校验：
   * epoch 已变 → 该结果是旧服务 / 旧身份的，一律成为 no-op，
   * 绝不写入新身份的状态（提交响应、轮询记录、捕获会话、登录握手回调）。
   */
  private identityEpoch = 0;

  /** 灵感球拖拽状态 */
  private isDragging = false;
  private orbPointerId: number | null = null;
  /** pressed 退出的 140ms 过渡窗口计时器（见 .fb-orb.is-unpressing）。 */
  private orbUnpressTimer: ReturnType<typeof setTimeout> | null = null;
  private orbReleaseFrame: number | null = null;
  private orbReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private orbReleaseGeneration = 0;
  private isCapturing = false;
  /** 进行中的捕获会话控制器：cancelCapture / 卸载时 abort，使旧会话失效。 */
  private captureController: AbortController | null = null;
  /** 捕获会话序号：新会话 / 失效操作递增；异步步骤后校验，旧会话结果一律丢弃。 */
  private captureSeq = 0;
  /** 正在进行的捕获会话：普通呼出合并到该会话，不重复发起。 */
  private captureInFlight: Promise<void> | null = null;

  // ---------- T1 局部选区流程（拖球 → 松手 → 调整选区 → 确认） ----------

  /** 局部选区覆盖层与相关控件（在 buildDom 中构建，默认 hidden）。 */
  private regionOverlay!: HTMLDivElement;
  private regionBg!: HTMLImageElement;
  private regionFrame!: HTMLDivElement;
  private regionSizeEl!: HTMLSpanElement;
  private regionErrorEl!: HTMLParagraphElement;
  private regionUseBtn!: HTMLButtonElement;
  private regionAllBtn!: HTMLButtonElement;
  private regionCancelBtn!: HTMLButtonElement;

  /** 进行中的选区会话；null 表示覆盖层未打开。 */
  private regionSession: RegionSession | null = null;
  /** 覆盖层自己的键盘监听（面板关闭时 keydownHandler 未注册，Esc 必须由它处理）。 */
  private regionKeyHandler: ((ev: KeyboardEvent) => void) | null = null;

  /** T4：日志摘要区是否展开（默认只显示简短摘要）。 */
  private logsOpen = false;
  private logsToggleBtn!: HTMLButtonElement;
  private logsSummaryEl!: HTMLSpanElement;
  private logsBody!: HTMLDivElement;
  private recollectLogBtn!: HTMLButtonElement;

  /**
   * 未提交草稿：组件实例所有（断开重连保留字节并重建自己的预览 URL），
   * 仅存内存，刷新即弃，绝不用 localStorage；appId 变化时整体废弃，
   * 旧捕获/旧草稿不得写入新身份。
   */
  private readonly draft: DraftState = {
    text: '',
    images: [],
    logs: [],
    logsCollected: false,
    version: 0,
  };

  /** 当前提交快照（冻结）；失败且草稿未变时复用（同 key 同字节重试）。 */
  private submitSnapshot: SubmitSnapshot | null = null;
  /** 结果未知的原提交请求：草稿被修改时保留供人工核对，不静默覆盖。 */
  private unconfirmedRequest: { key: string; capturedAt: string | null; textSummary: string } | null = null;

  /** 日志采集异步操作序号，防止迟到结果写入已切换的身份或草稿。 */
  private logOpSeq = 0;

  private invalidateLogCollection(): void {
    this.logOpSeq++;
    this.logsCollecting = false;
    if (this.logTimeout !== null) {
      clearTimeout(this.logTimeout);
      this.logTimeout = null;
    }
  }

  /**
   * 自定义日志提供者（L1-Web）：
   * 自动采集环境日志或诊断信息。返回单个或多个日志文件对象。
   */
  get logProvider(): FeedbackLogProvider | undefined {
    return this._logProvider;
  }
  set logProvider(p: FeedbackLogProvider | undefined) {
    this._logProvider = p;
    if (p && this.openState && !this.draft.logsCollected && this.draft.logs.length === 0) {
      void this.collectLogs();
    }
  }

  /**
   * 自定义截图提供者（扩展契约，实施计划 2.1）：
   * 保留原参数与返回值；ctx 新增可选 signal / viewport / sensitiveRegionCount，
   * 结果新增可选 viewport / sameFrameMasking / maskedRegions（输出像素坐标）。
   * 页面无可见敏感区域时旧式回调（只返回 {blob,width,height}）保持兼容。
   * 替换提供者（含置空）会使进行中的旧捕获会话失效。
   */
  private _captureProvider?: CaptureProvider;
  get captureProvider(): CaptureProvider | undefined {
    return this._captureProvider;
  }
  set captureProvider(p: CaptureProvider | undefined) {
    if (p !== this._captureProvider) this.invalidateCaptureSession();
    this._captureProvider = p;
  }

  private _sessionStore?: FeedbackSessionStore;
  private _hostBridge?: FeedbackHostBridge;
  private hostSessionLoading = false;

  get hostBridge(): FeedbackHostBridge | undefined {
    return this._hostBridge;
  }
  set hostBridge(bridge: FeedbackHostBridge | undefined) {
    this._hostBridge = bridge;
    if (bridge?.sessionStore) {
      void this.loadHostSession();
    }
  }

  get sessionStore(): FeedbackSessionStore | undefined {
    return this._sessionStore ?? this._hostBridge?.sessionStore;
  }
  set sessionStore(store: FeedbackSessionStore | undefined) {
    this._sessionStore = store;
    if (store) {
      void this.loadHostSession();
    }
  }

  get isOpen(): boolean {
    return this.openState;
  }

  handleBackPressed(): boolean {
    if (this.editorHandle && this.editorHandle.open) {
      this.editorHandle.close();
      this.editorHandle = null;
      return true;
    }
    if (this.isOpen) {
      this.close();
      return true;
    }
    return false;
  }

  openExternal(url: string): void {
    if (this._hostBridge?.onOpenExternal) {
      try {
        this._hostBridge.onOpenExternal(url);
        return;
      } catch {
        // 回退
      }
    }
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  async saveAttachment(
    file: { name: string; mimeType: string; dataUrl?: string },
    blob?: Blob,
  ): Promise<void> {
    const event = new CustomEvent('feedback-save-attachment', {
      detail: file,
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    const dispatched = this.dispatchEvent(event);
    let bridgeHandled = false;
    if (this._hostBridge?.onSaveAttachment) {
      bridgeHandled = true;
      try {
        await this._hostBridge.onSaveAttachment(file);
      } catch {
        // 宿主回调异常不影响组件
      }
    }
    if (!bridgeHandled && dispatched && !event.defaultPrevented && typeof document !== 'undefined') {
      const url = blob ? URL.createObjectURL(blob) : file.dataUrl;
      if (url) {
        if (blob) this.attachmentUrls.add(url);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    }
  }

  private async loadHostSession(): Promise<void> {
    if (this.hostSessionLoading) return;
    const store = this.sessionStore;
    if (!store) return;
    this.hostSessionLoading = true;
    try {
      const session = await store.loadSession();
      if (!session || this.sessionStore !== store) return;
      const token = typeof session.accessToken === 'string' ? session.accessToken.trim() : '';
      const raw = session.expiresAt;
      const exp = typeof raw === 'number' ? raw : Date.parse(typeof raw === 'string' ? raw : '');
      if (token && Number.isFinite(exp)) {
        if (exp > Date.now()) {
          this.adoptSession({ accessToken: token, expiresAt: raw });
        } else {
          void Promise.resolve(store.clearSession()).catch(() => {});
        }
      }
    } catch {
      // 宿主存储异常不阻断组件
    } finally {
      this.hostSessionLoading = false;
    }
  }

  private clearHostSession(): void {
    const store = this.sessionStore;
    if (store) {
      try {
        void Promise.resolve(store.clearSession()).catch(() => {});
      } catch {
        // ignore
      }
    }
  }

  /**
   * T6：本机选择的自定义服务器覆盖（已规范化地址）；null 表示使用宿主 api-base。
   * 覆盖偏好按 localStorage 源 + appId + 规范化默认地址逐槽位隔离，
   * 仅在构造/身份属性变化时加载，不反写宿主配置。
   */
  private serverOverride: string | null = null;
  /** T6：本机偏好是否可写（读取或写入失败置 false，设置视图据此提示「仅本次生效」）。 */
  private serverPrefWritable = true;
  /** T6：最近一次加载覆盖所用的偏好键——断开重连 / 重复调用不重复读取，避免吞掉「仅本次生效」的会话内选择。 */
  private serverOverrideKeyLoaded = '';
  /** T6：设置视图是否展开（未登录也可进入）。 */
  private settingsOpen = false;
  /** T6：设置视图内的「确认切换」块是否展开（有草稿或结果未确认提交时先确认）。 */
  private settingsConfirmOpen = false;
  /** T6：等待确认的目标覆盖（null=恢复默认，undefined=无待确认切换）。 */
  private pendingServerTarget: string | null | undefined = undefined;

  /** 令牌仅存组件实例内存；页面刷新后靠重新握手恢复。 */
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  private idempotencyKey: string | null = null;
  private lastFeedbackId: string | null = null;
  private lastSubmittedText = '';
  private lastErrorSummary: string | null = null;
  private lastRecord: FeedbackRecord | null = null;

  private keydownHandler: ((ev: KeyboardEvent) => void) | null = null;
  private handledKey: KeyboardEvent | null = null;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: FeedbackWidget.shadowMode });
    this.buildDom();
    this.bindEvents();
    this.syncUi();
  }

  // ---------- 公开 API ----------

  get apiBase(): string | null {
    return this.getAttribute('api-base');
  }
  set apiBase(v: string | null) {
    this.reflect('api-base', v);
  }

  /**
   * T6：当前实际使用的服务器地址（只读）：
   * 本机覆盖优先于宿主 `api-base`；未设置覆盖时返回宿主默认值。
   */
  get effectiveApiBase(): string | null {
    return this.serverOverride ?? this.apiBase;
  }

  get appId(): string | null {
    return this.getAttribute('app-id');
  }
  set appId(v: string | null) {
    this.reflect('app-id', v);
  }

  /**
   * 可选的软件名称（随提交上报）。
   * 服务端只在**管理员尚未设置名称**时采用；管理员设置过就绝不会被覆盖。
   */
  get appName(): string | null {
    return this.getAttribute('app-name');
  }
  set appName(v: string | null) {
    this.reflect('app-name', v);
  }

  get appVersion(): string | null {
    return this.getAttribute('app-version');
  }
  set appVersion(v: string | null) {
    this.reflect('app-version', v);
    this.updateMetaInfo();
  }

  get pageLabel(): string | null {
    return this.getAttribute('page-label');
  }
  set pageLabel(v: string | null) {
    this.reflect('page-label', v);
    this.updateMetaInfo();
  }

  get side(): 'left' | 'right' {
    return this.getAttribute('side') === 'left' ? 'left' : 'right';
  }
  set side(v: 'left' | 'right') {
    this.reflect('side', v === 'left' ? 'left' : 'right');
  }

  get theme(): 'system' | 'light' | 'dark' {
    const val = this.getAttribute('theme');
    if (val === 'light' || val === 'dark') return val;
    return 'system';
  }
  set theme(v: 'system' | 'light' | 'dark') {
    if (v === 'system') this.removeAttribute('theme');
    else this.setAttribute('theme', v);
  }

  get showLauncher(): boolean {
    return this.getAttribute('show-launcher') !== 'false';
  }
  set showLauncher(v: boolean) {
    if (v) this.removeAttribute('show-launcher');
    else this.setAttribute('show-launcher', 'false');
  }

  get launcherBottom(): string {
    return this.getAttribute('launcher-bottom') ?? '25%';
  }
  set launcherBottom(v: string | null) {
    this.reflect('launcher-bottom', v);
  }

  get launcherMode(): 'tab' | 'orb' {
    return this.getAttribute('launcher-mode') === 'orb' ? 'orb' : 'tab';
  }
  set launcherMode(v: 'tab' | 'orb') {
    if (v === 'tab') this.removeAttribute('launcher-mode');
    else this.setAttribute('launcher-mode', 'orb');
  }

  get captureMode(): 'off' | 'viewport' {
    return this.getAttribute('capture-mode') === 'viewport' ? 'viewport' : 'off';
  }
  set captureMode(v: 'off' | 'viewport') {
    if (v === 'off') this.removeAttribute('capture-mode');
    else this.setAttribute('capture-mode', 'viewport');
  }

  private reflect(name: string, value: string | null): void {
    if (value === null || value === '') this.removeAttribute(name);
    else this.setAttribute(name, value);
  }

  open(): void {
    if (this.openState) return;
    this.clearOrbRelease(true);
    this.openState = true;
    this.launcher.classList.add('is-hidden');
    this.launcher.setAttribute('aria-expanded', 'true');
    this.orb.classList.add('is-hidden');
    this.orb.setAttribute('aria-expanded', 'true');
    this.panel.classList.add('is-open');
    this.panel.hidden = false;

    const openDetail: { page?: string } = {};
    if (this.pageLabel) openDetail.page = this.pageLabel;
    this.dispatchEvent(
      new CustomEvent('feedback-panel-open', {
        detail: openDetail,
        bubbles: true,
        composed: true,
      }),
    );
    try {
      this._hostBridge?.onPanelOpen?.(openDetail);
    } catch {
      /* 宿主回调异常不影响面板 */
    }

    // 移动端设模态锁，桌面端不设
    this.updateAriaModal();

    // 打开时焦点移到 textarea（草稿已恢复）
    this.textarea.focus();

    // 打开面板即刷新额度（已登录时）；跨 resetAt 后由服务端给出新额度。
    void this.refreshQuota();
    // v12：能力校准随会话/登录响应到达（applyCapabilities）；能力未确认且
    // 需要判断时（提交多图）才探测 GET /api/features——打开面板不主动发请求。

    if (this.activeTab === 'history') {
      if (this.activeDialogueId) {
        this.startDialoguePolling();
        void this.loadDialogue(this.activeDialogueId);
      } else {
        this.startSummaryPolling();
        void this.loadHistoryList();
      }
    } else {
      if (this.tokenValid() && this.phase !== 'submitting' && this.phase !== 'tracking') {
        this.startSummaryPolling();
      }
    }

    // 打开面板时若配置了 logProvider 且尚未采集过日志，则自动采集
    if (this._logProvider && !this.draft.logsCollected && this.draft.logs.length === 0) {
      void this.collectLogs();
    }

    // 键盘监听：Esc 与 Tab
    this.keydownHandler = (ev: KeyboardEvent) => this.onKeydown(ev);
    document.addEventListener('keydown', this.keydownHandler, true);

    if (this.phase === 'tracking') {
      // T4：等待管理员处理的记录不做轮询循环，重新打开时只做一次只读刷新。
      if (this.waitingNotice !== null) void this.refreshLastRecord();
      else void this.resumePolling();
    }
  }

  close(): void {
    this.stopDialoguePolling();
    // 关闭面板：使尚未完成的登录接续与额度查询失效（已建立的登录态、
    // 草稿与截图不受影响），并取消额度定时查询；同时清除补发意图，
    // 重新打开时按当前状态重新登记（T1-B）。设置视图一并收起。
    this.settingsOpen = false;
    this.settingsConfirmOpen = false;
    this.pendingServerTarget = undefined;
    this.invalidateLogin();
    this.invalidateQuotaRefresh();
    this.quotaRefreshPending = false;
    this.invalidateLogCollection();
    // 即使面板尚未打开（先截图后开面板阶段），关闭也必须取消进行中的截图
    this.invalidateCaptureSession();
    this.captureInFlight = null;
    this.restoreCaptureUi();

    if (!this.openState) return;
    this.openState = false;
    this.closeZoomModal();
    this.closeLogPreview();
    // 编辑器随面板关闭（不改动草稿字节；取消语义）
    this.editorHandle?.close();
    this.editorHandle = null;
    this.panel.classList.remove('is-open');
    window.setTimeout(() => {
      if (!this.openState) this.panel.hidden = true;
    }, 200);

    this.dispatchEvent(
      new CustomEvent('feedback-panel-close', {
        bubbles: true,
        composed: true,
      }),
    );
    try {
      this._hostBridge?.onPanelClose?.();
    } catch {
      /* 宿主回调异常不影响面板 */
    }

    this.launcher.classList.remove('is-hidden');
    this.launcher.setAttribute('aria-expanded', 'false');
    this.orb.classList.remove('is-hidden');
    this.orb.setAttribute('aria-expanded', 'false');

    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler, true);
      this.keydownHandler = null;
    }

    // 关闭后焦点恢复到呼出入口
    if (this.launcherMode === 'orb') {
      this.orb.focus();
    } else {
      this.launcher.focus();
    }
  }

  cancelCapture(): void {
    // 顺序：先失效捕获序号 → 再取消（abort）→ 释放 Pointer Capture → 恢复 UI
    this.invalidateCaptureSession();
    this.captureInFlight = null;
    if (this.orbPointerId !== null) {
      try {
        this.orb.releasePointerCapture(this.orbPointerId);
      } catch {
        /* 指针捕获可能已自动释放 */
      }
    }
    const wasPressed = this.resetOrbGestureVisuals();
    if (wasPressed) this.beginOrbUnpress();
    this.orbPointerId = null;
    this.restoreCaptureUi();
  }

  /**
   * 使当前捕获会话失效：序号先行失效 → abort 取消；失效方负责恢复 UI
   * 与清理 in-flight（旧会话的 finally 不会再恢复新会话的 UI）。
   */
  private invalidateCaptureSession(): void {
    this.captureSeq++;
    this.captureController?.abort();
    this.captureController = null;
    this.captureInFlight = null;
    this.clearOrbRelease(true);
    this.restoreCaptureUi();
  }

  /** 恢复被捕获流程隐藏的组件 UI（会话失效方负责恢复）。 */
  private restoreCaptureUi(): void {
    this.panel.style.visibility = '';
    this.launcher.style.visibility = '';
    this.orb.style.visibility = '';
    this.isCapturing = false;
    // 会话失效 / 关闭 / 身份切换时，进行中的局部选区流程一并作废（丢弃冻结画面）
    this.dismissRegionFlow();
    // 会话结束（成功 / 失败 / 失效）后按钮必须回到真实可用性：
    // 首次失败保留手动重试入口，重拍失败保留旧图与文字。
    this.syncShotUi();
  }

  /** prefers-reduced-motion：灵感球取消光晕流动与缩放。 */
  private prefersReducedMotion(): boolean {
    try {
      return (
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      );
    } catch {
      return false;
    }
  }

  /**
   * 灵感球拖拽松手 → 局部选区流程（T1）：
   * - 图片已达上限且无可替换截图：先提示整理附件，**不发起捕获**；
   * - 已有捕获会话在途：合并到该会话，不重复发起；
   * - 捕获失败沿用现有失败提示（草稿与旧图保留，绝不静默回退成整屏截图）。
   */
  private async startRegionCapture(opts: {
    releasePoint: { x: number; y: number };
  }): Promise<void> {
    if (this.captureInFlight) return this.captureInFlight;
    if (this.phase === 'submitting' || this.polling) return;
    if (this.regionSession) return; // 覆盖层已打开：不重复发起
    if (!this.captureImage() && this.draft.images.length >= this.maxImages) {
      // 上限提示必须可见：面板尚未打开时先打开，再给出整理附件的指引。
      if (!this.openState) this.open();
      this.showImageError(`已达图片上限 ${this.maxImages} 张，请先删除一张图片再截图。`);
      this.renderStatus(`图片已达上限 ${this.maxImages} 张，先整理附件后再局部截图。`);
      this.syncUi();
      return;
    }
    const p = this.runCapture({ releasePoint: opts.releasePoint, regionFlow: true });
    this.captureInFlight = p;
    try {
      await p;
    } finally {
      if (this.captureInFlight === p) this.captureInFlight = null;
    }
  }

  /** 草稿是否已有内容（有文字、图片或日志的草稿再次呼出时恢复草稿、不重拍）。 */
  private isDraftDirty(): boolean {
    return (
      this.draft.text.trim().length > 0 ||
      this.draft.images.length > 0 ||
      this.draft.logs.length > 0
    );
  }

  /** 草稿中由截图产生的图片（重拍 / 移除截图的目标；编辑过的截图仍算）。 */
  private captureImage(): DraftImage | null {
    return this.draft.images.find((i) => i.origin === 'capture') ?? null;
  }

  /** 组件自身 UI 不参与截图，也不计入宿主页面敏感区域。 */
  private isOwnFeedbackUi(el: Element): boolean {
    if (el === this || el.closest('feedback-widget') !== null) return true;
    let node: Node | null = el;
    while (node) {
      const root = node.getRootNode();
      if (root instanceof ShadowRoot) {
        if (root.host === this || root.host.tagName.toLowerCase() === 'feedback-widget') return true;
        node = root.host;
      } else {
        break;
      }
    }
    return false;
  }

  /**
   * 普通呼出（launcher / orb 点击 / 拖拽落点）：
   * - 已有草稿（文字或截图）→ 恢复草稿打开面板，不重拍；
   * - 正在捕获 → 合并到进行中的会话，不重复发起；
   * - 提交进行中 → 禁止编辑类操作，直接忽略。
   */
  async captureAndOpen(opts: { releasePoint?: { x: number; y: number } } = {}): Promise<void> {
    if (this.captureInFlight) return this.captureInFlight;
    if (this.phase === 'submitting') return;
    if (this.isDraftDirty()) {
      if (!this.openState) this.open();
      this.syncUi();
      return;
    }
    const p = this.runCapture(opts);
    this.captureInFlight = p;
    try {
      await p;
    } finally {
      if (this.captureInFlight === p) this.captureInFlight = null;
    }
  }

  /**
   * 重拍（内部明确入口）：可取消旧会话后重新捕获；只有重拍替换旧截图，
   * 且失败不丢旧图（runCapture 失败路径不触碰草稿）。
   */
  async retakeScreenshot(): Promise<void> {
    if (this.phase === 'submitting') return;
    this.invalidateCaptureSession();
    this.captureInFlight = null;
    const p = this.runCapture({});
    this.captureInFlight = p;
    try {
      await p;
    } finally {
      if (this.captureInFlight === p) this.captureInFlight = null;
    }
  }

  /**
   * 面板内的手动截图入口（首次截图与重拍共用同一条路径）。
   *
   * 刻意**不**走 `captureAndOpen()`：那条路径是「呼出」语义——草稿一旦有内容
   * （哪怕只有文字）就只恢复草稿开面板、绝不重拍，于是默认 `capture-mode="off"`
   * 的宿主在用户先输入文字后，就再没有任何补拍入口（本次修复的缺口）。
   * 这里复用显式重拍流程：可替换旧图，失败不丢旧图与文字。
   *
   * 按钮在捕获期间已禁用；这里再挡一次重入（禁用态只是视觉 / a11y 保证，
   * 程序化调用与键盘连击不该产生并发会话）。
   */
  private captureFromPanel(): void {
    if (this.phase === 'submitting' || this.polling || this.isCapturing) return;
    const prevFocus = this.root.activeElement as HTMLElement | null;
    void this.retakeScreenshot().finally(() => this.restorePanelFocus(prevFocus));
  }

  /**
   * 捕获期间面板被 `visibility: hidden` 隐藏，真实浏览器会把焦点丢到 body
   * （面板内的按钮 / textarea 全部失焦）。两种情况要把焦点还回去：
   * 焦点已经不在面板内（`null`），或**卡在一个已经隐藏的控件上**
   * （个别引擎不主动移除隐藏元素的焦点）。优先点击前的元素（若它已隐藏 /
   * 禁用则回到 textarea），键盘用户不会在截图后凭空失去落点；
   * 用户已主动聚焦到可见的别处时绝不抢焦点。
   */
  private restorePanelFocus(prev: HTMLElement | null): void {
    if (!this.openState) return;
    const active = this.root.activeElement as HTMLElement | null;
    const stuckOnHidden = active !== null && (active.hidden || active.closest('[hidden]') !== null);
    if (active !== null && !stuckOnHidden) return;
    const usable =
      prev !== null && prev.isConnected && !prev.hidden && !(prev as HTMLButtonElement).disabled;
    (usable && prev ? prev : this.textarea).focus();
  }

  /**
   * 图片区同步（v12 多图）：**预览网格与操作分离**。
   * - 网格只在真的有可渲染对象 URL 时出现：绝不留下空 src 的破图占位
   *   （历史故障与其成因见 styles.ts 的 `[hidden]` 兜底注释）。
   * - 首个单元格是稳定 DOM（legacy .fb-screenshot-thumb-box/.fb-screenshot-thumb），
   *   其余单元格按 images[1..] 重建；每张图可放大、编辑、删除。
   * - 无截图 → 只显示「截取当前页面」；有截图 → 「重新截图 / 移除截图」；
   *   「添加图片」在未满上限（capabilities.images 或 5）时可用；服务端
   *   明确不支持多图时提示「升级服务端以支持多图」。
   * - 提交、轮询与捕获会话进行中，所有图片操作一律禁用（防重入）。
   */
  private syncShotUi(): void {
    if (!this.shotArea) return;
    const images = this.draft.images;
    const capture = this.captureImage();
    const hasCapture = capture !== null;
    const locked = this.phase === 'submitting' || this.polling || this.isCapturing;
    const atLimit = images.length >= this.maxImages;

    // ---- 网格 ----
    this.screenshotWrap.hidden = images.length === 0;
    // 首个单元格（稳定 DOM）：有图则显示第一张
    const first = images[0] ?? null;
    this.screenshotThumbBox.hidden = first === null;
    if (first) {
      this.screenshotThumb.src = first.url;
      this.screenshotThumb.alt = `图片 1：${first.filename}`;
      const badge = this.screenshotThumbBox.querySelector('.fb-screenshot-badge');
      if (badge) badge.textContent = this.imageBadgeText(first);
      const sizeEl = this.screenshotThumbBox.querySelector('.fb-screenshot-size');
      if (sizeEl) sizeEl.textContent = this.imageSizeText(first);
      const del = this.screenshotThumbBox.querySelector<HTMLButtonElement>('.fb-thumb-remove');
      if (del) {
        del.disabled = locked;
        del.setAttribute('aria-label', '删除图片 1');
      }
      const edit = this.screenshotThumbBox.querySelector<HTMLButtonElement>('.fb-thumb-edit');
      if (edit) {
        edit.disabled = locked;
        edit.setAttribute('aria-label', '编辑图片 1');
      }
    } else {
      // 无图时连 src 一起撤掉：移除 / 清空草稿会 revoke 旧对象 URL，
      // 留着它就是一条「有 src 却加载失败」的破图记录（历史故障形态）。
      this.screenshotThumb.removeAttribute('src');
    }
    // 无图时缩略图必须离开 tab 序列：`[hidden]` 只是 display:none，
    // 仍会被焦点锁选中，把焦点交给不可见元素（表现为焦点凭空消失）。
    this.screenshotThumbBox.tabIndex = first === null ? -1 : 0;

    // 其余单元格重建（数量小，≤4）
    for (const cell of Array.from(this.screenshotWrap.querySelectorAll('.fb-image-cell'))) {
      cell.remove();
    }
    for (let i = 1; i < images.length; i++) {
      this.screenshotWrap.append(this.buildImageCell(images[i]!, i, locked));
    }

    // ---- 操作区 ----
    this.captureBtn.hidden = hasCapture || atLimit;
    this.retakeBtn.hidden = !hasCapture;
    this.removeBtn.hidden = !hasCapture;
    this.addImageBtn.hidden = atLimit;

    this.captureBtn.disabled = locked;
    this.retakeBtn.disabled = locked;
    this.removeBtn.disabled = locked;
    this.addImageBtn.disabled = locked;

    // ---- 提示 ----
    const hints: string[] = [];
    if (images.some((i) => i.hasUndrawable)) {
      hints.push('部分内容可能未入图（跨源嵌入内容无法被截取），可手动添加图片补充。');
    }
    if (images.some((i) => i.oversize)) {
      hints.push('有图片缩小后仍超过 5MiB，提交可能被服务端拒绝。');
    }
    if (this.capabilitiesKnown && this.maxImages < MAX_IMAGES) {
      hints.push('当前服务端仅支持单张图片，升级服务端以支持多图。');
    }
    this.shotHintEl.textContent = hints.join(' ');
    this.shotHintEl.hidden = hints.length === 0;

    // 加载态：捕获期间面板整体 `visibility: hidden`，因此这里的文案与 aria-busy
    // 不可能被拍进截图；它保证会话结束后与辅助技术读到的是真实状态。
    this.captureBtn.textContent = this.isCapturing ? CAPTURE_BUSY_LABEL : CAPTURE_ACTION_LABEL;
    if (this.isCapturing) this.captureBtn.setAttribute('aria-busy', 'true');
    else this.captureBtn.removeAttribute('aria-busy');
    this.shotArea.classList.toggle('is-capturing', this.isCapturing);
  }

  /**
   * 图片角标文案（T2.5）：局部截图（带 region）/ 截图 / 图片 + 编辑标记。
   * 编辑过的图仍带「已编辑」；带 region 的截图标「局部截图」。
   */
  private imageBadgeText(img: DraftImage): string {
    const base =
      img.origin === 'capture' ? (img.captureInfo?.region ? '局部截图' : '截图') : '图片';
    if (img.source !== 'edited') return base;
    return img.origin === 'capture' ? `${base}·已编辑` : '已编辑';
  }

  /** 图片尺寸读数（输出像素，宽×高）。 */
  private imageSizeText(img: DraftImage): string {
    return `${img.width}×${img.height}`;
  }

  /** 构建第 index 张图片的网格单元格（index≥1 的次要单元格，重建型）。 */
  private buildImageCell(img: DraftImage, index: number, locked: boolean): HTMLDivElement {
    const cell = el('div', 'fb-image-cell fb-screenshot-thumb-box');
    cell.setAttribute('role', 'button');
    cell.setAttribute('tabindex', '0');
    cell.setAttribute('aria-label', `查看图片 ${index + 1}`);

    const frame = el('div', 'fb-thumb-frame');
    const thumb = el('img', 'fb-screenshot-thumb');
    thumb.src = img.url;
    thumb.alt = `图片 ${index + 1}：${img.filename}`;

    const badge = el('span', 'fb-screenshot-badge', this.imageBadgeText(img));
    const sizeLabel = el('span', 'fb-screenshot-size', this.imageSizeText(img));
    const zoomHint = el('span', 'fb-screenshot-zoom-hint', '点击放大');
    frame.append(thumb, badge, sizeLabel, zoomHint);

    const cellActions = el('div', 'fb-thumb-actions');
    const editBtn = el('button', 'fb-thumb-edit', '编辑');
    editBtn.type = 'button';
    editBtn.disabled = locked;
    editBtn.setAttribute('aria-label', `编辑图片 ${index + 1}`);
    editBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void this.openEditorForImage(img.id);
    });
    const delBtn = el('button', 'fb-thumb-remove', '删除');
    delBtn.type = 'button';
    delBtn.disabled = locked;
    delBtn.setAttribute('aria-label', `删除图片 ${index + 1}`);
    delBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.removeImage(img.id);
    });
    cellActions.append(editBtn, delBtn);

    cell.append(frame, cellActions);
    cell.addEventListener('click', () => this.openZoomModal(img.url));
    cell.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key === ' ' || ev.key === 'Enter') {
        ev.preventDefault();
        this.openZoomModal(img.url);
      }
    });
    return cell;
  }

  /** 图片错误提示（shotErrorEl）。 */
  private showImageError(text: string): void {
    this.shotErrorEl.textContent = text;
    this.shotErrorEl.hidden = text === '';
  }

  /**
   * 把文件加入草稿图片列表（选择 / 拖入 / 粘贴共用）。
   * 校验 → 解码 → 需要时等比缩小；全部失败给出可读错误，部分成功保留成功的。
   * 数量超过 maxImages（capabilities 或 5）时丢弃超出的并提示。
   */
  private async addImageFiles(files: File[] | Blob[], sourceName = 'image'): Promise<void> {
    if (this.phase === 'submitting' || this.polling) return;
    const epoch = this.identityEpoch;
    this.showImageError('');
    const list = Array.from(files).filter((f) => f && f.size !== undefined);
    if (list.length === 0) return;

    for (const file of list) {
      if (epoch !== this.identityEpoch) return;
      if (this.draft.images.length >= this.maxImages) {
        this.showImageError(`最多附加 ${this.maxImages} 张图片`);
        break;
      }
      const name = file instanceof File ? file.name : '';
      try {
        const prepared = await prepareImageForUpload(file);
        if (epoch !== this.identityEpoch) return;
        this.pushDraftImage(prepared, 'manual', normalizeImageFilename(name, prepared.mime, `${sourceName}-${this.draft.images.length + 1}${prepared.mime === 'image/png' ? '.png' : prepared.mime === 'image/jpeg' ? '.jpg' : '.webp'}`));
      } catch (err) {
        if (epoch !== this.identityEpoch) return;
        const label = name || '所选图片';
        if (err instanceof ImageInputError) {
          if (err.reason === 'invalid_type') {
            this.showImageError(`${label}：仅支持 PNG / JPEG / WebP 静态图片`);
          } else if (err.reason === 'empty') {
            this.showImageError(`${label}：不能为空文件`);
          } else {
            this.showImageError(`${label}：图片无法读取`);
          }
        } else {
          this.showImageError(`${label}：图片无法读取`);
        }
      }
    }
    this.syncUi();
  }

  /** 新增一张草稿图片（manual 来源；截图走 capture 路径）。 */
  private pushDraftImage(prepared: PreparedImage, source: 'manual' | 'edited', filename: string): DraftImage {
    const img: DraftImage = {
      id: uuid(),
      blob: prepared.blob,
      url: URL.createObjectURL(prepared.blob),
      source,
      origin: 'manual',
      filename,
      mime: prepared.mime,
      width: prepared.width,
      height: prepared.height,
      oversize: prepared.oversize,
    };
    this.draft.images.push(img);
    this.draft.version++;
    return img;
  }

  /** 按 ID 删除一张草稿图片（释放对象 URL）。 */
  private removeImage(id: string): void {
    if (this.phase === 'submitting' || this.polling) return;
    const idx = this.draft.images.findIndex((i) => i.id === id);
    if (idx === -1) return;
    const [img] = this.draft.images.splice(idx, 1);
    if (img?.url) URL.revokeObjectURL(img.url);
    this.draft.version++;
    this.syncUi();
  }

  /**
   * 打开全屏编辑器编辑指定图片：保存结果经统一限额收缩后**原位替换**
   * （同 ID、不占新名额），来源标记为 'edited'；取消不改动草稿。
   */
  private async openEditorForImage(id: string): Promise<void> {
    if (this.phase === 'submitting' || this.polling || this.editorHandle) return;
    const img = this.draft.images.find((i) => i.id === id);
    if (!img) return;
    const epoch = this.identityEpoch;
    try {
      const decoded = await decodeImage(img.blob);
      if (epoch !== this.identityEpoch) return;
      const target = img;
      this.editorHandle = openImageEditor({
        image: decoded.source,
        width: decoded.width,
        height: decoded.height,
        mount: this.root,
        onCancel: () => {
          this.editorHandle = null;
          decoded.close?.();
        },
        onSave: async (canvas) => {
          const prepared = await exportEditedImage(canvas);
          if (epoch !== this.identityEpoch || !mounted(this, target)) return;
          if (!prepared) {
            this.showImageError('图片编辑结果无法导出');
            return;
          }
          URL.revokeObjectURL(target.url);
          target.blob = prepared.blob;
          target.url = URL.createObjectURL(prepared.blob);
          target.source = 'edited';
          target.mime = prepared.mime;
          target.width = prepared.width;
          target.height = prepared.height;
          target.oversize = prepared.oversize;
          target.filename = normalizeImageFilename(target.filename, prepared.mime, `edited-${target.id}.png`);
          this.draft.version++;
          this.editorHandle?.close();
          this.editorHandle = null;
          decoded.close?.();
          this.syncUi();
        },
      });
      this.syncUi();
    } catch {
      if (epoch === this.identityEpoch) this.showImageError('图片无法打开进行编辑');
    }
    function mounted(w: FeedbackWidget, t: DraftImage): boolean {
      return w.isConnected && w.draft.images.includes(t);
    }
  }

  /**
   * 单次捕获会话主体：每个异步步骤后与更新草稿 / 开面板前都校验会话有效性。
   *
   * `regionFlow=true`（灵感球拖拽）时，捕获成功**不写草稿**：位图被冻结并交给
   * 局部选区覆盖层，用户确认（使用此区域 / 截取整个窗口）后才裁剪并 commit，
   * 取消则整体丢弃；失败路径与直接路径完全一致（提示失败、保留草稿与旧图）。
   */
  private async runCapture(opts: {
    releasePoint?: { x: number; y: number };
    regionFlow?: boolean;
  }): Promise<void> {
    const seq = ++this.captureSeq;
    const epoch = this.identityEpoch;
    // 会话有效 = 序号未变 且 服务身份未切换：旧服务 / 旧身份的截图不得写入新身份
    const active = (): boolean => seq === this.captureSeq && epoch === this.identityEpoch;
    const controller = new AbortController();
    this.captureController = controller;
    const { signal } = controller;
    // 加载 / 禁用态必须在隐藏面板之前落到 DOM（同一 tick，不存在中间帧）：
    // 「截取中…」与 aria-busy 因此永远不可能出现在截图里（面板随后整体不可见）。
    this.isCapturing = true;
    this.syncShotUi();

    const wasOpen = this.openState;
    this.clearOrbRelease(true);
    this.panel.style.visibility = 'hidden';
    this.launcher.style.visibility = 'hidden';
    this.orb.style.visibility = 'hidden';

    let captureFailure: string | null = null;
    let frozen: FrozenCapture | null = null;

    try {
      if (signal.aborted || !active()) throw new CaptureError('aborted', '截图会话已失效');

      if (typeof window === 'undefined') throw new CaptureError('locate-failed', '无可用 window 环境');
      const viewport = logicalViewport(window);

      // 有效且仍可见的敏感区域（坐标非有限会抛错，不允许静默跳过）
      const sensitiveRegionCount = countVisibleSensitiveRegions(document, {
        ignore: (el) => this.isOwnFeedbackUi(el),
      });
      // T1（v12）：检测可能无法进入位图的内容（跨源 iframe / 无 CORS 的跨源图像），
      // 命中时在预览旁提示「部分内容可能未入图」并允许手动加图补充。
      const undrawableCount = countUndrawableContent(document, (el) => this.isOwnFeedbackUi(el));

      let blob: Blob;
      let viewportWidth: number;
      let viewportHeight: number;
      let pixelWidth: number;
      let pixelHeight: number;

      if (this._captureProvider) {
        const res = await this._captureProvider({
          releasePoint: opts.releasePoint,
          signal,
          viewport,
          sensitiveRegionCount,
        });
        if (signal.aborted || !active()) throw new CaptureError('aborted', '截图会话已失效');
        // 组件统一校验 PNG、尺寸、文件大小与遮挡坐标；
        // 存在敏感区域而提供者无法保证同帧遮挡时拒绝使用该截图。
        const checked = validateProviderResult(res, sensitiveRegionCount);
        blob = checked.blob;
        viewportWidth = checked.viewportWidth;
        viewportHeight = checked.viewportHeight;
        pixelWidth = checked.outputWidth;
        pixelHeight = checked.outputHeight;
      } else {
        const result = await captureViewport({
          viewport,
          expectedSensitiveCount: sensitiveRegionCount,
          signal,
          ignore: (el) => el === this || el.tagName.toLowerCase() === 'feedback-widget',
        });
        if (signal.aborted || !active()) throw new CaptureError('aborted', '截图会话已失效');
        blob = result.blob;
        viewportWidth = result.viewportWidth;
        viewportHeight = result.viewportHeight;
        pixelWidth = result.outputWidth;
        pixelHeight = result.outputHeight;
      }

      // 更新草稿前最后一次会话校验：过期捕获不得写入草稿
      if (!active()) throw new CaptureError('aborted', '截图会话已失效');

      // 遮挡与编码全部完成后，才允许生成预览并写入草稿；
      // 失败路径不触碰 draft——旧草稿与旧图片原样保留。
      // 图片位满（已达上限且没有可替换的截图）时：截图丢弃但提示用户（不静默）。
      const existingCapture = this.captureImage();
      if (!existingCapture && this.draft.images.length >= this.maxImages) {
        // 图片位满：截图不写入草稿但明确提示（绝不静默丢弃）
        captureFailure = `已达图片上限 ${this.maxImages} 张，新截图未加入；可先删除一张图片再截图。`;
      } else {
        frozen = {
          blob,
          viewportWidth,
          viewportHeight,
          pixelWidth,
          pixelHeight,
          capturedAt: new Date().toISOString(),
          ...(opts.releasePoint ? { releasePoint: opts.releasePoint } : {}),
          undrawableCount,
        };
        // 直接路径立即写入草稿；局部选区路径留给覆盖层确认后再写。
        if (!opts.regionFlow) this.commitCapture(frozen);
      }
    } catch (e) {
      if (e instanceof CaptureError && e.reason === 'aborted') {
        // 会话被主动取消 / 失效：不报错、不改草稿
      } else {
        captureFailure = e instanceof CaptureError ? e.userMessage : CAPTURE_FAILURE_MESSAGE;
        console.warn('[Feedback] Screenshot capture failed:', e);
      }
    } finally {
      // 旧请求的 finally 不得恢复新请求的 UI：仅当前会话负责恢复
      if (active()) {
        if (this.captureController === controller) this.captureController = null;
        this.restoreCaptureUi();
      }
    }

    // 开面板前再次校验会话；被 close()/cancelCapture() 失效的会话不得开面板
    if (!active()) return;

    // T1 局部选区路径：捕获成功 → 打开覆盖层（不写草稿、不开面板，确认后才进入填写）。
    if (frozen && opts.regionFlow) {
      this.openRegionFlow(frozen);
      this.syncUi();
      return;
    }

    if (!wasOpen) {
      this.open();
    }
    this.syncUi();
    if (captureFailure) {
      this.renderStatus(captureFailure);
    }
  }

  /**
   * 把一次已通过校验的冻结捕获写入草稿（直接路径与选区确认路径共用）：
   * 重拍原位替换（同 ID、不占名额），首次则新增；`region` 仅在局部截图时写入
   * `captureInfo`，整窗截图省略该字段（与旧客户端一致）。
   */
  private commitCapture(f: FrozenCapture, region?: FeedbackCaptureRegion): void {
    const captureInfo: FeedbackCaptureInfo = {
      viewportWidth: f.viewportWidth,
      viewportHeight: f.viewportHeight,
      pixelWidth: f.pixelWidth,
      pixelHeight: f.pixelHeight,
      capturedAt: f.capturedAt,
      ...(f.releasePoint ? { releasePoint: f.releasePoint } : {}),
      ...(region ? { region } : {}),
    };
    const existingCapture = this.captureImage();
    if (existingCapture) {
      // 重拍：原位替换截图（同 ID），不占新名额
      URL.revokeObjectURL(existingCapture.url);
      existingCapture.blob = f.blob;
      existingCapture.url = URL.createObjectURL(f.blob);
      existingCapture.source = 'capture';
      existingCapture.mime = 'image/png';
      existingCapture.width = f.pixelWidth;
      existingCapture.height = f.pixelHeight;
      existingCapture.filename = 'screenshot.png';
      existingCapture.captureInfo = captureInfo;
      existingCapture.hasUndrawable = f.undrawableCount > 0;
      existingCapture.oversize = false;
      this.draft.version++;
      return;
    }
    this.draft.images.push({
      id: uuid(),
      blob: f.blob,
      url: URL.createObjectURL(f.blob),
      source: 'capture',
      origin: 'capture',
      filename: 'screenshot.png',
      mime: 'image/png',
      width: f.pixelWidth,
      height: f.pixelHeight,
      captureInfo,
      hasUndrawable: f.undrawableCount > 0,
    });
    this.draft.version++;
  }

  // ---------- T1 局部选区覆盖层（拖球 → 松手 → 调整选区 → 确认） ----------

  /** 打开覆盖层：冻结位图铺满显示，初始选区以松手位置为中心并整体移回可见区。 */
  private openRegionFlow(frozen: FrozenCapture): void {
    if (this.regionSession) this.dismissRegionFlow({ focusOrb: false });
    const viewport: RegionViewport = {
      width: Math.max(1, frozen.viewportWidth),
      height: Math.max(1, frozen.viewportHeight),
    };
    const overlay: RegionViewport = {
      width: Math.max(1, typeof window !== 'undefined' ? window.innerWidth || viewport.width : viewport.width),
      height: Math.max(1, typeof window !== 'undefined' ? window.innerHeight || viewport.height : viewport.height),
    };
    const release = frozen.releasePoint ?? { x: 0.5, y: 0.5 };
    const session: RegionSession = {
      epoch: this.identityEpoch,
      frozen,
      url: URL.createObjectURL(frozen.blob),
      viewport,
      overlay,
      sel: initialRegionSelection(release, viewport),
      dragging: null,
    };
    this.regionSession = session;
    this.regionBg.src = session.url;
    this.regionOverlay.hidden = false;
    this.regionErrorEl.hidden = true;
    this.regionErrorEl.textContent = '';
    // 面板未打开时组件自身的 keydownHandler 不在监听，覆盖层必须自己接管按键
    this.regionKeyHandler = (ev) => this.onRegionKeydown(ev);
    document.addEventListener('keydown', this.regionKeyHandler, true);
    this.renderRegion();
    this.regionFrame.focus();
  }

  /** 覆盖层显示尺寸 ↔ 捕获视口逻辑像素的换算（位图铺满覆盖层显示）。 */
  private regionScale(s: RegionSession): { kx: number; ky: number } {
    return {
      kx: s.overlay.width / s.viewport.width,
      ky: s.overlay.height / s.viewport.height,
    };
  }

  /** 指针事件 → 选区坐标系（捕获视口逻辑像素）。 */
  private regionPoint(s: RegionSession, ev: { clientX: number; clientY: number }): { x: number; y: number } {
    const { kx, ky } = this.regionScale(s);
    return { x: ev.clientX / kx, y: ev.clientY / ky };
  }

  /** 重绘选区框（位置 / 尺寸 / 输出尺寸读数）：覆盖层打开期间持续生效。 */
  private renderRegion(): void {
    const s = this.regionSession;
    if (!s) return;
    const { kx, ky } = this.regionScale(s);
    this.regionFrame.style.left = `${s.sel.x * kx}px`;
    this.regionFrame.style.top = `${s.sel.y * ky}px`;
    this.regionFrame.style.width = `${s.sel.width * kx}px`;
    this.regionFrame.style.height = `${s.sel.height * ky}px`;
    this.regionSizeEl.textContent = `选区 ${Math.round(s.sel.width)}×${Math.round(s.sel.height)} px`;
  }

  private onRegionPointerDown(ev: PointerEvent): void {
    const s = this.regionSession;
    if (!s || ev.button !== 0) return;
    const target = ev.target as HTMLElement | null;
    if (target && typeof target.closest === 'function' && target.closest('.fb-region-toolbar')) {
      return; // 工具栏按钮不进入框选
    }
    const pt = this.regionPoint(s, ev);
    const handleEl =
      target && typeof target.closest === 'function'
        ? (target.closest('[data-handle]') as HTMLElement | null)
        : null;
    const handle = handleEl?.getAttribute('data-handle') as RegionHandle | null;
    if (handle && REGION_HANDLES.includes(handle)) {
      s.dragging = { mode: 'resize', handle, startX: pt.x, startY: pt.y, startSel: { ...s.sel } };
    } else if (target && this.regionFrame.contains(target)) {
      s.dragging = { mode: 'move', startX: pt.x, startY: pt.y, startSel: { ...s.sel } };
    } else {
      s.dragging = { mode: 'new', startX: pt.x, startY: pt.y, startSel: { ...s.sel } };
      s.sel = regionFromDrag(pt, pt, s.viewport); // 重新框选：从落点起一个最小选区
    }
    try {
      this.regionOverlay.setPointerCapture(ev.pointerId);
    } catch {
      /* happy-dom / 旧浏览器无 pointer capture */
    }
    this.renderRegion();
    ev.preventDefault();
  }

  private onRegionPointerMove(ev: PointerEvent): void {
    const s = this.regionSession;
    if (!s || !s.dragging) return;
    const d = s.dragging;
    const pt = this.regionPoint(s, ev);
    if (d.mode === 'move') {
      s.sel = moveRegion(d.startSel, pt.x - d.startX, pt.y - d.startY, s.viewport);
    } else if (d.mode === 'resize') {
      s.sel = resizeRegion(d.startSel, d.handle, pt.x - d.startX, pt.y - d.startY, s.viewport);
    } else {
      s.sel = regionFromDrag({ x: d.startX, y: d.startY }, pt, s.viewport);
    }
    this.renderRegion();
  }

  private onRegionPointerEnd(ev: PointerEvent): void {
    const s = this.regionSession;
    if (!s || !s.dragging) return;
    s.dragging = null;
    try {
      this.regionOverlay.releasePointerCapture(ev.pointerId);
    } catch {
      /* 指针捕获可能已自动释放 */
    }
    this.renderRegion();
  }

  /**
   * 确认：`useSelection=true` 裁剪冻结位图到选区（region 随元数据透传），
   * false 使用整张冻结位图（region 省略，与旧客户端一致）。
   * 裁剪失败保持覆盖层打开并给出可重试提示，绝不静默回退成整屏截图。
   */
  private async confirmRegion(useSelection: boolean): Promise<void> {
    const s = this.regionSession;
    if (!s) return;
    if (s.epoch !== this.identityEpoch) {
      this.dismissRegionFlow();
      return;
    }
    let blob = s.frozen.blob;
    let pixelWidth = s.frozen.pixelWidth;
    let pixelHeight = s.frozen.pixelHeight;
    let region: FeedbackCaptureRegion | undefined;
    if (useSelection) {
      try {
        const cropped = await cropFrozenRegion(s.frozen.blob, s.sel, s.viewport);
        blob = cropped.blob;
        pixelWidth = cropped.width;
        pixelHeight = cropped.height;
        region = normalizeRegion(s.sel, s.viewport);
      } catch {
        if (this.regionSession !== s || s.epoch !== this.identityEpoch) return;
        this.regionErrorEl.textContent = '裁剪未完成，可重试，或改用「截取整个窗口」。';
        this.regionErrorEl.hidden = false;
        return;
      }
    }
    // 异步等待期间被取消 / 关闭 / 切换身份 → 一律丢弃，不写入新身份草稿
    if (this.regionSession !== s || s.epoch !== this.identityEpoch) return;
    const out: FrozenCapture = { ...s.frozen, blob, pixelWidth, pixelHeight };
    this.dismissRegionFlow({ focusOrb: false });
    this.commitCapture(out, region);
    if (!this.openState) this.open();
    this.syncUi();
    this.renderStatus(useSelection ? '已附加局部截图' : '已附加整窗截图');
  }

  /** 取消：丢弃冻结画面并恢复 UI，不覆盖原草稿、不报失败；焦点回到灵感球。 */
  private cancelRegion(): void {
    this.dismissRegionFlow();
  }

  /** 收起覆盖层（任何失效路径共用）：回收对象 URL、移除监听、还原焦点。 */
  private dismissRegionFlow(opts: { focusOrb?: boolean } = {}): void {
    const s = this.regionSession;
    if (!s) return;
    this.regionSession = null;
    if (this.regionKeyHandler) {
      document.removeEventListener('keydown', this.regionKeyHandler, true);
      this.regionKeyHandler = null;
    }
    this.regionOverlay.hidden = true;
    this.regionBg.removeAttribute('src');
    try {
      URL.revokeObjectURL(s.url);
    } catch {
      /* URL 回收失败不致命 */
    }
    this.regionErrorEl.hidden = true;
    this.regionErrorEl.textContent = '';
    if (opts.focusOrb !== false && this.isConnected) {
      try {
        this.orb.focus();
      } catch {
        /* 灵感球不可聚焦时忽略 */
      }
    }
  }

  /** 覆盖层键盘：Esc=取消、回车=使用此区域、方向键=移动、Shift+方向键=缩放、Tab 焦点锁。 */
  private onRegionKeydown(ev: KeyboardEvent): void {
    const s = this.regionSession;
    if (!s) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      this.cancelRegion();
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      void this.confirmRegion(true);
      return;
    }
    const dx = ev.key === 'ArrowLeft' ? -REGION_KEY_STEP : ev.key === 'ArrowRight' ? REGION_KEY_STEP : 0;
    const dy = ev.key === 'ArrowUp' ? -REGION_KEY_STEP : ev.key === 'ArrowDown' ? REGION_KEY_STEP : 0;
    if (dx !== 0 || dy !== 0) {
      const active = this.root.activeElement;
      // 焦点在工具栏按钮上时不劫持方向键（浏览器可能用它切换单选/滚动）
      if (active !== this.regionFrame && active !== this.regionOverlay) return;
      ev.preventDefault();
      if (ev.shiftKey) {
        const handle: RegionHandle =
          dx !== 0 ? (dx > 0 ? 'e' : 'w') : dy > 0 ? 's' : 'n';
        s.sel = resizeRegion(s.sel, handle, dx, dy, s.viewport);
      } else {
        s.sel = moveRegion(s.sel, dx, dy, s.viewport);
      }
      this.renderRegion();
      return;
    }
    if (ev.key === 'Tab') {
      // 模态焦点锁：Tab 只在覆盖层内循环
      const nodes = Array.from(
        this.regionOverlay.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]'),
      ).filter((n) => n.closest('[hidden]') === null);
      if (nodes.length === 0) return;
      const idx = nodes.indexOf(this.root.activeElement as HTMLElement);
      ev.preventDefault();
      if (ev.shiftKey) {
        const prev = idx <= 0 ? nodes[nodes.length - 1] : nodes[idx - 1];
        prev?.focus();
      } else {
        const next = idx === -1 || idx === nodes.length - 1 ? nodes[0] : nodes[idx + 1];
        next?.focus();
      }
    }
  }

  private openZoomModal(src?: string): void {
    const url = src ?? this.draft.images[0]?.url;
    if (!url) return;
    this.zoomImg.src = url;
    this.zoomModal.classList.add('is-open');
  }

  private closeZoomModal(): void {
    if (this.zoomModal) {
      this.zoomModal.classList.remove('is-open');
    }
  }

  /** 移除截图（origin=capture 的那一张；手动图片不受影响），并递增草稿版本。 */
  private removeScreenshot(): void {
    // 与按钮禁用态一致（截图 / 移除在提交与轮询期间一并禁用）：
    // 已冻结的快照不会被面板上的操作分叉。
    if (this.phase === 'submitting' || this.polling) return;
    const capture = this.captureImage();
    if (capture) this.removeImage(capture.id);
  }

  /** 清空草稿（提交成功后 / appId 变化时），字节与预览 URL 一并释放。 */
  private clearDraft(): void {
    this.draft.text = '';
    for (const img of this.draft.images) {
      if (img.url) URL.revokeObjectURL(img.url);
    }
    this.draft.images = [];
    this.draft.logs = [];
    this.draft.logsCollected = false;
    this.draft.version++;
  }

  private isMobile(): boolean {
    return window.matchMedia('(max-width: 767.98px)').matches;
  }

  private updateAriaModal(): void {
    this.panel.setAttribute('aria-modal', this.isMobile() ? 'true' : 'false');
  }

  // ---------- 生命周期 ----------

  /** 一次性事件绑定（构造期）：重挂载绝不重复绑定。 */
  private bindEvents(): void {
    this.launcher.addEventListener('click', () => {
      if (this.openState) {
        this.close();
      } else if (this.captureMode === 'viewport') {
        void this.captureAndOpen();
      } else {
        this.open();
      }
    });

    this.initOrbGesture();

    this.textarea.addEventListener('input', () => {
      this.draft.text = this.textarea.value;
      this.draft.version++;
      // 归档或需要人工核对后的新输入视为下一次反馈：回到 idle 阶段
      if (this.phase === 'archived' || this.phase === 'needs_review') {
        this.phase = 'idle';
      }
      this.syncUi();
    });

    // v12：粘贴图片（截图工具 / 复制文件）进草稿
    this.textarea.addEventListener('paste', (ev: ClipboardEvent) => {
      const files = Array.from(ev.clipboardData?.files ?? []).filter((f) =>
        /^image\//.test(f.type),
      );
      if (files.length === 0) return;
      ev.preventDefault(); // 图片不进入文本
      void this.addImageFiles(files, 'paste');
    });

    // v12：拖入图片（在撰写区整体接收）
    this.body.addEventListener('dragover', (ev: DragEvent) => {
      if (ev.dataTransfer && Array.from(ev.dataTransfer.types).includes('Files')) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
        this.body.classList.add('is-dragover');
      }
    });
    this.body.addEventListener('dragleave', (ev: DragEvent) => {
      if (ev.relatedTarget && this.body.contains(ev.relatedTarget as Node)) return;
      this.body.classList.remove('is-dragover');
    });
    this.body.addEventListener('drop', (ev: DragEvent) => {
      this.body.classList.remove('is-dragover');
      const files = Array.from(ev.dataTransfer?.files ?? []).filter((f) =>
        /^image\//.test(f.type),
      );
      if (files.length === 0) return;
      ev.preventDefault();
      void this.addImageFiles(files, 'drop');
    });

    this.root.addEventListener('click', (ev) => {
      if (!this._hostBridge?.onOpenExternal) return;
      const path = ev.composedPath();
      for (const node of path) {
        if (node instanceof Element && node.tagName.toLowerCase() === 'a') {
          const anchor = node as HTMLAnchorElement;
          if (anchor.href && !anchor.hasAttribute('download')) {
            const isExternal = anchor.target === '_blank' || /^https?:\/\//i.test(anchor.getAttribute('href') || '');
            if (isExternal) {
              ev.preventDefault();
              this.openExternal(anchor.href);
              break;
            }
          }
        }
      }
    });
    this.submitBtn.addEventListener('click', () => void this.onPrimaryAction());
  }

  connectedCallback(): void {
    if (!this.hasAttribute('side')) this.setAttribute('side', 'right');
    this.updateLauncherBottomCss();
    this.updateMetaInfo();
    // T6：键未变则跳过——避免断开重连把「仅本次生效」的会话内选择覆盖回存储值
    this.loadServerOverride();

    // 断开重连：图片字节保留在实例草稿中，重连时重建自己的预览 URL
    for (const img of this.draft.images) {
      if (!img.url) img.url = URL.createObjectURL(img.blob);
    }
    // 应用恢复前台（含移动端切回）时刷新额度；跨过 resetAt 后由服务端给出新额度。
    if (!this.visibilityHandler) {
      this.visibilityHandler = () => {
        if (document.visibilityState === 'visible') {
          this.quotaRefreshFailed = false;
          void this.refreshQuota();
          void this.pollSummary();
          if (this.openState && this.activeTab === 'history' && this.activeDialogueId) {
            void this.loadDialogue(this.activeDialogueId, true);
          }
        } else {
          // 退到后台：取消定时查询并使在途查询失效（旧结果不得写回前台状态）；
          // 同时清除补发意图，回前台时重新登记（T1-B）。
          this.invalidateQuotaRefresh();
          this.quotaRefreshPending = false;
        }
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
    if (this.tokenValid()) {
      this.startSummaryPolling();
    }
    if (
      this.openState &&
      this._logProvider &&
      !this.draft.logsCollected &&
      this.draft.logs.length === 0 &&
      !this.logsCollecting &&
      this.phase !== 'submitting'
    ) {
      void this.collectLogs();
    }
    if (this.sessionStore && !this.tokenValid()) {
      void this.loadHostSession();
    }
    this.syncUi();
  }

  disconnectedCallback(): void {
    this.stopDialoguePolling();
    this.stopSummaryPolling();
    this.invalidateLogCollection();
    // 卸载使进行中的捕获会话失效：旧截图结果不得再写入草稿
    this.invalidateCaptureSession();
    this.captureInFlight = null;
    this.clearOrbUnpress();
    if (this.orbPointerId !== null) {
      try {
        this.orb.releasePointerCapture(this.orbPointerId);
      } catch {
        /* 指针捕获可能已自动释放 */
      }
    }
    this.orbPointerId = null;
    this.resetOrbGestureVisuals();
    this.stopPolling();
    // 卸载同样使在途登录与额度查询失效，并取消额度定时查询；
    // 补发意图一并清除（重挂载时重新登记）。
    this.invalidateLogin();
    this.invalidateQuotaRefresh();
    this.quotaRefreshPending = false;
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    // 密码不跨挂载保留（登录结束即清空）。
    this.loginPassword.value = '';
    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler, true);
      this.keydownHandler = null;
    }
    // 断开只释放预览 URL；图片字节保留在实例草稿中，重连时重建
    for (const img of this.draft.images) {
      if (img.url) {
        URL.revokeObjectURL(img.url);
        img.url = '';
      }
    }
    // 断开时关闭图片编辑器与放大预览（不改动草稿字节）
    this.editorHandle?.close();
    this.editorHandle = null;
    this.closeZoomModal();
  }

  attributeChangedCallback(name: string, oldVal: string | null, newVal: string | null): void {
    if (name === 'api-base' && oldVal !== newVal) {
      // 服务身份切换：先递增世代（在途请求全部作废），再清空属于旧服务的一切。
      // T6：偏好槽位随「规范化默认地址 + appId」变化——先按新键重读覆盖再统一重置；
      // 设置视图展示的已是旧身份上下文，一并收起。
      this.settingsOpen = false;
      this.settingsConfirmOpen = false;
      this.pendingServerTarget = undefined;
      this.loadServerOverride();
      this.identityEpoch++;
      this.quotaRefreshPending = false; // 旧身份的补发意图一并清除（T1-B）
      this.resetForServiceSwitch();
    }
    if (name === 'app-id' && oldVal !== newVal) {
      // appId 槽位可能指向不同的实际服务；先加载新覆盖，再决定是否能保留令牌。
      const previousEffectiveApiBase = this.effectiveApiBase;
      this.settingsOpen = false;
      this.settingsConfirmOpen = false;
      this.pendingServerTarget = undefined;
      this.loadServerOverride();
      const nextEffectiveApiBase = this.effectiveApiBase;
      this.identityEpoch++;
      this.quotaRefreshPending = false;
      if (this.sameNormalizedBase(previousEffectiveApiBase, nextEffectiveApiBase)) {
        // 同一服务内的应用身份变化：令牌保留，草稿 / 捕获 / 结果 / 握手整体作废
        this.resetForAppIdSwitch();
      } else {
        // 新 appId 指向另一服务时，旧服务令牌必须一并清除。
        this.resetForServiceSwitch();
      }
    }
    if (name === 'launcher-bottom') {
      this.updateLauncherBottomCss();
    }
    if (name === 'app-version' || name === 'page-label') {
      this.updateMetaInfo();
    }
    if (
      (name === 'show-launcher' && newVal === 'false') ||
      (name === 'launcher-mode' && newVal !== 'orb')
    ) {
      this.clearOrbRelease(true);
    }
    // theme / side / show-launcher / capture-mode 不触碰草稿、令牌、任务态与截图
  }

  /**
   * `api-base` 变化 = 完整身份切换：取消并清空一切属于旧服务的东西
   * （捕获会话 / 提交快照 / 幂等键 / 握手 / 轮询 / 令牌 / 任务态 / 草稿）。
   * 新服务必须重新登录，旧令牌绝不外泄给新基址；旧服务的迟到响应由 epoch 校验丢弃。
   */
  private resetForServiceSwitch(): void {
    this.resetTrackingViews();
    this.invalidateLogCollection();
    this.invalidateCaptureSession();
    this.invalidateLogin();
    this.invalidateQuotaRefresh();
    this.captureInFlight = null;
    this.stopPolling();
    this.pollDelay = POLL_START_MS;
    this.pollStartedAt = 0;
    this.submitSnapshot = null;
    this.idempotencyKey = null;
    this.unconfirmedRequest = null;
    // 凭据隔离：令牌只属于签发它的服务
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.authRequired = false;
    this.pendingSubmit = false;
    this.authUser = null;
    this.quota = null;
    this.loginVisible = false;
    this.loginBusy = false;
    this.loginError = '';
    this.loginPassword.value = '';
    this.lastFeedbackId = null;
    this.lastRecord = null;
    this.lastErrorSummary = null;
    this.lastSubmittedText = '';
    this.refreshing = false;
    this.phase = 'idle';
    // v12：服务切换=新世代——能力声明与诊断缓冲一并作废
    this.capabilitiesKnown = false;
    this.maxImages = MAX_IMAGES;
    this._diagnostics?.clear();
    this.editorHandle?.close();
    this.editorHandle = null;
    this.clearDraft();
    this.textarea.value = '';
    this.renderStatus('');
    this.syncUi();
  }

  /**
   * `app-id` 变化：同一服务内的身份切换——令牌保留（同一服务），
   * 但旧身份的草稿 / 捕获 / 提交结果 / 轮询 / 握手全部作废。
   */
  private resetForAppIdSwitch(): void {
    this.resetTrackingViews();
    this.invalidateLogCollection();
    this.invalidateCaptureSession();
    this.invalidateLogin();
    this.invalidateQuotaRefresh();
    this.captureInFlight = null;
    this.restoreCaptureUi();
    this.stopPolling();
    this.pollDelay = POLL_START_MS;
    this.pollStartedAt = 0;
    // v12：账号/应用切换=新世代——能力声明与诊断缓冲一并作废
    this.capabilitiesKnown = false;
    this.maxImages = MAX_IMAGES;
    this._diagnostics?.clear();
    this.editorHandle?.close();
    this.editorHandle = null;
    this.clearDraft();
    this.textarea.value = '';
    this.submitSnapshot = null;
    this.idempotencyKey = null;
    this.unconfirmedRequest = null;
    this.lastFeedbackId = null;
    this.lastRecord = null;
    this.lastErrorSummary = null;
    this.lastSubmittedText = '';
    this.refreshing = false;
    this.phase = 'idle';
    // 旧身份的登录表单（appId 已变）收起；令牌与额度保留（同一服务、同一账号）。
    this.loginVisible = false;
    this.loginBusy = false;
    this.loginError = '';
    this.loginPassword.value = '';
    this.pendingSubmit = false;
    this.renderStatus('');
    this.syncUi();
  }

  private updateLauncherBottomCss(): void {
    const bottom = this.launcherBottom;
    if (bottom) {
      this.style.setProperty('--fb-launcher-bottom', bottom);
    }
  }

  private updateMetaInfo(): void {
    if (!this.metaInfo) return;
    const parts: string[] = [];
    if (this.appVersion) parts.push(`v${this.appVersion}`);
    if (this.pageLabel) parts.push(this.pageLabel);
    this.metaInfo.textContent = parts.length > 0 ? parts.join(' · ') : '';
    this.metaInfo.hidden = parts.length === 0;
  }

  /**
   * pressed 退出按 140ms ease-out 过渡：CSS 读不到「刚才是 pressed」，
   * 所以挂一个 140ms 的临时 class 承载时长，到点摘掉。
   */
  private beginOrbUnpress(): void {
    this.clearOrbUnpress();
    this.orb.classList.add('is-unpressing');
    this.orbUnpressTimer = setTimeout(() => {
      this.orbUnpressTimer = null;
      this.orb.classList.remove('is-unpressing');
    }, 140);
  }

  private clearOrbUnpress(): void {
    if (this.orbUnpressTimer !== null) {
      clearTimeout(this.orbUnpressTimer);
      this.orbUnpressTimer = null;
    }
    this.orb.classList.remove('is-unpressing');
  }

  private clearOrbDragInlineStyles(): void {
    this.orb.style.removeProperty('transform');
    this.orb.style.removeProperty('--fb-orb-drag-angle');
    this.orb.style.removeProperty('--fb-orb-stretch-along');
    this.orb.style.removeProperty('--fb-orb-glow-x');
    this.orb.style.removeProperty('--fb-orb-glow-y');
  }

  private clearOrbRelease(resetVisuals = false): void {
    this.orbReleaseGeneration++;
    const view = this.ownerDocument.defaultView;
    if (this.orbReleaseFrame !== null) {
      view?.cancelAnimationFrame(this.orbReleaseFrame);
      this.orbReleaseFrame = null;
    }
    if (this.orbReleaseTimer !== null) {
      clearTimeout(this.orbReleaseTimer);
      this.orbReleaseTimer = null;
    }
    this.orb.classList.remove('is-releasing');
    if (!resetVisuals) return;

    this.orb.style.setProperty('transition', 'none');
    this.isDragging = false;
    this.orb.classList.remove('is-dragging');
    this.clearOrbDragInlineStyles();
    void this.orb.offsetWidth;
    this.orb.style.removeProperty('transition');
  }

  private canAnimateOrbRelease(): boolean {
    const view = this.ownerDocument.defaultView;
    return Boolean(
      orbRegisteredPropertiesAvailable &&
        view &&
        typeof view.requestAnimationFrame === 'function' &&
        !this.prefersReducedMotion() &&
        this.isConnected &&
        this.showLauncher &&
        this.launcherMode === 'orb' &&
        !this.openState &&
        !this.orb.classList.contains('is-hidden') &&
        this.orb.style.visibility !== 'hidden',
    );
  }

  private beginOrbRelease(): void {
    if (!this.canAnimateOrbRelease()) {
      this.resetOrbGestureVisuals();
      return;
    }

    this.clearOrbRelease();
    this.clearOrbUnpress();
    this.orb.classList.add('is-releasing');
    const generation = this.orbReleaseGeneration;
    const view = this.ownerDocument.defaultView!;
    this.orbReleaseFrame = view.requestAnimationFrame(() => {
      if (generation !== this.orbReleaseGeneration) return;
      this.orbReleaseFrame = null;
      this.isDragging = false;
      this.orb.classList.remove('is-pressed', 'is-dragging');
      this.clearOrbDragInlineStyles();
      this.orbReleaseTimer = setTimeout(() => {
        if (generation !== this.orbReleaseGeneration) return;
        this.orbReleaseTimer = null;
        this.orb.classList.remove('is-releasing');
      }, 460);
    });
  }

  private resetOrbGestureVisuals(): boolean {
    const wasPressed = this.orb.classList.contains('is-pressed');
    this.clearOrbRelease(true);
    this.isDragging = false;
    this.orb.classList.remove('is-pressed', 'is-dragging');
    this.clearOrbDragInlineStyles();
    return wasPressed;
  }

  private initOrbGesture(): void {
    let startX = 0;
    let startY = 0;
    let isPointerDown = false;

    this.orb.addEventListener('pointerdown', (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      startX = ev.clientX;
      startY = ev.clientY;
      isPointerDown = true;
      this.clearOrbRelease(true);
      this.isDragging = false;
      this.orbPointerId = ev.pointerId;
      this.clearOrbUnpress();
      this.orb.classList.add('is-pressed');
      try {
        this.orb.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore pointer capture error */
      }
    });

    this.orb.addEventListener('pointermove', (ev: PointerEvent) => {
      if (!isPointerDown || this.orbPointerId !== ev.pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!this.isDragging) {
        if (Math.hypot(dx, dy) > 8) {
          this.isDragging = true;
          this.orb.classList.remove('is-pressed');
          this.orb.classList.add('is-dragging');
        }
      }
      if (this.isDragging) {
        const r = Math.hypot(dx, dy);
        const angle = r === 0 ? 0 : Math.atan2(dy, dx);
        const pull = Math.min(1, r / 80);
        const stretchAlong = 1 + 0.04 * pull;
        const rawGlowX = -4 * pull * Math.cos(angle);
        const rawGlowY = -4 * pull * Math.sin(angle);
        const glowX = Math.abs(rawGlowX) < 1e-12 ? 0 : rawGlowX;
        const glowY = Math.abs(rawGlowY) < 1e-12 ? 0 : rawGlowY;
        this.orb.style.setProperty('--fb-orb-drag-angle', `${angle}rad`);
        this.orb.style.setProperty('--fb-orb-stretch-along', `${stretchAlong}`);
        this.orb.style.setProperty('--fb-orb-glow-x', `${glowX}px`);
        this.orb.style.setProperty('--fb-orb-glow-y', `${glowY}px`);
        // 四层视觉组独立缩放与拉伸；badge 不参与，root 只做无平滑的 1:1 指针平移。
        this.orb.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      }
    });

    const onPointerFinish = (ev: PointerEvent, isCancel = false) => {
      if (!isPointerDown || this.orbPointerId !== ev.pointerId) return;
      isPointerDown = false;
      try {
        this.orb.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore pointer capture release error */
      }
      this.orbPointerId = null;

      const wasDragging = this.isDragging;
      if (wasDragging) {
        this.beginOrbRelease();
      } else {
        const wasPressed = this.resetOrbGestureVisuals();
        if (wasPressed) this.beginOrbUnpress();
      }

      if (isCancel) return;

      if (wasDragging) {
        const vw = typeof window !== 'undefined' ? window.innerWidth || 1 : 1;
        const vh = typeof window !== 'undefined' ? window.innerHeight || 1 : 1;
        const rx = Math.max(0, Math.min(1, ev.clientX / vw));
        const ry = Math.max(0, Math.min(1, ev.clientY / vh));
        const releasePoint = {
          x: Math.round(rx * 10000) / 10000,
          y: Math.round(ry * 10000) / 10000,
        };
        // T1：拖动松手**不再直接写草稿**，改为进入「冻结画面 → 调整选区 → 确认」流程。
        // 停靠位置由 transform 复位决定，截图定位绝不更改停靠位置。
        void this.startRegionCapture({ releasePoint });
      } else {
        if (this.captureMode === 'viewport') {
          void this.captureAndOpen();
        } else {
          this.open();
        }
      }
    };

    this.orb.addEventListener('pointerup', (ev: PointerEvent) => onPointerFinish(ev, false));
    this.orb.addEventListener('pointercancel', (ev: PointerEvent) => onPointerFinish(ev, true));
    this.orb.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key === ' ' || ev.key === 'Enter') {
        ev.preventDefault();
        if (this.captureMode === 'viewport') {
          void this.captureAndOpen();
        } else {
          this.open();
        }
      }
    });
  }

  // ---------- DOM 构建 ----------

  private buildDom(): void {
    const style = el('style');
    style.textContent = STYLES;

    // 贴边入口标签（同时挂 .fb-fab 兼容既有选择器）
    this.launcher = el('button', 'fb-launcher fb-fab fb-tab-launcher');
    this.launcher.type = 'button';
    this.launcher.setAttribute('aria-label', '打开反馈面板');
    this.launcher.setAttribute('aria-expanded', 'false');
    this.launcher.setAttribute('aria-controls', 'fb-panel');

    const launcherIcon = svgFeedbackIcon('fb-launcher-icon');
    const launcherText = el('span', undefined, '反馈');
    this.launcherBadge = el('span', 'fb-badge fb-launcher-badge');
    this.launcherBadge.hidden = true;
    this.launcher.append(launcherIcon, launcherText, this.launcherBadge);

    // 灵感球 (Inspiration Orb)
    this.orb = el('button', 'fb-launcher fb-orb');
    if (!orbRegisteredPropertiesAvailable) {
      this.orb.classList.add('fb-orb-properties-unavailable');
    }
    this.orb.type = 'button';
    this.orb.setAttribute('aria-label', '灵感球：拖动指出问题或点击反馈');
    this.orb.setAttribute('aria-expanded', 'false');
    this.orb.setAttribute('aria-controls', 'fb-panel');
    this.orbBadge = el('span', 'fb-badge fb-launcher-badge');
    this.orbBadge.hidden = true;
    const orbLayersEl = orbLayers();
    this.orb.append(
      orbLayersEl.bloom,
      orbLayersEl.glow,
      orbLayersEl.sweep,
      orbLayersEl.core,
      orbLayersEl.focusRing,
      this.orbBadge,
    );

    // 面板：桌面为 400px 贴边圆角浮层（无遮罩），移动端全屏
    this.panel = el('div', 'fb-panel');
    this.panel.id = 'fb-panel';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', '记录体验');
    this.panel.setAttribute('aria-modal', 'false');
    this.panel.hidden = true;

    // 头部：图标 + “记录体验” + 次要信息 + 关闭按钮
    const header = el('header', 'fb-header');
    const titleGroup = el('div', 'fb-title-group');
    const headerIcon = svgFeedbackIcon('fb-header-icon');
    const title = el('h2', undefined, '记录体验');
    this.metaInfo = el('span', 'fb-header-meta');
    this.metaInfo.hidden = true;
    titleGroup.append(headerIcon, title, this.metaInfo);

    // T6：头部右侧动作组——服务器设置（未登录也可进入）+ 关闭
    const headerActions = el('div', 'fb-header-actions');
    this.settingsBtn = el('button', 'fb-icon-btn fb-settings-btn');
    this.settingsBtn.type = 'button';
    this.settingsBtn.setAttribute('aria-label', '服务器设置');
    this.settingsBtn.title = '服务器设置';
    this.settingsBtn.append(svgGearIcon());
    this.settingsBtn.addEventListener('click', () => this.openServerSettings());

    const closeBtn = el('button', 'fb-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '关闭反馈面板');
    closeBtn.append(svgCloseIcon());
    closeBtn.addEventListener('click', () => this.close());
    headerActions.append(this.settingsBtn, closeBtn);
    header.append(titleGroup, headerActions);

    // 导航标签：新建反馈 vs 我的反馈
    const navTabs = el('div', 'fb-nav-tabs');
    navTabs.style.padding = '0 16px 8px';
    navTabs.style.borderBottom = '1px solid var(--fb-border)';

    this.tabComposeBtn = el('button', 'fb-nav-btn active', '新建反馈');
    this.tabComposeBtn.type = 'button';
    this.tabComposeBtn.addEventListener('click', () => this.switchTab('compose'));

    this.tabHistoryBtn = el('button', 'fb-nav-btn');
    this.tabHistoryBtn.type = 'button';
    const historyBtnText = el('span', undefined, '我的反馈');
    this.tabHistoryBadge = el('span', 'fb-badge');
    this.tabHistoryBadge.hidden = true;
    this.tabHistoryBadge.style.marginLeft = '4px';
    this.tabHistoryBtn.append(historyBtnText, this.tabHistoryBadge);
    this.tabHistoryBtn.addEventListener('click', () => this.switchTab('history'));

    navTabs.append(this.tabComposeBtn, this.tabHistoryBtn);
    this.navTabs = navTabs;

    // 主体
    const body = el('div', 'fb-body');
    this.body = body;

    // 截图/图片区：预览网格与操作区**分开**（v12 多图）。
    // 网格只在有图片时出现（无图时连缩略图一起隐藏，避免空 src 破图占位）；
    // 操作区始终在：没有截图时是「截取当前页面」——默认 capture-mode="off"
    // （不自动截图）宿主在「先输入文字」之后唯一的手动补拍入口。
    this.shotArea = el('div', 'fb-shot-area');

    this.screenshotWrap = el('div', 'fb-screenshot-wrap');
    this.screenshotWrap.hidden = true;

    this.screenshotThumbBox = el('div', 'fb-screenshot-thumb-box');
    this.screenshotThumbBox.setAttribute('role', 'button');
    this.screenshotThumbBox.setAttribute('tabindex', '0');
    this.screenshotThumbBox.setAttribute('aria-label', '查看图片 1');

    // 图片单元格结构（T2.5）：图片框（contain 完整显示 + 角标 + 尺寸）与操作行分离，
    // 编辑 / 删除按钮放在图片**下方**，不得遮住图片内容。
    const thumbFrame = el('div', 'fb-thumb-frame');
    this.screenshotThumb = el('img', 'fb-screenshot-thumb');
    this.screenshotThumb.alt = '图片缩略图';

    const badge = el('span', 'fb-screenshot-badge', '截图');
    const sizeLabel = el('span', 'fb-screenshot-size');
    const zoomHint = el('span', 'fb-screenshot-zoom-hint', '点击放大');
    thumbFrame.append(this.screenshotThumb, badge, sizeLabel, zoomHint);

    const firstActions = el('div', 'fb-thumb-actions');
    const firstEditBtn = el('button', 'fb-thumb-edit', '编辑');
    firstEditBtn.type = 'button';
    firstEditBtn.setAttribute('aria-label', '编辑图片 1');
    firstEditBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const first = this.draft.images[0];
      if (first) void this.openEditorForImage(first.id);
    });
    const firstDelBtn = el('button', 'fb-thumb-remove', '删除');
    firstDelBtn.type = 'button';
    firstDelBtn.setAttribute('aria-label', '删除图片 1');
    firstDelBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const first = this.draft.images[0];
      if (first) this.removeImage(first.id);
    });
    firstActions.append(firstEditBtn, firstDelBtn);
    this.screenshotThumbBox.append(thumbFrame, firstActions);
    this.screenshotWrap.append(this.screenshotThumbBox);

    // 预览旁提示：不可绘制内容 / 服务端降级 / 体积仍超限
    this.shotHintEl = el('p', 'fb-shot-hint');
    this.shotHintEl.hidden = true;
    this.shotErrorEl = el('p', 'fb-shot-error');
    this.shotErrorEl.hidden = true;
    this.shotErrorEl.setAttribute('role', 'alert');

    const screenshotActions = el('div', 'fb-screenshot-actions');
    this.captureBtn = el('button', 'fb-btn-capture', CAPTURE_ACTION_LABEL);
    this.captureBtn.type = 'button';
    this.captureBtn.setAttribute('aria-label', '截取当前页面并附加截图');

    this.retakeBtn = el('button', 'fb-btn-retake', '重新截图');
    this.retakeBtn.type = 'button';
    this.retakeBtn.setAttribute('aria-label', '重新捕获屏幕截图');
    this.retakeBtn.hidden = true;

    this.removeBtn = el('button', 'fb-btn-remove', '移除截图');
    this.removeBtn.type = 'button';
    this.removeBtn.setAttribute('aria-label', '移除当前截图');
    this.removeBtn.hidden = true;

    this.addImageBtn = el('button', 'fb-btn-add-image', '添加图片');
    this.addImageBtn.type = 'button';
    this.addImageBtn.setAttribute('aria-label', '添加图片附件（选择文件，也可拖入或粘贴）');

    this.imageFileInput = el('input', 'fb-image-input');
    this.imageFileInput.type = 'file';
    this.imageFileInput.accept = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
    this.imageFileInput.multiple = true;
    this.imageFileInput.hidden = true;
    this.imageFileInput.setAttribute('aria-hidden', 'true');

    screenshotActions.append(this.captureBtn, this.retakeBtn, this.removeBtn, this.addImageBtn);
    this.shotArea.append(this.screenshotWrap, this.shotErrorEl, this.shotHintEl, screenshotActions, this.imageFileInput);

    this.captureBtn.addEventListener('click', () => this.captureFromPanel());
    this.addImageBtn.addEventListener('click', () => this.imageFileInput.click());
    this.imageFileInput.addEventListener('change', () => {
      const files = Array.from(this.imageFileInput.files ?? []);
      this.imageFileInput.value = ''; // 允许重复选同一文件
      void this.addImageFiles(files);
    });

    this.screenshotThumbBox.addEventListener('click', () => this.openZoomModal());
    this.screenshotThumbBox.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key === ' ' || ev.key === 'Enter') {
        ev.preventDefault();
        this.openZoomModal();
      }
    });
    this.retakeBtn.addEventListener('click', () => void this.retakeScreenshot());
    this.removeBtn.addEventListener('click', () => this.removeScreenshot());

    // 可见提示标签
    const promptLabel = el('label', 'fb-prompt', '哪里不顺手，或者有什么新想法？');
    promptLabel.setAttribute('for', 'fb-textarea');

    // 输入区
    const textareaWrap = el('div', 'fb-textarea-wrap');
    this.textarea = el('textarea', 'fb-textarea');
    this.textarea.id = 'fb-textarea';
    this.textarea.placeholder = '刚才哪里不顺手？你希望它怎样改进？';
    this.textarea.setAttribute('aria-label', '反馈内容');
    this.textarea.value = this.draft.text;

    const counterRow = el('div', 'fb-counter-row');
    this.counter = el('span', 'fb-counter');
    counterRow.append(this.counter);
    textareaWrap.append(this.textarea, counterRow);

    // 状态与结果卡片区
    this.statusRegion = el('div', 'fb-status fb-status-region');
    this.statusRegion.setAttribute('role', 'status');
    this.statusRegion.setAttribute('aria-live', 'polite');

    this.errorRegion = el('div', 'fb-error fb-status-card-wrap');
    this.errorRegion.hidden = true;

    // 底部操作区：额度 / 面板内登录表单 + 提交按钮 + 次要说明
    const footer = el('footer', 'fb-footer');

    this.quotaInfo = el('span', 'fb-quota');
    this.quotaInfo.hidden = true;
    this.quotaInfo.setAttribute('role', 'status');

    this.quotaBlockedInfo = el('p', 'fb-quota-blocked');
    this.quotaBlockedInfo.hidden = true;

    this.loginPanel = el('div', 'fb-login-panel');
    this.loginPanel.hidden = true;
    this.loginPanel.setAttribute('role', 'group');
    this.loginPanel.setAttribute('aria-label', '账号登录');

    this.loginUsername = el('input', 'fb-login-input fb-login-username');
    this.loginUsername.type = 'text';
    this.loginUsername.autocomplete = 'username';
    this.loginUsername.placeholder = '用户名';
    this.loginUsername.setAttribute('aria-label', '用户名');

    this.loginPassword = el('input', 'fb-login-input fb-login-password');
    this.loginPassword.type = 'password';
    this.loginPassword.autocomplete = 'current-password';
    this.loginPassword.placeholder = '密码';
    this.loginPassword.setAttribute('aria-label', '密码');

    this.loginErrorEl = el('p', 'fb-login-error');
    this.loginErrorEl.hidden = true;

    this.loginConfirmBtn = el('button', 'fb-btn-secondary fb-login-confirm', '登录并提交');
    this.loginConfirmBtn.type = 'button';
    this.loginConfirmBtn.setAttribute('aria-label', '登录并提交反馈');
    this.loginCancelBtn = el('button', 'fb-btn-secondary fb-login-cancel', '取消');
    this.loginCancelBtn.type = 'button';
    const loginActions = el('div', 'fb-login-actions');
    loginActions.append(this.loginConfirmBtn, this.loginCancelBtn);

    const loginRow = el('div', 'fb-login-row');
    loginRow.append(this.loginUsername, this.loginPassword);
    this.loginPanel.append(loginRow, this.loginErrorEl, loginActions);

    this.submitBtn = el('button', 'fb-submit', '提交');
    this.submitBtn.type = 'button';
    this.submitBtn.setAttribute('aria-label', '提交反馈');

    const footnote = el('p', 'fb-footnote', '会保留原话，整理为候选改进');
    footer.append(this.quotaInfo, this.quotaBlockedInfo, this.loginPanel, this.submitBtn, footnote);

    // 面板内登录：确认即登录并提交；取消只收起表单，草稿与截图保留。
    this.loginConfirmBtn.addEventListener('click', () => void this.doLogin());
    this.loginCancelBtn.addEventListener('click', () => this.cancelLogin());
    this.loginPassword.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void this.doLogin();
      }
    });

    // 日志附件区（T4）：默认只显示简短摘要，展开后才有文件列表与操作。
    this.logsArea = el('div', 'fb-logs-area');

    this.logsToggleBtn = el('button', 'fb-logs-toggle');
    this.logsToggleBtn.type = 'button';
    this.logsToggleBtn.setAttribute('aria-expanded', 'false');
    this.logsToggleBtn.setAttribute('aria-controls', 'fb-logs-body');
    this.logsSummaryEl = el('span', 'fb-logs-summary', '诊断日志');
    const logsChevron = el('span', 'fb-logs-chevron', '▸');
    logsChevron.setAttribute('aria-hidden', 'true');
    this.logsToggleBtn.append(this.logsSummaryEl, logsChevron);
    this.logsToggleBtn.addEventListener('click', () => this.toggleLogs());

    this.logsBody = el('div', 'fb-logs-body');
    this.logsBody.id = 'fb-logs-body';
    this.logsBody.hidden = true;

    const logsHeader = el('div', 'fb-logs-header');
    const logsLabel = el('span', undefined, '日志附件');
    this.logsCountEl = el('span', 'fb-logs-count', ' (0/3)');
    logsLabel.append(this.logsCountEl);

    const logsActions = el('div', 'fb-logs-actions');
    this.addLogBtn = el('button', 'fb-btn-add-log', '添加日志');
    this.addLogBtn.type = 'button';
    this.addLogBtn.setAttribute('aria-label', '手动添加日志文件');

    this.recollectLogBtn = el('button', 'fb-btn-add-log fb-log-recollect', '重新采集');
    this.recollectLogBtn.type = 'button';
    this.recollectLogBtn.setAttribute('aria-label', '重新采集诊断日志');
    this.recollectLogBtn.hidden = true;

    this.logFileInput = el('input', 'fb-log-input');
    this.logFileInput.type = 'file';
    this.logFileInput.accept = '.log,.txt,.json,.jsonl';
    this.logFileInput.multiple = true;
    this.logFileInput.hidden = true;

    this.addLogBtn.addEventListener('click', () => {
      this.logFileInput.click();
    });
    this.recollectLogBtn.addEventListener('click', () => {
      if (this.phase !== 'submitting') void this.collectLogs();
    });
    this.logFileInput.addEventListener('change', () => {
      this.handleLogFileSelect();
    });

    logsActions.append(this.addLogBtn, this.recollectLogBtn, this.logFileInput);
    logsHeader.append(logsLabel, logsActions);

    this.logStatusEl = el('span', 'fb-log-status');
    this.logStatusEl.hidden = true;

    this.logErrorEl = el('div', 'fb-log-error');
    this.logErrorEl.hidden = true;

    // 采集失败的显式重试入口：仅在失败文案出现时挂进 logErrorEl（textContent 重置即移除）。
    this.logRetryBtn = el('button', 'fb-btn-secondary fb-log-retry', '重试');
    this.logRetryBtn.type = 'button';
    this.logRetryBtn.setAttribute('aria-label', '重试采集日志');
    this.logRetryBtn.addEventListener('click', () => {
      if (this.phase !== 'submitting') void this.collectLogs();
    });

    this.logsList = el('ul', 'fb-logs-list');
    this.logsBody.append(logsHeader, this.logStatusEl, this.logErrorEl, this.logsList);
    this.logsArea.append(this.logsToggleBtn, this.logsBody);

    // 面板组件顺序（T2.6）：标题与页签 → 反馈描述 → 图片证据 → 可折叠日志 → 固定提交区
    body.append(
      promptLabel,
      textareaWrap,
      this.shotArea,
      this.logsArea,
      this.statusRegion,
      this.errorRegion,
      footer,
    );
    this.panel.append(header, this.navTabs, body, this.buildHistoryView(), this.buildSettingsView());

    // 大图预览弹窗 (Zoom Modal)
    this.zoomModal = el('div', 'fb-zoom-modal');
    this.zoomModal.setAttribute('role', 'dialog');
    this.zoomModal.setAttribute('aria-label', '完整截图预览');
    this.zoomImg = el('img');
    this.zoomImg.alt = '完整截图预览';
    this.zoomCloseBtn = el('button', 'fb-zoom-close');
    this.zoomCloseBtn.type = 'button';
    this.zoomCloseBtn.setAttribute('aria-label', '关闭截图预览');
    this.zoomCloseBtn.append(svgCloseIcon());

    this.zoomModal.append(this.zoomImg, this.zoomCloseBtn);
    this.zoomModal.addEventListener('click', (ev) => {
      if (
        ev.target === this.zoomModal ||
        ev.target === this.zoomCloseBtn ||
        this.zoomCloseBtn.contains(ev.target as Node)
      ) {
        this.closeZoomModal();
      }
    });

    // T1 局部选区覆盖层：冻结的已遮挡画面作背景 + 可调整选区 + 三个操作。
    // 覆盖层只读取冻结位图，绝不改动停靠位置或草稿；取消即整体丢弃。
    this.regionOverlay = el('div', 'fb-region-overlay');
    this.regionOverlay.setAttribute('role', 'dialog');
    this.regionOverlay.setAttribute('aria-modal', 'true');
    this.regionOverlay.setAttribute('aria-label', '选择截图区域');
    this.regionOverlay.hidden = true;

    this.regionBg = el('img', 'fb-region-bg');
    this.regionBg.alt = '';
    this.regionBg.setAttribute('aria-hidden', 'true');

    this.regionFrame = el('div', 'fb-region-frame');
    this.regionFrame.tabIndex = 0;
    this.regionFrame.setAttribute('role', 'group');
    this.regionFrame.setAttribute(
      'aria-label',
      '截图选区：方向键移动，Shift+方向键缩放，回车确认使用此区域，Esc 取消',
    );
    for (const handleName of REGION_HANDLES) {
      const handle = el('span', 'fb-region-handle');
      handle.setAttribute('data-handle', handleName);
      handle.setAttribute('aria-hidden', 'true');
      this.regionFrame.append(handle);
    }

    const regionToolbar = el('div', 'fb-region-toolbar');
    this.regionSizeEl = el('span', 'fb-region-size');
    this.regionUseBtn = el('button', 'fb-region-btn fb-region-use', '使用此区域');
    this.regionAllBtn = el('button', 'fb-region-btn fb-region-all', '截取整个窗口');
    this.regionCancelBtn = el('button', 'fb-region-btn fb-region-cancel', '取消');
    for (const b of [this.regionUseBtn, this.regionAllBtn, this.regionCancelBtn]) b.type = 'button';
    this.regionUseBtn.setAttribute('aria-label', '使用当前选区作为反馈截图');
    this.regionAllBtn.setAttribute('aria-label', '使用整张画面作为反馈截图');
    this.regionCancelBtn.setAttribute('aria-label', '取消局部截图');
    regionToolbar.append(this.regionSizeEl, this.regionUseBtn, this.regionAllBtn, this.regionCancelBtn);

    this.regionErrorEl = el('p', 'fb-region-error');
    this.regionErrorEl.hidden = true;
    this.regionErrorEl.setAttribute('role', 'alert');

    this.regionOverlay.append(this.regionBg, this.regionFrame, regionToolbar, this.regionErrorEl);

    this.regionUseBtn.addEventListener('click', () => void this.confirmRegion(true));
    this.regionAllBtn.addEventListener('click', () => void this.confirmRegion(false));
    this.regionCancelBtn.addEventListener('click', () => this.cancelRegion());
    // 指针交互：选区内拖动=移动、控制点=缩放、覆盖层空白处=重新框选
    this.regionOverlay.addEventListener('pointerdown', (ev) => this.onRegionPointerDown(ev));
    this.regionOverlay.addEventListener('pointermove', (ev) => this.onRegionPointerMove(ev));
    this.regionOverlay.addEventListener('pointerup', (ev) => this.onRegionPointerEnd(ev));
    this.regionOverlay.addEventListener('pointercancel', (ev) => this.onRegionPointerEnd(ev));

    // 日志文本预览弹窗
    this.logPreviewModal = el('div', 'fb-log-preview-modal');
    this.logPreviewModal.setAttribute('role', 'dialog');
    this.logPreviewModal.setAttribute('aria-label', '日志预览');

    const previewCard = el('div', 'fb-log-preview-card');
    const previewHeader = el('div', 'fb-header');
    this.logPreviewTitle = el('h3', undefined, '日志预览');
    this.logPreviewCloseBtn = el('button', 'fb-close');
    this.logPreviewCloseBtn.type = 'button';
    this.logPreviewCloseBtn.setAttribute('aria-label', '关闭日志预览');
    this.logPreviewCloseBtn.append(svgCloseIcon());
    this.logPreviewCloseBtn.addEventListener('click', () => this.closeLogPreview());
    previewHeader.append(this.logPreviewTitle, this.logPreviewCloseBtn);

    this.logPreviewBody = el('pre', 'fb-log-preview-body');
    previewCard.append(previewHeader, this.logPreviewBody);
    this.logPreviewModal.append(previewCard);
    this.logPreviewModal.addEventListener('click', (ev) => {
      if (ev.target === this.logPreviewModal) {
        this.closeLogPreview();
      }
    });

    this.root.append(
      style,
      this.launcher,
      this.orb,
      this.panel,
      this.zoomModal,
      this.logPreviewModal,
      this.regionOverlay,
    );

    // 监听按键（支持 ⌘/Ctrl + Enter 提交）
    this.addEventListener('keydown', (ev: KeyboardEvent) => this.onKeydown(ev));
  }

  /**
   * T6：服务器设置视图（面板内、与主体互斥显示；未登录也可进入）。
   * 提供地址输入、保存、取消、恢复默认与当前有效地址展示；
   * 地址变化且有草稿 / 未确认提交时先展开内联确认块。
   */
  private buildSettingsView(): HTMLDivElement {
    this.settingsView = el('div', 'fb-settings');
    this.settingsView.hidden = true;
    this.settingsView.setAttribute('role', 'group');
    this.settingsView.setAttribute('aria-label', '服务器设置');

    const title = el('h3', 'fb-settings-title', 'Feedback 服务器');

    const currentRow = el('p', 'fb-settings-line');
    currentRow.append(el('span', 'fb-settings-label', '当前使用：'));
    this.settingsCurrent = el('span', 'fb-settings-value');
    currentRow.append(this.settingsCurrent);

    this.settingsDefaultRow = el('p', 'fb-settings-line');
    this.settingsDefaultRow.hidden = true;
    this.settingsDefaultRow.append(el('span', 'fb-settings-label', '宿主默认：'));
    this.settingsDefaultText = el('span', 'fb-settings-value');
    this.settingsDefaultRow.append(this.settingsDefaultText);

    const inputLabel = el('label', 'fb-prompt', '服务器地址');
    inputLabel.setAttribute('for', 'fb-server-input');
    this.settingsInput = el('input', 'fb-login-input fb-server-input');
    this.settingsInput.id = 'fb-server-input';
    this.settingsInput.type = 'url';
    this.settingsInput.placeholder = 'https://fb.example.com';
    this.settingsInput.autocomplete = 'off';
    this.settingsInput.spellcheck = false;
    this.settingsInput.setAttribute('aria-label', '服务器地址');
    this.settingsInput.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'Enter' && !ev.isComposing && ev.keyCode !== 229) {
        ev.preventDefault();
        this.saveServerSettings();
      }
    });

    this.settingsErrorEl = el('p', 'fb-settings-error');
    this.settingsErrorEl.hidden = true;
    this.settingsHintEl = el('p', 'fb-settings-hint');
    this.settingsHintEl.hidden = true;
    this.settingsHintEl.setAttribute('role', 'status');

    const actions = el('div', 'fb-settings-actions');
    this.settingsSaveBtn = el('button', 'fb-btn-secondary fb-settings-save', '保存');
    this.settingsSaveBtn.type = 'button';
    this.settingsRestoreBtn = el('button', 'fb-btn-secondary fb-settings-restore', '恢复默认');
    this.settingsRestoreBtn.type = 'button';
    this.settingsCancelBtn = el('button', 'fb-btn-secondary fb-settings-cancel', '返回');
    this.settingsCancelBtn.type = 'button';
    actions.append(this.settingsSaveBtn, this.settingsRestoreBtn, this.settingsCancelBtn);

    this.settingsConfirmEl = el('div', 'fb-settings-confirm');
    this.settingsConfirmEl.hidden = true;
    this.settingsConfirmText = el('p', 'fb-settings-confirm-text');
    const confirmActions = el('div', 'fb-settings-actions');
    const confirmOk = el('button', 'fb-btn-secondary fb-settings-confirm-ok', '清空并切换');
    confirmOk.type = 'button';
    const confirmCancel = el('button', 'fb-btn-secondary fb-settings-confirm-cancel', '取消');
    confirmCancel.type = 'button';
    confirmActions.append(confirmOk, confirmCancel);
    this.settingsConfirmEl.append(this.settingsConfirmText, confirmActions);

    const note = el('p', 'fb-footnote', '支持 http(s) 地址，可包含端口与部署路径前缀；仅本机记住选择。');

    this.settingsView.append(
      title,
      currentRow,
      this.settingsDefaultRow,
      inputLabel,
      this.settingsInput,
      this.settingsErrorEl,
      this.settingsHintEl,
      actions,
      this.settingsConfirmEl,
      note,
    );

    this.settingsSaveBtn.addEventListener('click', () => this.saveServerSettings());
    this.settingsRestoreBtn.addEventListener('click', () => this.requestRestoreDefault());
    this.settingsCancelBtn.addEventListener('click', () => this.closeServerSettings());
    confirmOk.addEventListener('click', () => this.confirmServerSwitch());
    confirmCancel.addEventListener('click', () => this.cancelServerSwitch());

    return this.settingsView;
  }

  // ---------- 历史反馈与 Issue 对话 ----------

  private buildHistoryView(): HTMLDivElement {
    this.historyContainer = el('div', 'fb-history-container');
    this.historyContainer.style.display = 'flex';
    this.historyContainer.style.flexDirection = 'column';
    this.historyContainer.style.flex = '1';
    this.historyContainer.style.overflow = 'hidden';
    this.historyContainer.style.padding = '0 16px';
    this.historyContainer.hidden = true;

    this.historyListView = el('div', 'fb-history-view');
    this.dialogueView = el('div', 'fb-dialogue-view');
    this.dialogueView.hidden = true;

    this.historyContainer.append(this.historyListView, this.dialogueView);
    return this.historyContainer;
  }

  private switchTab(tab: 'compose' | 'history'): void {
    this.activeTab = tab;
    if (tab === 'compose') {
      this.dialogueRequestSeq++;
      this.historyRequestSeq++;
      this.activeDialogueId = null;
      this.dialogueMessagesBox = null;
      this.dialogueView.hidden = true;
      this.historyListView.hidden = false;
      this.stopDialoguePolling();
      if (this.phase !== 'submitting' && this.phase !== 'tracking') {
        this.startSummaryPolling();
      }
    }
    this.syncUi();
    if (tab === 'history') {
      if (this.activeDialogueId) {
        this.stopSummaryPolling();
        this.startDialoguePolling();
        void this.loadDialogue(this.activeDialogueId);
      } else {
        this.startSummaryPolling();
        void this.loadHistoryList();
      }
    }
  }

  private syncUnreadBadge(): void {
    const show = this.unreadCount > 0;
    const text = this.unreadCount > 99 ? '99+' : String(this.unreadCount);

    if (this.launcherBadge) {
      this.launcherBadge.hidden = !show;
      this.launcherBadge.textContent = text;
    }
    if (this.orbBadge) {
      this.orbBadge.hidden = !show;
      this.orbBadge.textContent = text;
    }
    if (this.tabHistoryBadge) {
      this.tabHistoryBadge.hidden = !show;
      this.tabHistoryBadge.textContent = text;
    }
  }

  /**
   * 未读摘要轮询（v12 口径）：**不再以面板打开为前提**——已登录且页面可见时
   * 每 30 秒查一次 unread-summary（面板关闭也要给入口徽标供数）。
   * 面板销毁 / 页面隐藏 / 退出登录时停止；提交跟踪进行中时跳过（提交轮询优先）。
   */
  private startSummaryPolling(): void {
    this.stopSummaryPolling();
    if (!this.tokenValid() || !this.isConnected) return;
    if (this.activeTab === 'compose' && (this.phase === 'submitting' || this.phase === 'tracking')) return;
    this.summaryPollTimer = setInterval(() => {
      if (
        document.visibilityState === 'visible' &&
        this.tokenValid() &&
        !(this.activeTab === 'compose' && (this.phase === 'submitting' || this.phase === 'tracking'))
      ) {
        void this.pollSummary();
      }
    }, 30_000);
  }

  private stopSummaryPolling(): void {
    if (this.summaryPollTimer) {
      clearInterval(this.summaryPollTimer);
      this.summaryPollTimer = null;
    }
  }

  private async pollSummary(): Promise<void> {
    if (!this.tokenValid() || !this.effectiveApiBase) return;
    const epoch = this.identityEpoch;
    const token = this.accessToken;
    const seq = ++this.summaryRequestSeq;
    try {
      const summary = await getUnreadSummary(this.effectiveApiBase, this.accessToken!, this.appId ?? undefined, { fetchFn: this.apiFetch });
      if (epoch !== this.identityEpoch || token !== this.accessToken || seq !== this.summaryRequestSeq || !this.isConnected) return;
      this.unreadCount = summary.totalUnreadMessages;
      this.syncUnreadBadge();
    } catch {
      // 忽略静默摘要拉取失败
    }
  }

  private startDialoguePolling(): void {
    this.stopDialoguePolling();
    if (!this.tokenValid() || !this.openState) return;
    this.dialoguePollTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && this.activeDialogueId && this.tokenValid() && this.openState) {
        void this.loadDialogue(this.activeDialogueId, true);
      }
    }, 10_000);
  }

  private stopDialoguePolling(): void {
    if (this.dialoguePollTimer) {
      clearInterval(this.dialoguePollTimer);
      this.dialoguePollTimer = null;
    }
  }

  private async loadHistoryList(): Promise<void> {
    const epoch = this.identityEpoch;
    const token = this.accessToken;
    const seq = ++this.historyRequestSeq;
    const current = (): boolean => epoch === this.identityEpoch && token === this.accessToken && seq === this.historyRequestSeq && this.isConnected && this.activeTab === 'history' && !this.activeDialogueId;
    if (!this.tokenValid() || !this.effectiveApiBase) {
      this.historyListView.innerHTML = '';
      const prompt = el('div', 'fb-history-empty');
      prompt.style.textAlign = 'center';
      prompt.style.padding = '24px 0';
      const text = el('p', 'fb-muted', '查看反馈历史需要登录');
      const loginBtn = el('button', 'fb-btn-secondary', '去登录');
      loginBtn.type = 'button';
      loginBtn.style.marginTop = '8px';
      loginBtn.addEventListener('click', () => {
        this.switchTab('compose');
        this.beginLogin(false);
      });
      prompt.append(text, loginBtn);
      this.historyListView.append(prompt);
      return;
    }

    this.historyListView.innerHTML = '';

    // v12：状态筛选（用户端文案口径以测试锁定为准：全部状态/待处理/待补充/等待回复/已解决；
    // 注意 docs/api.md:644 仍写「待管理员回复」，与本组件实际文案不一致，属文档侧待修正项）
    const filterRow = el('div', 'fb-history-filter-row');
    const filterSelect = el('select', 'fb-history-filter');
    filterSelect.setAttribute('aria-label', '按问题状态筛选');
    const filterOptions: Array<[IssueStatus | '', string]> = [
      ['', '全部状态'],
      ['open', '待处理'],
      ['waiting_user', '待补充'],
      ['waiting_admin', '等待回复'],
      ['resolved', '已解决'],
    ];
    for (const [value, label] of filterOptions) {
      const opt = el('option');
      opt.value = value;
      opt.textContent = label;
      filterSelect.append(opt);
    }
    filterSelect.value = this.historyIssueStatus;
    filterSelect.addEventListener('change', () => {
      this.historyIssueStatus = (filterSelect.value || '') as IssueStatus | '';
      this.historyPage = 1;
      void this.loadHistoryList();
    });
    const refreshBtn = el('button', 'fb-btn-secondary fb-history-refresh', '刷新');
    refreshBtn.type = 'button';
    refreshBtn.setAttribute('aria-label', '刷新我的反馈');
    refreshBtn.addEventListener('click', () => void this.loadHistoryList());
    filterRow.append(filterSelect, refreshBtn);

    const itemsBox = el('div', 'fb-history-items');
    const loading = el('div', undefined, '加载反馈列表中…');
    loading.style.padding = '16px';
    loading.style.textAlign = 'center';
    loading.style.color = 'var(--fb-text-secondary)';
    itemsBox.append(loading);

    const pagerRow = el('div', 'fb-history-pager');
    this.historyListView.append(filterRow, itemsBox, pagerRow);

    try {
      const res = await listMyFeedbacks(this.effectiveApiBase, this.accessToken!, {
        appId: this.appId ?? undefined,
        page: this.historyPage,
        limit: 20,
        ...(this.historyIssueStatus ? { issueStatus: this.historyIssueStatus } : {}),
        fetchFn: this.apiFetch,
      });
      if (!current()) return;
      itemsBox.innerHTML = '';
      pagerRow.innerHTML = '';

      // 页码越界（例如筛选后总数变少）→ 收拢到最后一页重新拉取
      const limit = res.limit > 0 ? res.limit : 20;
      const totalPages = Math.max(1, Math.ceil(res.total / limit));
      if (res.total > 0 && this.historyPage > totalPages) {
        this.historyPage = totalPages;
        void this.loadHistoryList();
        return;
      }

      if (res.items.length === 0) {
        const empty = el(
          'div',
          undefined,
          this.historyIssueStatus ? '该状态下暂无反馈记录' : '暂无反馈记录',
        );
        empty.style.padding = '24px';
        empty.style.textAlign = 'center';
        empty.style.color = 'var(--fb-text-secondary)';
        itemsBox.append(empty);
      }

      // v13：简易 issue 列表 —— 当前页内按项目分组（页内多于一个项目时才出现分组头）
      for (const group of this.groupHistoryItems(res.items)) {
        if (group.label === null) {
          // 单项目且与组件锁定的 app-id 一致：不渲染分组头，项目身份已由宿主确定
          for (const item of group.items) {
            itemsBox.append(this.renderHistoryIssueRow(item, { showProjectChip: group.showInlineProjectChip }));
          }
          continue;
        }
        const section = el('div', 'fb-history-group');
        section.setAttribute('data-app-id', group.key);
        section.setAttribute('style', projectStyleVars(group.key));
        // role=group + aria-label：读屏用户按项目分段听取，色点仅作视觉线索
        section.setAttribute('role', 'group');
        section.setAttribute('aria-label', `项目 ${group.label}，${group.items.length} 条`);
        const head = el('div', 'fb-history-group-head');
        const headDot = el('span', 'fb-project-dot');
        headDot.setAttribute('aria-hidden', 'true');
        head.append(
          headDot,
          el('span', 'fb-history-group-name', group.label),
          el('span', 'fb-history-group-count', `${group.items.length} 条`),
        );
        head.setAttribute('data-project-color', projectColor(group.key));
        section.append(head);
        for (const item of group.items) {
          section.append(this.renderHistoryIssueRow(item, { showProjectChip: false }));
        }
        itemsBox.append(section);
      }

      // v12：分页控件（总数超过一页时才出现）
      if (res.total > limit) {
        const prevBtn = el('button', 'fb-btn-secondary fb-history-page-prev', '上一页');
        prevBtn.type = 'button';
        prevBtn.disabled = this.historyPage <= 1;
        prevBtn.addEventListener('click', () => {
          if (this.historyPage > 1) {
            this.historyPage--;
            void this.loadHistoryList();
          }
        });
        const nextBtn = el('button', 'fb-btn-secondary fb-history-page-next', '下一页');
        nextBtn.type = 'button';
        nextBtn.disabled = this.historyPage >= totalPages;
        nextBtn.addEventListener('click', () => {
          if (this.historyPage < totalPages) {
            this.historyPage++;
            void this.loadHistoryList();
          }
        });
        const pageInfo = el('span', 'fb-history-page-info', `第 ${this.historyPage} / ${totalPages} 页`);
        pagerRow.append(prevBtn, pageInfo, nextBtn);
      }
    } catch (err) {
      if (!current()) return;
      itemsBox.innerHTML = '';
      const errEl = el('div', 'fb-error');
      errEl.style.padding = '16px';
      errEl.style.textAlign = 'center';
      errEl.textContent = trackingErrorText(err, '加载失败');
      const retryBtn = el('button', 'fb-btn-secondary', '重试');
      retryBtn.type = 'button';
      retryBtn.style.marginTop = '8px';
      retryBtn.addEventListener('click', () => void this.loadHistoryList());
      errEl.append(document.createElement('br'), retryBtn);
      itemsBox.append(errEl);
    }
  }

  /**
   * v13：当前页内的项目分组。
   *
   * - 页内出现多于一个 appId：**按数据分组**（首次出现顺序），每组一个带色分组头，
   *   行内不再重复项目 chip。即使组件锁了 `app-id` 也照样分 —— 服务端返回了别的项目时，
   *   把差异暴露出来比遵守配置更重要（数据优先于配置）。
   * - 页内只有一个 appId：不渲染分组头；仅当它**不等于**组件锁定的 app-id 时才保留行内
   *   项目 chip（锁定时项目身份已由宿主确定，chip 属重复信息）。
   *
   * 分组只在当前页内做：分页、排序、总数都由服务端全局决定，客户端不重新分页，
   * 因此同一项目可能跨页各出现一个分组头（取舍说明见交付汇报）。
   */
  private groupHistoryItems(items: UserFeedbackListItem[]): HistoryProjectGroup[] {
    const order: string[] = [];
    const buckets = new Map<string, UserFeedbackListItem[]>();
    for (const item of items) {
      const key = normalizeAppId(item.appId);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(item);
      else {
        buckets.set(key, [item]);
        order.push(key);
      }
    }
    if (order.length > 1) {
      return order.map((key) => {
        const bucket = buckets.get(key) ?? [];
        return {
          key,
          label: projectDisplayName(bucket[0]?.appName, key),
          showInlineProjectChip: false,
          items: bucket,
        };
      });
    }
    const locked = normalizeAppId(this.appId);
    const only = order[0] ?? locked;
    return [
      {
        key: only,
        label: null,
        showInlineProjectChip: locked === '' || locked !== only,
        items,
      },
    ];
  }

  /** v13：单条反馈的 issue 行（保留 `.fb-history-item` / 标题 / 状态 / 未读 / 预览 / 日期锚点）。 */
  private renderHistoryIssueRow(
    item: UserFeedbackListItem,
    opts: { showProjectChip: boolean },
  ): HTMLElement {
    const appId = normalizeAppId(item.appId);
    const status = item.issueStatus;
    // 状态相关类名一律取自白名单，绝不把 issueStatus 原文拼进 className
    const rowModifier = ISSUE_ROW_MODIFIER_CLASS[status] ?? UNKNOWN_ISSUE_ROW_CLASS;
    const itemEl = el('div', `fb-history-item fb-issue-row ${rowModifier}`);
    itemEl.setAttribute('role', 'button');
    itemEl.setAttribute('tabindex', '0');
    itemEl.setAttribute('data-app-id', appId);
    itemEl.setAttribute('data-project-color', projectColor(appId));
    // --fb-project-color / --fb-project-chip-bg 供色点、左边框与 chip 背景使用（子元素继承）
    itemEl.setAttribute('style', projectStyleVars(appId));

    const row = el('div', 'fb-history-row');
    // 编号沿用历史口径：id 前 8 位等宽小字
    row.append(el('span', 'fb-history-id', `#${item.id.slice(0, 8)}`));
    row.append(el('span', 'fb-history-title', item.title || item.text || '（无标题）'));

    const tags = el('div', 'fb-history-tags');
    tags.append(
      el(
        'span',
        `fb-tag ${ISSUE_STATUS_TAG_CLASS[status] ?? ''}`.trim(),
        ISSUE_STATUS_LABELS[status] ?? status,
      ),
    );
    if (opts.showProjectChip) {
      const projectName = projectDisplayName(item.appName, appId);
      const dot = el('i', 'fb-project-dot');
      dot.setAttribute('aria-hidden', 'true');
      const chip = el('span', 'fb-tag fb-project-tag');
      chip.append(dot, el('span', 'fb-project-name', projectName));
      chip.setAttribute('title', projectName);
      tags.append(chip);
    }
    if (item.unread) tags.append(el('span', 'fb-badge', '未读'));
    row.append(tags);

    const meta = el('div', 'fb-history-date');
    // 计数一律先过 positiveCount：旧服务端缺字段 / null / NaN / 0 都不显示，避免出现 undefined、NaN、「0 图」
    const counts: string[] = [];
    const messageCount = positiveCount(item.messageCount);
    if (messageCount !== null) counts.push(`${messageCount} 条动态`);
    const imageCount = positiveCount(item.imageCount);
    if (imageCount !== null) counts.push(`${imageCount} 图`);
    const logCount = positiveCount(item.logCount);
    if (logCount !== null) counts.push(`${logCount} 日志`);
    // counts 为空时不要 append 一个 `counts.join(...)===''` 的空 span：
    // 它在 DOM 里是零内容节点，只会和下面的「暂无更新记录」占位重叠。
    if (counts.length > 0) meta.append(el('span', 'fb-history-meta', counts.join(' · ')));
    const time = historyTimeText(item);
    if (time) meta.append(el('span', 'fb-history-time', counts.length > 0 ? ` · 更新于 ${time}` : `更新于 ${time}`));
    if (counts.length === 0 && !time) meta.append(el('span', 'fb-history-meta', '暂无更新记录'));

    const preview = el(
      'div',
      'fb-history-preview',
      item.latestMessage
        ? `${item.latestMessage.senderType === 'admin' ? '管理员' : item.latestMessage.senderType === 'system' ? '系统' : '我'}: ${item.latestMessage.text || '附件'}`
        : item.text,
    );

    itemEl.append(row, preview, meta);
    itemEl.addEventListener('click', () => void this.openDialogue(item.id));
    itemEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        void this.openDialogue(item.id);
      }
    });
    return itemEl;
  }

  private clearDialogueDraft(): void {
    this.replyDraftEpoch++;
    this.dialogueReplyText = '';
    this.dialogueReplyLogs = [];
    this.clearReplyImages();
    this.replySending = false;
    this.replyDraftId = null;
  }

  private resetTrackingViews(): void {
    this.historyRequestSeq++;
    this.dialogueRequestSeq++;
    this.summaryRequestSeq++;
    this.stopDialoguePolling();
    this.stopSummaryPolling();
    this.activeDialogueId = null;
    this.dialogueMessagesBox = null;
    this.dialogueStatusBadge = null;
    this.dialogueSupported = false;
    this.submittedFeedbackEpoch = null;
    this.clearDialogueDraft();
    for (const draft of this.replyDrafts.values()) {
      for (const image of draft.images) URL.revokeObjectURL(image.url);
    }
    this.replyDrafts.clear();
    this.replyRequests.clear();
    this.replyErrors.clear();
    this.replyControls = null;
    this.dialogueRequestInFlight = 0;
    this.revokeAttachmentUrls();
    this.unreadCount = 0;
    if (this.dialogueView) {
      this.dialogueView.innerHTML = '';
      this.dialogueView.hidden = true;
      this.historyListView.innerHTML = '';
      this.historyListView.hidden = false;
    }
  }

  private async openDialogue(feedbackId: string): Promise<void> {
    if (this.replyDraftId !== feedbackId) {
      if (this.replyDraftId) {
        this.replyDrafts.set(this.replyDraftId, { text: this.dialogueReplyText, images: this.dialogueReplyImages, logs: this.dialogueReplyLogs });
      }
      const draft = this.replyDrafts.get(feedbackId);
      this.replyDrafts.delete(feedbackId);
      this.replyDraftEpoch++;
      this.replyDraftId = feedbackId;
      this.dialogueReplyText = draft?.text ?? '';
      this.dialogueReplyImages = draft?.images ?? [];
      this.dialogueReplyLogs = draft?.logs ?? [];
    }
    if (this.activeDialogueId !== feedbackId) {
      this.dialogueMessagesBox = null;
      this.dialogueStatusBadge = null;
      this.dialogueRenderedSeq = 0;
      this.revokeAttachmentUrls();
    }
    this.replySending = this.replyRequests.has(feedbackId);
    this.historyRequestSeq++;
    this.activeTab = 'history';
    this.activeDialogueId = feedbackId;
    this.stopSummaryPolling();
    this.historyListView.hidden = true;
    this.dialogueView.hidden = false;
    this.syncUi();
    this.startDialoguePolling();
    await this.loadDialogue(feedbackId);
  }

  private closeDialogue(): void {
    this.dialogueRequestSeq++;
    this.activeDialogueId = null;
    this.dialogueRenderedSeq = 0;
    this.dialogueMessagesBox = null;
    this.dialogueStatusBadge = null;
    this.revokeAttachmentUrls();
    this.stopDialoguePolling();
    this.startSummaryPolling();
    this.dialogueView.hidden = true;
    this.historyListView.hidden = false;
    void this.loadHistoryList();
  }

  private buildDialogueToolbar(feedbackId: string): HTMLDivElement {
    const toolbar = el('div', 'fb-dialogue-toolbar');
    const backBtn = el('button', 'fb-btn-secondary fb-dialogue-back', '← 返回列表');
    backBtn.type = 'button';
    backBtn.addEventListener('click', () => this.closeDialogue());
    const refreshBtn = el('button', 'fb-btn-secondary fb-dialogue-refresh', '刷新');
    refreshBtn.type = 'button';
    refreshBtn.setAttribute('aria-label', '刷新反馈进展');
    refreshBtn.addEventListener('click', () => void this.loadDialogue(feedbackId));
    toolbar.append(backBtn, refreshBtn);
    return toolbar;
  }

  /** 回收本次对话用过的 Bearer 附件对象 URL。 */
  private revokeAttachmentUrls(): void {
    for (const url of this.attachmentUrls) URL.revokeObjectURL(url);
    this.attachmentUrls.clear();
  }

  /** Bearer 取回附件并转对象 URL（v12：历史图片/日志绝不以裸 URL 渲染）。 */
  private async attachmentUrl(path: string): Promise<string> {
    const epoch = this.identityEpoch;
    const token = this.accessToken;
    const feedbackId = this.activeDialogueId;
    const blob = await fetchAttachmentBlob(this.effectiveApiBase!, this.accessToken!, path, { fetchFn: this.apiFetch });
    if (epoch !== this.identityEpoch || token !== this.accessToken || feedbackId !== this.activeDialogueId) throw new Error('附件上下文已变更');
    const url = URL.createObjectURL(blob);
    this.attachmentUrls.add(url);
    return url;
  }

  /** 以 Bearer 方式取回附件并渲染进 <img>（失败降级为文件名文本，不阻断消息）。 */
  private renderAttachmentImage(container: HTMLElement, path: string, alt: string): void {
    const img = el('img', 'fb-dialogue-attachment-img');
    img.alt = alt;
    img.style.maxHeight = '100px';
    img.style.borderRadius = '4px';
    img.style.cursor = 'pointer';
    const epoch = this.identityEpoch;
    void this.attachmentUrl(path)
      .then((url) => {
        if (epoch !== this.identityEpoch) return;
        img.src = url;
        img.addEventListener('click', () => this.openZoomModal(url));
      })
      .catch(() => {
        // 附件取回失败：保留占位文本，不弹出错误
        img.replaceWith(el('span', 'fb-muted', `${alt}（无法加载）`));
      });
    container.append(img);
  }

  /** 以 Bearer 方式取回附件并触发保存/下载（宿主 bridge / 浏览器下载）。 */
  private downloadAttachment(path: string, filename: string): void {
    const epoch = this.identityEpoch;
    fetchAttachmentBlob(this.effectiveApiBase!, this.accessToken!, path, { fetchFn: this.apiFetch })
      .then(async (blob) => {
        if (epoch !== this.identityEpoch) return;
        const mimeType = blob.type || 'application/octet-stream';
        let dataUrl: string | undefined;
        try {
          dataUrl = await blobToDataUrl(blob);
        } catch {
          /* 忽略 dataUrl 转换失败 */
        }
        await this.saveAttachment({ name: filename, mimeType, dataUrl }, blob);
      })
      .catch(() => {
        /* 下载失败静默（避免打断阅读；控制台无敏感信息） */
      });
  }

  /** 清空回复草稿图片（释放对象 URL）。 */
  private clearReplyImages(): void {
    for (const img of this.dialogueReplyImages) {
      if (img.url) URL.revokeObjectURL(img.url);
    }
    this.dialogueReplyImages = [];
  }

  private dialogueReplyText = '';
  private dialogueReplyLogs: File[] = [];
  private dialogueMessagesBox: HTMLDivElement | null = null;
  private dialogueStatusBadge: HTMLSpanElement | null = null;
  private dialogueResolutionNoteEl: HTMLParagraphElement | null = null;
  private dialogueNextStepEl: HTMLParagraphElement | null = null;
  private dialogueLoadErrorEl: HTMLParagraphElement | null = null;

  private syncReplyControls(): void {
    const controls = this.replyControls;
    if (!controls) return;
    const sending = this.replyRequests.has(controls.id);
    this.replySending = sending;
    controls.textarea.disabled = sending;
    controls.sendBtn.disabled = sending;
    controls.sendBtn.textContent = sending ? '发送中…' : '发送补充';
    controls.addImgBtn.disabled = sending;
    controls.addLogBtn.disabled = sending;
    controls.filesPreview.inert = sending;
    const error = this.replyErrors.get(controls.id);
    controls.replyError.textContent = error ?? '';
    controls.replyError.hidden = !error;
  }

  private async loadDialogue(feedbackId: string, isPolling = false): Promise<void> {
    if (!this.tokenValid() || !this.effectiveApiBase || this.activeDialogueId !== feedbackId) return;
    // 初次加载完成前轮询不启动第二个请求，避免替换加载中的详情。
    if (isPolling && (!this.dialogueMessagesBox || this.dialogueRequestInFlight)) return;
    const epoch = this.identityEpoch;
    const token = this.accessToken!;
    const apiBase = this.effectiveApiBase;
    const seq = ++this.dialogueRequestSeq;
    this.dialogueRequestInFlight = seq;
    const current = (): boolean => epoch === this.identityEpoch && token === this.accessToken && seq === this.dialogueRequestSeq && this.activeDialogueId === feedbackId && this.activeTab === 'history' && this.isConnected;
    if (!this.dialogueMessagesBox) {
      this.dialogueView.innerHTML = '';
      const loading = el('p', 'fb-muted', '加载反馈进展中…');
      loading.setAttribute('role', 'status');
      this.dialogueView.append(this.buildDialogueToolbar(feedbackId), loading);
    }

    try {
      const data = await getFeedbackDialogue(apiBase, token, feedbackId, { fetchFn: this.apiFetch });
      if (!current()) return;

      const maxSeq = data.messages.length > 0 ? Math.max(...data.messages.map((m) => m.seq)) : 0;
      if (maxSeq > data.lastReadSeq) {
        void markFeedbackRead(apiBase, token, feedbackId, maxSeq, { fetchFn: this.apiFetch })
          .then(() => { if (current()) void this.pollSummary(); })
          .catch(() => undefined);
      }

      if (this.dialogueMessagesBox && this.dialogueStatusBadge) {
        this.dialogueStatusBadge.textContent = ISSUE_STATUS_LABELS[data.feedback.issueStatus];
        this.dialogueStatusBadge.className = `fb-tag ${data.feedback.issueStatus.replace('_', '-')}`;
        if (this.dialogueNextStepEl) this.dialogueNextStepEl.textContent = ISSUE_NEXT_STEPS[data.feedback.issueStatus];
        if (this.dialogueLoadErrorEl) this.dialogueLoadErrorEl.hidden = true;
        if (this.dialogueResolutionNoteEl) {
          const note = [...data.messages].reverse().find((message) => message.resolutionNote)?.resolutionNote ?? data.feedback.resolutionNote;
          this.dialogueResolutionNoteEl.hidden = !note;
          this.dialogueResolutionNoteEl.textContent = note ? `最近处理说明：${note}` : '';
        }
        this.appendDialogueMessages(this.dialogueMessagesBox, data);
        return;
      }

      this.dialogueView.innerHTML = '';
      this.revokeAttachmentUrls();
      this.dialogueRenderedSeq = 0;
      const header = el('div', 'fb-dialogue-header');
      const titleEl = el('h3', 'fb-dialogue-title', data.feedback.title || data.feedback.text || '反馈详情');
      const meta = el('p', 'fb-dialogue-identity', `#${feedbackId.slice(0, 8)} · 创建于 ${new Date(data.feedback.createdAt).toLocaleString()}`);
      meta.title = feedbackId;
      this.dialogueStatusBadge = el('span', `fb-tag ${data.feedback.issueStatus.replace('_', '-')}`, ISSUE_STATUS_LABELS[data.feedback.issueStatus]);
      this.dialogueNextStepEl = el('p', 'fb-dialogue-next-step', ISSUE_NEXT_STEPS[data.feedback.issueStatus]);
      header.append(titleEl, meta, this.dialogueStatusBadge, this.dialogueNextStepEl);

      this.dialogueResolutionNoteEl = el('p', 'fb-resolution-note');
      const initialNote = [...data.messages].reverse().find((message) => message.resolutionNote)?.resolutionNote ?? data.feedback.resolutionNote;
      this.dialogueResolutionNoteEl.hidden = !initialNote;
      this.dialogueResolutionNoteEl.textContent = initialNote ? `最近处理说明：${initialNote}` : '';
      this.dialogueLoadErrorEl = el('p', 'fb-shot-error');
      this.dialogueLoadErrorEl.setAttribute('role', 'alert');
      this.dialogueLoadErrorEl.hidden = true;
      this.dialogueMessagesBox = el('div', 'fb-dialogue-messages');
      this.renderDialogueMessages(this.dialogueMessagesBox, data);
      this.dialogueMessagesBox.prepend(header, this.dialogueResolutionNoteEl);

      // 3. 回复编辑区（v12：多图附件，与新建反馈同一校验管线）
      const replyBox = el('div', 'fb-dialogue-reply-box');
      const replyDraftEpoch = this.replyDraftEpoch;
      const ownsDraft = (): boolean => epoch === this.identityEpoch && token === this.accessToken && this.replyDraftId === feedbackId && this.replyDraftEpoch === replyDraftEpoch;
      const textarea = el('textarea', 'fb-textarea');
      textarea.rows = 2;
      textarea.placeholder = '补充信息或询问进展…';
      textarea.setAttribute('aria-label', '补充反馈信息');
      textarea.value = this.dialogueReplyText;
      textarea.addEventListener('input', () => {
        if (!ownsDraft()) return;
        this.dialogueReplyText = textarea.value;
      });
      // 粘贴图片进回复草稿
      textarea.addEventListener('paste', (ev: ClipboardEvent) => {
        const files = Array.from(ev.clipboardData?.files ?? []).filter((f) =>
          /^image\//.test(f.type),
        );
        if (files.length === 0) return;
        ev.preventDefault();
        void addReplyImages(files);
      });

      // 附件选取与展示
      const attachRow = el('div');
      attachRow.style.display = 'flex';
      attachRow.style.gap = '8px';
      attachRow.style.alignItems = 'center';
      attachRow.style.flexWrap = 'wrap';

      const imgInput = el('input');
      imgInput.type = 'file';
      imgInput.accept = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
      imgInput.multiple = true;
      imgInput.hidden = true;

      const logInput = el('input');
      logInput.type = 'file';
      logInput.multiple = true;
      logInput.accept = '.log,.txt,.json,.jsonl';
      logInput.hidden = true;

      const addImgBtn = el('button', 'fb-btn-secondary', '添加图片');
      addImgBtn.type = 'button';

      addImgBtn.addEventListener('click', () => imgInput.click());

      const addLogBtn = el('button', 'fb-btn-secondary', '添加日志');
      addLogBtn.type = 'button';

      addLogBtn.addEventListener('click', () => logInput.click());

      const filesPreview = el('div', 'fb-reply-images');
      filesPreview.style.display = 'flex';
      filesPreview.style.gap = '4px';
      filesPreview.style.flexWrap = 'wrap';

      const replyError = el('p', 'fb-shot-error');
      replyError.hidden = true;
      replyError.setAttribute('role', 'alert');

      const updateFilesPreview = (): void => {
        filesPreview.innerHTML = '';
        this.dialogueReplyImages.forEach((img) => {
          const cell = el('span', 'fb-reply-thumb');
          const thumb = el('img', 'fb-reply-thumb-img');
          thumb.src = img.url;
          thumb.alt = `回复图片：${img.filename}`;
          thumb.title = img.filename;
          thumb.addEventListener('click', () => this.openZoomModal(img.url));
          const editBtn = el('button', 'fb-thumb-edit', '编辑');
          editBtn.type = 'button';
          editBtn.setAttribute('aria-label', `编辑回复图片 ${img.filename}`);
          editBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            void this.openReplyEditor(img.id, updateFilesPreview);
          });
          const del = el('button', 'fb-thumb-remove', '✕');
          del.type = 'button';
          del.setAttribute('aria-label', `移除回复图片 ${img.filename}`);
          del.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.removeReplyImage(img.id);
            updateFilesPreview();
          });
          cell.append(thumb, editBtn, del);
          filesPreview.append(cell);
        });
        this.dialogueReplyLogs.forEach((file, idx) => {
          const tag = el('button', 'fb-btn-secondary fb-reply-log', `${file.name} ✕`);
          tag.type = 'button';
          tag.setAttribute('aria-label', `移除回复日志 ${file.name}`);
          tag.style.cursor = 'pointer';
          tag.addEventListener('click', () => {
            this.dialogueReplyLogs.splice(idx, 1);
            updateFilesPreview();
          });
          filesPreview.append(tag);
        });
      };

      const addReplyImages = async (files: Blob[] | File[]): Promise<void> => {
        if (this.replySending) return;
        const draftEpoch = this.replyDraftEpoch;
        const currentDraft = (): boolean => epoch === this.identityEpoch && token === this.accessToken && draftEpoch === this.replyDraftEpoch && this.activeDialogueId === feedbackId;
        replyError.hidden = true;
        for (const file of files) {
          if (this.dialogueReplyImages.length >= this.maxImages) {
            replyError.hidden = false;
            replyError.textContent = `回复最多附加 ${this.maxImages} 张图片`;
            break;
          }
          const name = file instanceof File ? file.name : '';
          try {
            const prepared = await prepareImageForUpload(file);
            if (!currentDraft() || this.replySending) return;
            this.dialogueReplyImages.push({
              id: uuid(),
              blob: prepared.blob,
              url: URL.createObjectURL(prepared.blob),
              source: 'manual',
              origin: 'manual',
              filename: normalizeImageFilename(name, prepared.mime, `reply-${this.dialogueReplyImages.length + 1}.png`),
              mime: prepared.mime,
              width: prepared.width,
              height: prepared.height,
              oversize: prepared.oversize,
            });
          } catch {
            if (!currentDraft()) return;
            replyError.hidden = false;
            replyError.textContent = `${name || '所选图片'}：仅支持 PNG / JPEG / WebP 静态图片`;
          }
        }
        updateFilesPreview();
      };

      imgInput.addEventListener('change', () => {
        const files = Array.from(imgInput.files ?? []);
        imgInput.value = '';
        void addReplyImages(files);
      });

      logInput.addEventListener('change', () => {
        if (!ownsDraft() || this.replyRequests.has(feedbackId)) return;
        if (logInput.files) {
          for (const file of Array.from(logInput.files)) {
            this.dialogueReplyLogs.push(file);
          }
          logInput.value = '';
          updateFilesPreview();
        }
      });

      updateFilesPreview();

      const sendBtn = el('button', 'fb-submit', '发送补充');
      sendBtn.type = 'button';
      sendBtn.style.marginTop = '4px';
      sendBtn.addEventListener('click', async () => {
        if (this.replyRequests.has(feedbackId) || epoch !== this.identityEpoch || token !== this.accessToken || this.activeDialogueId !== feedbackId) return;
        const draftText = textarea.value;
        const text = draftText.trim();
        const images = this.dialogueReplyImages;
        const logs = this.dialogueReplyLogs;
        if (!text && images.length === 0 && logs.length === 0) return;
        this.replyRequests.add(feedbackId);
        this.replyErrors.delete(feedbackId);
        this.syncReplyControls();
        let sent = false;
        try {
          await sendFeedbackReply(apiBase, token, feedbackId, {
            text,
            images: images.length > 0 ? images.map(toImageInput) : undefined,
            logs: logs.length > 0 ? [...logs] : undefined,
          }, { fetchFn: this.apiFetch });
          if (epoch !== this.identityEpoch || token !== this.accessToken) return;
          sent = true;
          // 请求归属按反馈 ID 与原草稿引用判断；导航不会清空另一个问题的草稿。
          if (this.replyDraftId === feedbackId && this.dialogueReplyText === draftText && this.dialogueReplyImages === images && this.dialogueReplyLogs === logs) {
            this.dialogueReplyText = '';
            this.clearReplyImages();
            this.dialogueReplyLogs = [];
            if (this.replyControls?.id === feedbackId) {
              this.replyControls.textarea.value = '';
              this.replyControls.updateFilesPreview();
            }
          } else {
            const draft = this.replyDrafts.get(feedbackId);
            if (draft?.text === draftText && draft.images === images && draft.logs === logs) {
              for (const image of draft.images) URL.revokeObjectURL(image.url);
              this.replyDrafts.delete(feedbackId);
            }
          }
        } catch (err) {
          if (epoch === this.identityEpoch && token === this.accessToken) {
            this.replyErrors.set(feedbackId, trackingErrorText(err, '发送失败'));
          }
        } finally {
          if (epoch === this.identityEpoch && token === this.accessToken) {
            this.replyRequests.delete(feedbackId);
            this.syncReplyControls();
          }
        }
        if (sent && epoch === this.identityEpoch && token === this.accessToken) {
          if (this.activeDialogueId === feedbackId) await this.loadDialogue(feedbackId);
          void this.pollSummary();
        }
      });
      this.replyControls = { id: feedbackId, textarea, sendBtn, addImgBtn, addLogBtn, filesPreview, replyError, updateFilesPreview };
      this.syncReplyControls();

      attachRow.append(imgInput, logInput, addImgBtn, addLogBtn);
      replyBox.append(el('label', 'fb-reply-label', '继续补充'), textarea, filesPreview, replyError, attachRow, sendBtn);

      this.dialogueView.append(this.buildDialogueToolbar(feedbackId), this.dialogueLoadErrorEl, this.dialogueMessagesBox, replyBox);
    } catch (err) {
      if (!current()) return;
      const message = trackingErrorText(err, '加载反馈进展失败');
      if (this.dialogueMessagesBox && this.dialogueLoadErrorEl) {
        this.dialogueLoadErrorEl.textContent = `刷新失败：${message}。可点「刷新」重试，补充内容已保留。`;
        this.dialogueLoadErrorEl.hidden = false;
      } else {
        this.dialogueView.innerHTML = '';
        const errEl = el('p', 'fb-shot-error', `加载反馈进展失败：${message}`);
        errEl.setAttribute('role', 'alert');
        const retryBtn = el('button', 'fb-btn-secondary fb-dialogue-retry', '重试');
        retryBtn.type = 'button';
        retryBtn.addEventListener('click', () => void this.loadDialogue(feedbackId));
        this.dialogueView.append(this.buildDialogueToolbar(feedbackId), errEl, retryBtn);
      }
    } finally {
      if (this.dialogueRequestInFlight === seq) this.dialogueRequestInFlight = 0;
    }
  }

  /** 移除一张回复草稿图片（释放对象 URL）。 */
  private removeReplyImage(id: string): void {
    const idx = this.dialogueReplyImages.findIndex((i) => i.id === id);
    if (idx === -1) return;
    const [img] = this.dialogueReplyImages.splice(idx, 1);
    if (img?.url) URL.revokeObjectURL(img.url);
  }

  /** 编辑回复草稿图片：保存原位替换（不占名额），取消不动。 */
  private async openReplyEditor(id: string, refresh: () => void): Promise<void> {
    if (this.editorHandle) return;
    const img = this.dialogueReplyImages.find((i) => i.id === id);
    if (!img) return;
    const epoch = this.identityEpoch;
    try {
      const decoded = await decodeImage(img.blob);
      if (epoch !== this.identityEpoch) return;
      this.editorHandle = openImageEditor({
        image: decoded.source,
        width: decoded.width,
        height: decoded.height,
        mount: this.root,
        onCancel: () => {
          this.editorHandle = null;
          decoded.close?.();
        },
        onSave: async (canvas) => {
          const prepared = await exportEditedImage(canvas);
          if (epoch !== this.identityEpoch || !this.dialogueReplyImages.includes(img)) return;
          if (!prepared) return;
          URL.revokeObjectURL(img.url);
          img.blob = prepared.blob;
          img.url = URL.createObjectURL(prepared.blob);
          img.source = 'edited';
          img.mime = prepared.mime;
          img.width = prepared.width;
          img.height = prepared.height;
          img.oversize = prepared.oversize;
          img.filename = normalizeImageFilename(img.filename, prepared.mime, `edited-${img.id}.png`);
          this.editorHandle?.close();
          this.editorHandle = null;
          decoded.close?.();
          refresh();
        },
      });
    } catch {
      /* 解码失败：保持原图，可重试 */
    }
  }

  /**
   * 渲染完整对话（非轮询 / 首次打开）：清空后重建原始反馈块 + 全部消息，
   * 记录已渲染的最大 seq 供增量追加。
   */
  private renderDialogueMessages(container: HTMLDivElement, data: FeedbackDialogueResponse): void {
    container.innerHTML = '';
    this.dialogueRenderedSeq = 0;

    // 原始用户反馈
    const orig = el('div', 'fb-dialogue-msg user');
    const origMeta = el('div', 'fb-dialogue-msg-meta');
    origMeta.append(
      el('span', undefined, '我 (原始反馈)'),
      el('span', undefined, new Date(data.feedback.createdAt).toLocaleString()),
    );
    const origText = el('div', undefined, data.feedback.text);
    origText.style.whiteSpace = 'pre-wrap';
    orig.append(origMeta, origText);

    // v12：有序图片列表（历史单图记录经兼容读取进入同一列表；旧字段 screenshot 兜底）
    const images = Array.isArray(data.feedback.images) ? data.feedback.images : [];
    if (images.length > 0) {
      const imgWrap = el('div', 'fb-dialogue-attachments');
      imgWrap.style.marginTop = '6px';
      imgWrap.style.display = 'flex';
      imgWrap.style.gap = '6px';
      imgWrap.style.flexWrap = 'wrap';
      for (const img of images) {
        this.renderAttachmentImage(
          imgWrap,
          `/api/feedback/${data.feedback.id}/images/${img.id}`,
          img.filename || '反馈图片',
        );
      }
      orig.append(imgWrap);
    } else if (data.feedback.screenshot) {
      // 旧服务端无 images 列表：单图端点同样走 Bearer fetch
      this.renderAttachmentImage(
        orig,
        `/api/feedback/${data.feedback.id}/screenshot`,
        '反馈截图',
      );
    }

    if (data.feedback.logs && data.feedback.logs.length > 0) {
      const logsWrap = el('div');
      logsWrap.style.marginTop = '6px';
      logsWrap.style.display = 'flex';
      logsWrap.style.gap = '6px';
      logsWrap.style.flexWrap = 'wrap';
      for (const l of data.feedback.logs) {
        const logBtn = el('button', 'fb-btn-secondary', `${l.filename} (${formatBytes(l.byteSize)})`);
        logBtn.type = 'button';
        logBtn.style.fontSize = '11px';
        logBtn.style.padding = '2px 6px';
        const path = `/api/feedback/${data.feedback.id}/logs/${l.id}/download`;
        logBtn.addEventListener('click', () => this.downloadAttachment(path, l.filename));
        logsWrap.append(logBtn);
      }
      orig.append(logsWrap);
    }

    container.append(orig);
    this.appendDialogueMessages(container, data);
    // 首次从标题与原始反馈开始阅读；轮询只增量追加。
    container.scrollTop = 0;
  }

  /**
   * 增量渲染（轮询）：只追加 seq 更大的新消息；用户正在阅读时不强跳滚动
   * （已在底部才跟随到底），回复草稿与滚动位置保持不动。
   */
  private appendDialogueMessages(container: HTMLDivElement, data: FeedbackDialogueResponse): void {
    const atBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 8;
    let appended = false;

    for (const msg of data.messages) {
      if (msg.seq <= this.dialogueRenderedSeq) continue;
      this.dialogueRenderedSeq = Math.max(this.dialogueRenderedSeq, msg.seq);
      appended = true;
      const cls =
        msg.senderType === 'admin'
          ? 'fb-dialogue-msg admin'
          : msg.senderType === 'system'
            ? 'fb-dialogue-msg system'
            : 'fb-dialogue-msg user';
      const msgEl = el('div', cls);
      const meta = el('div', 'fb-dialogue-msg-meta');
      const senderLabel =
        msg.senderType === 'admin'
          ? `管理员 (${msg.senderName})`
          : msg.senderType === 'system'
            ? '系统'
            : `我 (#${msg.seq})`;
      meta.append(el('span', undefined, senderLabel), el('span', undefined, new Date(msg.createdAt).toLocaleString()));
      const text = el('div', undefined, msg.text);
      text.style.whiteSpace = 'pre-wrap';
      msgEl.append(meta, text);

      // v12：处理说明随消息（解决/请求补充时管理员填写）对用户可见
      if (msg.resolutionNote && msg.resolutionNote !== msg.text) {
        const note = el('div', 'fb-resolution-note', `处理说明：${msg.resolutionNote}`);
        msgEl.append(note);
      }

      if (msg.attachments && msg.attachments.length > 0) {
        const attWrap = el('div');
        attWrap.style.marginTop = '6px';
        attWrap.style.display = 'flex';
        attWrap.style.gap = '6px';
        attWrap.style.flexWrap = 'wrap';

        for (const att of msg.attachments) {
          const path = `/api/feedback/messages/attachments/${att.id}`;
          if (att.kind === 'screenshot' || att.kind === 'image') {
            // v12：图片附件一律 Bearer fetch → 对象 URL（跨源无凭据 401）
            this.renderAttachmentImage(attWrap, path, att.filename || '附件图片');
          } else {
            const link = el('button', 'fb-btn-secondary', `${att.filename} (${formatBytes(att.byteSize)})`);
            link.type = 'button';
            link.style.fontSize = '11px';
            link.style.padding = '2px 6px';
            link.addEventListener('click', () => this.downloadAttachment(path, att.filename));
            attWrap.append(link);
          }
        }
        msgEl.append(attWrap);
      }
      container.append(msgEl);
    }

    // 有新消息且用户在底部时才跟随滚动；否则保留阅读位置
    if (appended && atBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }

  // ---------- 日志附件处理 ----------

  /** 日志摘要行文案（T4）：默认只显示「已附诊断日志 / 暂无日志」这类简短摘要。 */
  private logsSummaryText(): string {
    if (this.logsCollecting) return '正在采集诊断日志…';
    if (this.draft.logs.length > 0) return `已附诊断日志（${this.draft.logs.length}）`;
    if (this.draft.logsCollected) return '暂无日志';
    return '诊断日志';
  }

  private setLogsOpen(open: boolean): void {
    this.logsOpen = open;
    if (this.logsBody) this.logsBody.hidden = !open;
    if (this.logsToggleBtn) this.logsToggleBtn.setAttribute('aria-expanded', String(open));
  }

  private toggleLogs(): void {
    this.setLogsOpen(!this.logsOpen);
  }

  private async collectLogs(): Promise<void> {
    const provider = this._logProvider;
    if (!provider || this.logsCollecting) return;
    const epoch = this.identityEpoch;
    const draft = this.draft;
    const opSeq = ++this.logOpSeq;
    this.logsCollecting = true;
    this.logStatusEl.hidden = false;
    this.logStatusEl.textContent = '正在自动采集日志…';
    this.logErrorEl.hidden = true;
    this.logErrorEl.textContent = '';
    this.syncLogsUi();

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const clearOwnTimeout = (): void => {
      if (timeoutId !== null && this.logTimeout === timeoutId) {
        clearTimeout(timeoutId);
        this.logTimeout = null;
      }
    };
    // SDK 自身产生的超时错误（身份比对用）：provider 抛出的任意 message 绝不直接展示。
    const timeoutErr = new Error('采集日志超时（超过 3 秒）');
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(timeoutErr), 3000);
        this.logTimeout = timeoutId;
      });
      const providerPromise = Promise.resolve(provider());
      const res = await Promise.race([providerPromise, timeoutPromise]);
      clearOwnTimeout();

      if (
        !this.isConnected ||
        this.draft !== draft ||
        epoch !== this.identityEpoch ||
        opSeq !== this.logOpSeq ||
        !this.openState ||
        this.phase === 'submitting'
      ) {
        return;
      }

      let attached = 0;
      let rejected = false;
      if (res) {
        const rawFiles = Array.isArray(res) ? res : [res];
        for (const file of rawFiles) {
          if (!file || !file.filename || !file.blob) continue;
          if (this.draft.logs.length >= MAX_LOG_FILES) {
            rejected = true;
            this.logErrorEl.hidden = false;
            this.logErrorEl.textContent = `最多附加 ${MAX_LOG_FILES} 个日志文件`;
            break;
          }
          const ext = getLogExtension(file.filename);
          if (!ALLOWED_LOG_EXTENSIONS.has(ext)) {
            rejected = true;
            this.logErrorEl.hidden = false;
            this.logErrorEl.textContent = `日志 ${file.filename} 格式不受支持（仅支持 .log / .txt / .json / .jsonl）`;
            continue;
          }
          if (file.blob.size > MAX_LOG_BYTES) {
            rejected = true;
            this.logErrorEl.hidden = false;
            this.logErrorEl.textContent = `日志 ${file.filename} 超过 1MiB 限制`;
            continue;
          }
          if (file.blob.size === 0) {
            rejected = true;
            this.logErrorEl.hidden = false;
            this.logErrorEl.textContent = `日志 ${file.filename} 不能为空文件`;
            continue;
          }
          this.draft.logs.push({
            filename: file.filename,
            source: 'auto',
            blob: file.blob,
            byteSize: file.blob.size,
          });
          this.draft.version++;
          attached++;
        }
      }
      if (
        !this.isConnected ||
        this.draft !== draft ||
        epoch !== this.identityEpoch ||
        opSeq !== this.logOpSeq ||
        !this.openState
      ) {
        return;
      }
      this.draft.logsCollected = true;
      if (attached > 0) {
        this.logStatusEl.hidden = false;
        this.logStatusEl.textContent = '已附诊断日志';
      } else if (!rejected) {
        // provider 成功但返回空（null / undefined / 空数组 / 全部被跳过）
        this.logStatusEl.hidden = false;
        this.logStatusEl.textContent = '当前会话暂无日志';
      } else {
        // 有文件但全部因校验失败被拒：错误文案已在 logErrorEl 展示
        this.logStatusEl.hidden = true;
        this.logStatusEl.textContent = '';
      }
    } catch (err: unknown) {
      clearOwnTimeout();
      if (
        !this.isConnected ||
        this.draft !== draft ||
        epoch !== this.identityEpoch ||
        opSeq !== this.logOpSeq ||
        !this.openState ||
        this.phase === 'submitting'
      ) {
        return;
      }
      // provider 抛出的 err.message 可能含任意文本，不直接展示；
      // SDK 自身的超时错误保留「超时」字样以兼容既有提示。
      const msg = err === timeoutErr ? '日志获取失败，可继续提交（采集超时）' : '日志获取失败，可继续提交';
      this.logErrorEl.hidden = false;
      this.logErrorEl.textContent = msg;
      this.logErrorEl.append(this.logRetryBtn); // 显式重试入口
      this.logStatusEl.hidden = true;
      this.logStatusEl.textContent = '';
    } finally {
      clearOwnTimeout();
      if (this.isConnected && this.draft === draft && epoch === this.identityEpoch && opSeq === this.logOpSeq) {
        this.logsCollecting = false;
        this.syncLogsUi();
        this.syncUi();
      }
    }
  }

  private handleLogFileSelect(): void {
    if (this.phase === 'submitting') return;
    const files = Array.from(this.logFileInput.files || []);
    if (files.length === 0) return;
    this.logErrorEl.hidden = true;
    this.logErrorEl.textContent = '';

    for (const file of files) {
      if (this.draft.logs.length >= MAX_LOG_FILES) {
        this.logErrorEl.hidden = false;
        this.logErrorEl.textContent = `最多附加 ${MAX_LOG_FILES} 个日志文件`;
        break;
      }
      const ext = getLogExtension(file.name);
      if (!ALLOWED_LOG_EXTENSIONS.has(ext)) {
        this.logErrorEl.hidden = false;
        this.logErrorEl.textContent = `日志 ${file.name} 格式不受支持（仅支持 .log / .txt / .json / .jsonl）`;
        continue;
      }
      if (file.size > MAX_LOG_BYTES) {
        this.logErrorEl.hidden = false;
        this.logErrorEl.textContent = `日志 ${file.name} 超过 1MiB 限制`;
        continue;
      }
      if (file.size === 0) {
        this.logErrorEl.hidden = false;
        this.logErrorEl.textContent = `日志 ${file.name} 不能为空文件`;
        continue;
      }
      this.draft.logs.push({
        filename: file.name,
        source: 'manual',
        blob: file,
        byteSize: file.size,
      });
      this.draft.version++;
    }
    this.logFileInput.value = '';
    this.syncLogsUi();
    this.syncUi();
  }

  private removeLog(index: number): void {
    if (index >= 0 && index < this.draft.logs.length) {
      this.draft.logs.splice(index, 1);
      this.draft.version++;
      // 删空后「已附诊断日志」提示不再成立（不重新自动附加：logsCollected 语义保持）。
      if (this.draft.logs.length === 0 && !this.logsCollecting) {
        this.logStatusEl.hidden = true;
        this.logStatusEl.textContent = '';
      }
      this.syncLogsUi();
      this.syncUi();
    }
  }

  private async openLogPreview(log: FeedbackLogAttachment): Promise<void> {
    this.logPreviewTitle.textContent = log.filename;
    this.logPreviewBody.textContent = '读取中…';
    this.logPreviewModal.classList.add('is-open');
    try {
      const text = await readBlobText(log.blob);
      this.logPreviewBody.textContent = text;
    } catch {
      this.logPreviewBody.textContent = '读取日志内容失败';
    }
  }

  private closeLogPreview(): void {
    if (this.logPreviewModal) {
      this.logPreviewModal.classList.remove('is-open');
    }
  }

  private syncLogsUi(): void {
    const logs = this.draft.logs;
    this.logsCountEl.textContent = ` (${logs.length}/${MAX_LOG_FILES})`;

    const busy = this.phase === 'submitting' || this.polling || this.logsCollecting;
    // T4：默认只显示简短摘要；「重新采集」仅在配置了 logProvider 且空闲时可用。
    this.logsSummaryEl.textContent = this.logsSummaryText();
    this.recollectLogBtn.hidden = !this._logProvider || busy;
    this.recollectLogBtn.disabled = busy;
    this.setLogsOpen(this.logsOpen);
    // 错误必须让用户看见：日志区处于折叠态时有错误 → 自动展开
    if (!this.logErrorEl.hidden) this.setLogsOpen(true);
    this.addLogBtn.disabled = busy || logs.length >= MAX_LOG_FILES;
    this.addLogBtn.hidden = logs.length >= MAX_LOG_FILES;
    this.logRetryBtn.disabled = busy;

    this.logsList.innerHTML = '';
    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];
      if (!log) continue;
      const li = el('li', 'fb-log-item');

      const info = el('div', 'fb-log-info');
      const name = el('span', 'fb-log-name', log.filename);
      name.title = log.filename;
      const badge = el('span', 'fb-log-badge', log.source === 'auto' ? '自动' : '手动');
      const size = el('span', 'fb-log-size', formatBytes(log.byteSize || log.blob.size));
      info.append(name, badge, size);

      const btns = el('div', 'fb-log-btns');
      const previewBtn = el('button', 'fb-log-btn-preview', '预览');
      previewBtn.type = 'button';
      previewBtn.setAttribute('aria-label', `预览 ${log.filename}`);
      previewBtn.addEventListener('click', () => {
        void this.openLogPreview(log);
      });

      const removeBtn = el('button', 'fb-log-btn-remove', '删除');
      removeBtn.type = 'button';
      removeBtn.setAttribute('aria-label', `删除 ${log.filename}`);
      removeBtn.disabled = busy;
      removeBtn.addEventListener('click', () => {
        this.removeLog(i);
      });

      btns.append(previewBtn, removeBtn);
      li.append(info, btns);
      this.logsList.append(li);
    }
  }

  // ---------- 提交流程与认证 ----------

  private tokenValid(): boolean {
    return this.accessToken !== null && Date.now() < this.tokenExpiresAt;
  }

  private failPhase(message: string): void {
    this.phase = 'failed';
    this.lastErrorSummary = message;
    this.renderStatus('');
    this.syncUi();
  }

  private async onPrimaryAction(): Promise<void> {
    if (this.phase === 'submitting' || this.polling) return;

    if (!this.tokenValid()) {
      // 未登录：开始登录，并在登录完成后自动提交
      const len = codePointLength(this.textarea.value);
      if (len === 0) {
        this.textarea.focus();
        return;
      }
      this.beginLogin(true);
      return;
    }

    await this.submit();
  }

  /** 4xx 视为服务端明确处理并拒绝（未保存）；其余（网络错误/5xx/408/429）结果未知。 */
  private isUnknownOutcome(err: unknown): boolean {
    if (err instanceof ApiError) {
      return err.status >= 500 || err.status === 408 || err.status === 429;
    }
    return true;
  }

  private async submit(): Promise<void> {
    if (this.phase === 'submitting') return; // 提交期间禁止重复提交

    // 身份世代：提交结果 / 错误只在身份未变时生效（旧服务的响应绝不写入新身份）
    const epoch = this.identityEpoch;
    const apiBase = this.effectiveApiBase;
    const appId = this.appId;
    if (!apiBase || !appId) {
      this.failPhase('缺少必填配置：api-base / app-id');
      return;
    }

    // 额度用尽禁止新提交；但结果未知的同键请求仍允许重试（可能已被服务端接收）。
    const draftImages = this.draft.images.map(toImageInput);
    const snap0 = this.submitSnapshot;
    const retryingUnknown =
      snap0 !== null &&
      snap0.unknownOutcome &&
      snap0.draftVersion === this.draft.version &&
      snap0.text === this.textarea.value &&
      areImagesEqual(snap0.images, draftImages) &&
      areLogsEqual(snap0.logs, this.draft.logs);
    if (
      this.quota !== null &&
      this.quota.unlimited !== true &&
      this.quota.remaining <= 0 &&
      !retryingUnknown
    ) {
      this.phase = 'quota';
      this.lastErrorSummary = '今日提交次数已用完，请在额度刷新后重试。文字与图片已保留。';
      this.renderStatus('');
      this.syncUi();
      return;
    }

    // v12 能力降级：服务端明确不支持多图（capabilities.images 缺失）时，
    // 单图仍按旧 screenshot 字段提交；多图不静默丢弃——明确提示并保留草稿。
    if (this.draft.images.length > this.maxImages) {
      this.failPhase(
        `当前服务端仅支持单张图片（已选择 ${this.draft.images.length} 张）：` +
          '请移除多余图片，或升级服务端后再提交。图片与文字已保留。',
      );
      return;
    }

    // ---- 冻结快照：请求标识 / 应用与来源 / 原话 / 图片字节 / 元数据 / 草稿版本 ----
    // 草稿未变 → 复用现有快照（重试走同 key 同字节）；
    // 草稿已变且原请求结果未知 → 先保留原请求供核对，再冻结新快照。
    let snap = this.submitSnapshot;
    const snapshotMatchesDraft =
      snap !== null &&
      snap.draftVersion === this.draft.version &&
      snap.text === this.textarea.value &&
      areImagesEqual(snap.images, draftImages) &&
      areLogsEqual(snap.logs, this.draft.logs) &&
      snap.apiBase === apiBase &&
      snap.appId === appId;
    if (!snap || !snapshotMatchesDraft) {
      if (snap && snap.unknownOutcome) {
        this.unconfirmedRequest = {
          key: snap.key,
          capturedAt: snap.captureInfo?.capturedAt ?? null,
          textSummary: snap.text.slice(0, 40),
        };
      }
      const text = this.textarea.value;
      const len = codePointLength(text);
      if (len < 1 || len > MAX_TEXT) {
        this.failPhase(`反馈内容需为 1–${MAX_TEXT} 字`);
        return;
      }
      const context: FeedbackContext = {};
      if (this.appVersion) context.appVersion = this.appVersion;
      if (this.pageLabel) context.pageLabel = this.pageLabel;
      const captureImg = this.captureImage();
      snap = {
        key: uuid(),
        apiBase,
        appId,
        context,
        text,
        images: draftImages,
        captureInfo: captureImg?.captureInfo ? { ...captureImg.captureInfo } : null,
        logs: [...this.draft.logs],
        draftVersion: this.draft.version,
        unknownOutcome: false,
      };
      this.submitSnapshot = snap;
      this.idempotencyKey = snap.key;
    }
    const frozen = snap;
    this.lastSubmittedText = frozen.text;

    if (!this.tokenValid()) {
      this.beginLogin(true);
      return;
    }

    // 冻结后不允许任何迟到的捕获会话再写草稿
    this.invalidateCaptureSession();
    this.captureInFlight = null;
    this.restoreCaptureUi();

    this.phase = 'submitting';
    this.lastErrorSummary = null;
    this.waitingNotice = null; // 新一轮提交：清除上一条记录的等待提示
    this.renderStatus('提交中…');
    this.syncUi();

    // 请求发出时捕获实际使用的令牌（T1-A）：401 是否清理凭据以它为准，
    // 而不是响应到达时刻的"当前"令牌。
    const usedToken = this.accessToken as string;
    try {
      // HTTP 只读快照：提交期间的草稿变化不影响本次请求字节
      // v12：多图走 images[]（有序描述符 + 部件）；单图保留旧 screenshot
      // 字段（旧服务端同样可收）；无图则纯文本/日志。
      //
      // 多图提交前一次性能力校准：能力未确认时探测 GET /api/features。
      // 探测成功但响应无 images → 单图服务端，阻止提交并提示升级；
      // 探测失败（404 / 网络错误 / 非 200）→ 保持未确认，乐观提交
      // （成功则服务端确实支持多图，不会再判单图）。
      if (!this.capabilitiesKnown && frozen.images.length >= 2) {
        await this.probeFeatures();
        if (epoch !== this.identityEpoch) return;
        if (this.capabilitiesKnown && frozen.images.length > this.maxImages) {
          // 已确认单图服务端：不发出必然 400 的歧义请求；草稿与快照保留，
          // 按「未接收」失败卡处理（用户删图后点重试即走旧字段提交）。
          this.phase = 'failed';
          frozen.unknownOutcome = false;
          this.lastErrorSummary = `当前服务端最多支持 ${this.maxImages} 张图片。请删除多余图片后重试，或升级服务端以支持多图。`;
          this.renderStatus('');
          this.syncUi();
          return;
        }
      }
      const useImagesField = frozen.images.length >= 2;
      const res = await submitFeedback(frozen.apiBase, this.accessToken as string, {
        idempotencyKey: frozen.key,
        appId: frozen.appId,
        ...(this.appName ? { appName: this.appName } : {}),
        text: frozen.text,
        ...(Object.keys(frozen.context).length ? { context: frozen.context } : {}),
        ...(frozen.captureInfo ? { capture: frozen.captureInfo } : {}),
        ...(useImagesField
          ? { images: frozen.images }
          : frozen.images[0]
            ? { screenshot: frozen.images[0].blob }
            : {}),
        ...(frozen.logs.length > 0 ? { logs: frozen.logs } : {}),
      }, { fetchFn: this.apiFetch });

      // 201/200 后才清空输入与截图，快照随之消费
      // 身份已切换 → 结果为旧服务所有：不写任务态、不清草稿、不派发事件、不轮询
      if (epoch !== this.identityEpoch) return;
      // 提交已扣次：使此前的额度查询失效，旧查询不得把剩余次数加回。
      this.invalidateQuotaRefresh();
      if (res.quota) this.quota = res.quota;
      if (res.user) this.authUser = res.user;
      this.lastFeedbackId = res.feedbackId;
      this.submittedFeedbackEpoch = epoch;
      this.submitSnapshot = null;
      this.idempotencyKey = null;
      this.unconfirmedRequest = null;
      this.clearDraft();
      this.textarea.value = '';
      this.authRequired = false;
      this.lastRecord = {
        id: res.feedbackId,
        status: res.status,
        createdAt: '',
        updatedAt: '',
        errorSummary: null,
        kaneoUrl: null,
      };
      this.phase = 'tracking';
      // T4：等待管理员配置/确认/归档同样属于「已保存」，但**不再轮询**——
      // 明确提示等待什么，保留手动刷新；只有真正在处理中才继续跟踪。
      this.waitingNotice = collectionWaitingText(res.collectionState);
      this.renderStatus(this.waitingNotice ?? '已保存，正在整理');
      this.dispatchEvent(
        new CustomEvent<FeedbackSubmittedDetail>('feedback-submitted', {
          detail: { feedbackId: res.feedbackId, status: res.status, replayed: res.replayed === true },
          bubbles: true,
          composed: true,
        }),
      );
      this.syncUi();
      if (this.waitingNotice === null) {
        this.startPolling(res.feedbackId);
      }
      this.consumeQuotaRefreshIntent(); // 提交忙碌结束：补发被挡下的刷新
    } catch (err) {
      // 身份已切换 → 旧服务的失败同样不得改写新身份的状态（含 401 清令牌）
      if (epoch !== this.identityEpoch) return;
      if (err instanceof ApiError && err.status === 401) {
        if (usedToken !== this.accessToken) {
          // T1-A：期间已用新令牌重新登录——旧请求的 401 只退出提交忙碌态，
          // 不得清除新令牌、不得把新登录界面切到需要登录。草稿与快照保留。
          this.phase = 'idle';
          this.renderStatus('登录已更新，请重新提交');
          this.syncUi();
          return;
        }
        // 令牌过期/无效：保留草稿与快照（登录后重发仍同 key 同字节），提示登录
        this.accessToken = null;
        this.tokenExpiresAt = 0;
        this.authRequired = true;
        this.phase = 'idle';
        this.invalidateQuotaRefresh();
        this.quotaRefreshPending = false; // 会话已失效：清除旧身份的补发意图
        this.renderStatus('需要登录（登录已过期）');
        this.syncUi();
        this.clearHostSession();
        return;
      }
      this.phase = 'failed';
      if (err instanceof ApiError && err.code === 'daily_quota_exceeded') {
        // 明确「未接收」：不使用 429 的「结果未知」语义，草稿保留待额度刷新后重试。
        frozen.unknownOutcome = false;
        // 额度错误带回权威额度：使此前的额度查询失效，避免旧查询覆盖。
        this.invalidateQuotaRefresh();
        if (err.quota) this.quota = err.quota;
        this.phase = 'quota';
        this.lastErrorSummary = '今日提交次数已用完，请在额度刷新后重试。文字与截图已保留。';
        this.renderStatus('');
        this.syncUi();
        this.consumeQuotaRefreshIntent();
        return;
      }
      if (err instanceof ApiError && err.code === 'idempotency_conflict') {
        // 409：显示冲突，不自动更换 key（快照与 key 保留；用户编辑后自然形成新请求）
        frozen.unknownOutcome = false;
        this.lastErrorSummary = '提交冲突：同一提交标识已对应不同内容。请修改内容重新提交，或“再记一条”。';
      } else {
        frozen.unknownOutcome = this.isUnknownOutcome(err);
        this.lastErrorSummary = err instanceof Error ? err.message : String(err);
      }
      this.renderStatus('');
      this.syncUi();
    }
  }

  // ---------- 轮询 ----------

  private startPolling(id: string): void {
    this.stopPolling();
    this.polling = true;
    this.pollDelay = POLL_START_MS;
    this.pollStartedAt = Date.now();
    // 禁用态必须与 `polling` 同帧落到 DOM：否则 201 之后截图 / 移除按钮会停留在
    // 「可用」的旧状态，直到下一次与轮询无关的 syncUi（提交按钮也依赖同一份 busy）。
    this.syncUi();
    this.schedulePoll(id);
  }

  private schedulePoll(id: string): void {
    if (!this.polling) return;
    this.pollTimer = setTimeout(() => void this.pollTick(id), this.pollDelay);
    this.pollDelay = Math.min(this.pollDelay * 2, POLL_MAX_MS);
  }

  private async pollTick(id: string): Promise<void> {
    if (!this.polling) return;
    // 身份世代：轮询结果 / 错误只在身份未变时生效
    const epoch = this.identityEpoch;
    const apiBase = this.effectiveApiBase;
    if (!apiBase || !this.tokenValid()) {
      this.polling = false;
      if (!this.tokenValid()) {
        this.authRequired = true;
        this.renderStatus('登录已过期，请重新登录后继续查看进度。');
        this.syncUi();
      }
      return;
    }

    let record: FeedbackRecord;
    // 请求发出时捕获实际使用的令牌（T1-A）：401 是否清理凭据以它为准。
    const usedToken = this.accessToken as string;
    try {
      record = await getFeedback(apiBase, usedToken, id, { fetchFn: this.apiFetch });
    } catch (err) {
      if (epoch !== this.identityEpoch) return; // 身份已切换：旧服务的错误一律丢弃
      if (err instanceof ApiError && err.status === 401) {
        if (usedToken !== this.accessToken) {
          // T1-A：期间已换新令牌——不清凭据、不改登录界面，按退避续排
          // 下一次轮询（下个 tick 自然使用新令牌）。
          this.schedulePoll(id);
          return;
        }
        this.polling = false;
        this.accessToken = null;
        this.authRequired = true;
        this.renderStatus('登录已过期，请重新登录后继续查看进度。');
        this.syncUi();
        this.clearHostSession();
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        this.polling = false;
        this.phase = 'failed';
        this.lastErrorSummary = '未找到反馈记录';
        this.renderStatus('');
        this.syncUi();
        return;
      }
      // 网络临时错误：继续退避重试
      record = this.lastRecord ?? {
        id,
        status: 'received',
        createdAt: '',
        updatedAt: '',
        errorSummary: null,
        kaneoUrl: null,
      };
    }

    if (epoch !== this.identityEpoch) return; // 旧服务的迟到记录不得更新 lastRecord / phase
    if (!this.polling) return;

    if (isTerminalStatus(record.status)) {
      // 终态：先停轮询再同步 UI（按钮禁用态依赖 polling）
      this.stopPolling();
      this.applyRecordState(record);
      return;
    }

    this.lastRecord = record;

    // T4：等待管理员操作同样不再继续轮询（见 applyRecordState），只在处理中才跟踪。
    if (collectionWaitingText(record.collectionState) !== null) {
      this.stopPolling();
      this.applyRecordState(record);
      return;
    }

    if (Date.now() - this.pollStartedAt + this.pollDelay > POLL_BUDGET_MS) {
      this.polling = false;
      // 轮询超时绝不能呈现为归档失败！
      this.renderStatus('已保存，后台正在整理中，稍后可在管理页查看。');
      this.syncUi();
      return;
    }

    this.renderStatus('已保存，正在整理');
    this.schedulePoll(id);
  }

  /**
   * 依记录状态更新阶段 / 结果 / 状态文本（轮询与手动刷新共用）。
   * 返回 true 表示已进入终态（调用方应停止轮询）。
   */
  private applyRecordState(record: FeedbackRecord): boolean {
    this.lastRecord = record;

    // T4：等待配置 / 等待来源确认 / 等待人工归档 —— 已保存，等待管理员操作。
    // 明确提示而不是显示失败，并立即停止轮询（手动刷新按钮仍然可用）。
    const waiting = collectionWaitingText(record.collectionState);
    if (waiting !== null) {
      this.waitingNotice = waiting;
      this.phase = 'tracking';
      this.lastErrorSummary = null;
      this.renderStatus(waiting);
      this.syncUi();
      return true; // 视为终态：调用方停止轮询
    }
    this.waitingNotice = null;

    if (record.status === 'archived') {
      this.phase = 'archived';
      this.renderStatus('已归档');
      this.syncUi();
      return true;
    }

    if (record.status === 'failed') {
      this.phase = 'failed';
      this.lastErrorSummary = record.errorSummary ?? null;
      this.renderStatus('');
      this.syncUi();
      return true;
    }

    if (record.status === 'needs_review') {
      this.phase = 'needs_review';
      this.lastErrorSummary = null;
      this.renderStatus('');
      this.syncUi();
      return true;
    }

    return false;
  }

  private async resumePolling(): Promise<void> {
    if (this.lastFeedbackId && !this.polling && this.tokenValid()) {
      this.startPolling(this.lastFeedbackId);
    }
  }

  private stopPolling(): void {
    this.polling = false;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * 服务端已接收但后台处理失败时的手动刷新：只读 `GET /api/feedback/:id`，
   * 更新 phase / lastRecord / lastErrorSummary / 状态文本。绝不重复 POST。
   * 与轮询共用身份世代校验：身份切换后的迟到结果一律丢弃。
   */
  private async refreshLastRecord(): Promise<void> {
    const id = this.lastFeedbackId;
    if (!id || this.refreshing) return;
    const apiBase = this.effectiveApiBase;
    if (!apiBase) {
      this.failPhase('缺少必填配置：api-base / app-id');
      return;
    }
    if (!this.tokenValid()) {
      this.authRequired = true;
      this.renderStatus('需要登录（登录已过期）');
      this.syncUi();
      return;
    }

    const epoch = this.identityEpoch;
    // 请求发出时捕获实际使用的令牌（T1-A）：401 是否清理凭据以它为准。
    const usedToken = this.accessToken as string;
    this.refreshing = true;
    this.renderStatus('正在刷新状态…');
    this.syncUi();

    try {
      const record = await getFeedback(apiBase, usedToken, id);
      if (epoch !== this.identityEpoch) return; // 身份已切换：旧服务的记录一律丢弃

      if (isTerminalStatus(record.status)) {
        this.stopPolling();
        this.applyRecordState(record);
        return;
      }

      // T4：等待管理员操作的记录：刷新后仍处于等待 → 停止轮询并给出等待提示。
      if (collectionWaitingText(record.collectionState) !== null) {
        this.stopPolling();
        this.applyRecordState(record);
        return;
      }

      this.waitingNotice = null;
      // 仍在整理中：回到跟踪态并继续轮询（只读，不会重复提交）
      this.lastRecord = record;
      this.phase = 'tracking';
      this.renderStatus('已保存，正在整理');
      this.syncUi();
      if (!this.polling) this.startPolling(id);
    } catch (err) {
      if (epoch !== this.identityEpoch) return;
      if (err instanceof ApiError && err.status === 401) {
        if (usedToken !== this.accessToken) {
          // T1-A：期间已换新令牌——不清凭据、不改登录界面，仅退出忙碌态。
          return;
        }
        this.accessToken = null;
        this.tokenExpiresAt = 0;
        this.authRequired = true;
        this.renderStatus('登录已过期，请重新登录后继续查看进度。');
        this.syncUi();
        this.clearHostSession();
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        this.lastErrorSummary = '未找到反馈记录';
        this.renderStatus('未找到反馈记录。');
        this.syncUi();
        return;
      }
      this.lastErrorSummary = err instanceof Error ? err.message : String(err);
      this.renderStatus('刷新失败，请稍后再试。');
      this.syncUi();
    } finally {
      // 忙碌标记属于当前渲染；身份切换后重渲染的是新身份的状态
      this.refreshing = false;
      this.syncUi();
    }
  }

  /**
   * 复制反馈标识：剪贴板不可用（或写入失败）时静默降级，绝不抛错、绝不发请求。
   */
  private copyFeedbackId(): void {
    const id = this.lastFeedbackId;
    if (!id) return;
    try {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== 'function') return; // 静默降级
      void Promise.resolve(clipboard.writeText(id))
        .then(() => this.renderStatus('反馈标识已复制'))
        .catch(() => {
          /* 剪贴板写入失败：静默忽略 */
        });
    } catch {
      /* 剪贴板 API 不可用：静默降级 */
    }
  }

  // ---------- 服务器设置（T6） ----------

  /** 按当前（appId, api-base）槽位读取本机覆盖；键未变时跳过，保留会话内未落盘的选择。 */
  private loadServerOverride(): void {
    const key = serverOverrideStorageKey(this.appId ?? '', this.apiBase ?? '');
    if (key === this.serverOverrideKeyLoaded) return;
    this.serverOverrideKeyLoaded = key;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) {
        this.serverOverride = null;
        return;
      }
      const normalized = normalizeServerBase(raw);
      // 所存值非法（旧格式 / 手改）视为无覆盖，绝不静默应用
      this.serverOverride = normalized.ok ? normalized.base : null;
    } catch {
      // 存储不可用（如沙箱 iframe 禁用 localStorage）：按无覆盖处理并标记不可写，
      // 后续保存会提示「仅本次生效」
      this.serverOverride = null;
      this.serverPrefWritable = false;
    }
  }

  /** 两个地址规范化后是否相同（不可规范化的按去空白原值比较）。 */
  private sameNormalizedBase(a: string | null, b: string | null): boolean {
    if (a === null || b === null) return a === b;
    const na = normalizeServerBase(a);
    const nb = normalizeServerBase(b);
    return (na.ok ? na.base : a.trim()) === (nb.ok ? nb.base : b.trim());
  }

  private pageIsHttps(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof window.location !== 'undefined' &&
      window.location.protocol === 'https:'
    );
  }

  private openServerSettings(): void {
    this.settingsOpen = true;
    this.settingsConfirmOpen = false;
    this.pendingServerTarget = undefined;
    this.settingsInput.value = this.effectiveApiBase ?? '';
    this.settingsErrorEl.hidden = true;
    this.settingsErrorEl.textContent = '';
    this.settingsHintEl.hidden = true;
    this.settingsHintEl.textContent = '';
    this.syncUi();
    this.settingsInput.focus();
  }

  private closeServerSettings(): void {
    this.settingsOpen = false;
    this.settingsConfirmOpen = false;
    this.pendingServerTarget = undefined;
    this.syncUi();
  }

  private setSettingsHint(text: string): void {
    this.settingsHintEl.textContent = text;
    this.settingsHintEl.hidden = text === '';
  }

  /**
   * 写入 / 清除本机覆盖偏好；返回是否落盘成功（失败时调用方提示「仅本次生效」）。
   * 偏好只存地址——不持久化草稿、密码或令牌。
   */
  private persistServerOverride(value: string | null): boolean {
    const ok = writeServerOverride(this.appId ?? '', this.apiBase ?? '', value);
    if (!ok) this.serverPrefWritable = false;
    return ok;
  }

  /**
   * 保存设置视图输入：校验 → 与当前有效地址相同仅落盘（不触发身份重置）→
   * 不同且有草稿 / 未确认提交时先展开确认块 → 确认后切换。
   */
  private saveServerSettings(): void {
    const res = normalizeServerBase(this.settingsInput.value, { pageIsHttps: this.pageIsHttps() });
    if (!res.ok) {
      this.settingsErrorEl.textContent = res.reason;
      this.settingsErrorEl.hidden = false;
      this.setSettingsHint('');
      return;
    }
    this.settingsErrorEl.hidden = true;
    this.settingsErrorEl.textContent = '';
    // 输入与宿主默认地址相同 → 记为「无覆盖」（与「恢复默认」等价）
    const next = this.sameNormalizedBase(res.base, this.apiBase) ? null : res.base;
    const targetEffective = next ?? this.apiBase;
    if (this.sameNormalizedBase(targetEffective, this.effectiveApiBase)) {
      const persisted = this.persistServerOverride(next);
      this.serverOverride = next;
      this.setSettingsHint(persisted ? '已保存。' : '服务器地址仅本次生效（偏好未能保存到本机）。');
      this.syncUi();
      return;
    }
    this.requestServerSwitch(next);
  }

  /** 「恢复默认」：与保存共用确认与提交流程，目标覆盖为 null。 */
  private requestRestoreDefault(): void {
    if (this.sameNormalizedBase(this.apiBase, this.effectiveApiBase)) return; // 未覆盖
    this.requestServerSwitch(null);
  }

  /** 地址即将变化：有草稿或结果未确认提交时先展开内联确认块，否则直接切换。 */
  private requestServerSwitch(next: string | null): void {
    const hasUnconfirmed =
      this.unconfirmedRequest !== null ||
      this.submitSnapshot?.unknownOutcome === true ||
      this.phase === 'submitting';
    const needConfirm = this.isDraftDirty() || hasUnconfirmed || this.polling;
    if (needConfirm) {
      this.settingsConfirmOpen = true;
      this.pendingServerTarget = next;
      this.settingsConfirmText.textContent = hasUnconfirmed
        ? '切换服务器将清空当前草稿（文字、截图与日志）。已有一条提交的结果尚未确认，旧服务器可能已接收——切换不会撤回，也不会自动向新服务器重发。'
        : '切换服务器将清空当前草稿（文字、截图与日志）。';
      this.syncUi();
      return;
    }
    this.commitServerSwitch(next);
  }

  private confirmServerSwitch(): void {
    if (this.pendingServerTarget === undefined) return;
    const next = this.pendingServerTarget;
    this.pendingServerTarget = undefined;
    this.commitServerSwitch(next);
  }

  private cancelServerSwitch(): void {
    this.settingsConfirmOpen = false;
    this.pendingServerTarget = undefined;
    this.syncUi();
  }

  /**
   * 应用覆盖并切换身份：相同规范化地址不触发重置由调用方保证；
   * 这里落盘偏好 → epoch 递增作废旧服务在途请求 → 完整服务切换重置 → 探测连通性。
   */
  private commitServerSwitch(next: string | null): void {
    const persisted = this.persistServerOverride(next);
    this.settingsConfirmOpen = false;
    this.pendingServerTarget = undefined;
    this.serverOverride = next;
    // 与 attributeChangedCallback('api-base') 同一条完整重置路径：令牌 / 草稿 /
    // 截图 / 日志 / 快照 / 幂等键 / 轮询 / 握手全部作废，旧服务迟到响应由 epoch 丢弃。
    this.identityEpoch++;
    this.quotaRefreshPending = false;
    this.resetForServiceSwitch();
    // 切换完成后停留在设置视图展示结果与连通性提示
    this.settingsOpen = true;
    this.setSettingsHint(
      persisted ? '已保存。' : '服务器地址已切换，但仅本次生效（偏好未能保存到本机）。',
    );
    this.syncUi();
    void this.probeServer(this.effectiveApiBase);
  }

  /**
   * 保存后探测新地址连通性（GET /healthz，不带凭据）：
   * 失败只提示，不回切——连接失败不自动换回其他服务器（T6）。
   */
  private async probeServer(base: string | null): Promise<void> {
    if (!base) return;
    const epoch = this.identityEpoch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      await this.apiFetch(joinApi(base, '/healthz'), {
        method: 'GET',
        signal: controller.signal,
        credentials: 'omit',
      });
    } catch {
      if (epoch === this.identityEpoch && this.settingsOpen) {
        this.setSettingsHint('已保存，但暂时无法连接该服务器，请确认地址可用（不会自动切回）。');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** 设置视图的只读展示同步（当前有效地址 / 宿主默认 / 确认块可见性）。 */
  private syncSettingsUi(): void {
    if (!this.settingsView) return;
    this.settingsView.hidden = !this.settingsOpen;
    if (this.navTabs) this.navTabs.hidden = this.settingsOpen;
    if (this.body) this.body.hidden = this.settingsOpen || this.activeTab !== 'compose';
    if (this.historyContainer) this.historyContainer.hidden = this.settingsOpen || this.activeTab !== 'history';
    this.settingsCurrent.textContent = this.effectiveApiBase ?? '—';
    const def = this.apiBase;
    const overridden = this.serverOverride !== null;
    this.settingsDefaultRow.hidden = !overridden || def === null;
    this.settingsDefaultText.textContent = overridden ? (def ?? '') : '';
    this.settingsRestoreBtn.disabled = !overridden;
    this.settingsConfirmEl.hidden = !this.settingsConfirmOpen;
  }

  // ---------- 面板内登录 ----------

  private pendingSubmit = false;

  /** 展开面板内账号密码表单（不打开新窗口）；pendingSubmit=true 时登录成功后只提交一次。 */
  private beginLogin(pendingSubmit: boolean): void {
    const apiBase = this.effectiveApiBase;
    const appId = this.appId;
    if (!apiBase || !appId) {
      this.failPhase('缺少必填配置：api-base / app-id');
      return;
    }
    this.authRequired = true;
    this.pendingSubmit = pendingSubmit;
    this.loginVisible = true;
    this.loginError = '';
    this.syncUi();
    this.loginUsername.focus();
    this.renderStatus('需要登录：请输入账号密码');
  }

  /** 取消登录：收起表单并让在途登录失效，草稿与截图保留。 */
  private cancelLogin(): void {
    this.invalidateLogin();
    this.loginVisible = false;
    this.renderStatus(this.phase === 'tracking' ? '已保存，正在整理' : '');
    this.syncUi();
  }

  /**
   * 使尚未完成的登录接续失效：递增登录序号，清除密码、登录忙碌状态与
   * 待自动提交标记。**不撤销**已经建立的有效登录态，也不动草稿与截图。
   * 调用点：关闭面板、取消登录、组件卸载、服务身份变化。
   */
  private invalidateLogin(): void {
    this.loginSeq++;
    this.loginBusy = false;
    this.pendingSubmit = false;
    this.loginPassword.value = '';
  }

  /**
   * 登录回调是否仍然有效：序号未变（面板自登录发起以来没有被关闭、
   * 也没有被取消 / 卸载 / 换身份）+ 服务身份世代未变 + 组件仍连接。
   */
  private loginStillValid(seq: number, epoch: number): boolean {
    return seq === this.loginSeq && epoch === this.identityEpoch && this.isConnected;
  }

  private async doLogin(): Promise<void> {
    if (this.loginBusy) return;
    const apiBase = this.effectiveApiBase;
    const appId = this.appId;
    if (!apiBase || !appId) {
      this.failPhase('缺少必填配置：api-base / app-id');
      return;
    }
    const username = this.loginUsername.value.trim();
    const password = this.loginPassword.value;
    if (!username || !password) {
      this.loginError = '请输入用户名和密码';
      this.syncUi();
      return;
    }
    // 登录回调绑定发起时的登录序号与服务身份：任一变则结果一律 no-op。
    const epoch = this.identityEpoch;
    const seq = ++this.loginSeq;
    this.loginBusy = true;
    this.loginError = '';
    this.syncUi();
    try {
      const res = await login(apiBase, { username, password, clientLabel: webClientLabel(appId), appId }, { fetchFn: this.apiFetch });
      if (!this.loginStillValid(seq, epoch)) return;
      if (this.accessToken !== res.token) this.resetTrackingViews();
      this.accessToken = res.token;
      const exp = Date.parse(res.expiresAt);
      this.tokenExpiresAt = Number.isFinite(exp) ? exp : Date.now() + 15 * 60_000;
      this.authUser = res.user;
      this.quota = res.quota ?? null;
      this.applyCapabilities(res.capabilities);
      if (this.sessionStore) {
        try {
          void Promise.resolve(
            this.sessionStore.saveSession({ accessToken: res.token, expiresAt: res.expiresAt }),
          ).catch(() => {});
        } catch {
          // 宿主保存失败不阻断登录
        }
      }
      this.authRequired = false;
      this.loginVisible = false;
      this.loginBusy = false;
      this.loginError = '';
      this.quotaRefreshFailed = false;
      this.loginPassword.value = ''; // 密码不持久化
      this.renderStatus('已登录。');
      this.syncUi();
      this.startSummaryPolling();
      this.consumeQuotaRefreshIntent(); // 登录忙碌结束：补发被挡下的刷新
      const queued = this.pendingSubmit;
      this.pendingSubmit = false;
      if (queued && codePointLength(this.textarea.value) > 0) {
        void this.submit(); // 成功后只提交一次
      } else if (this.phase === 'tracking') {
        void this.resumePolling();
      }
    } catch (err) {
      // 失败回调同样校验：旧登录的错误不得覆盖新登录状态或界面。
      if (!this.loginStillValid(seq, epoch)) return;
      this.loginBusy = false;
      this.loginPassword.value = ''; // 登录结束清空密码
      this.loginError = loginErrorMessage(err);
      this.renderStatus('');
      this.syncUi();
    }
  }

  // ---------- 额度刷新与生命周期 ----------

  private cancelQuotaTimer(): void {
    if (this.quotaTimer !== null) {
      clearTimeout(this.quotaTimer);
      this.quotaTimer = null;
    }
  }

  /**
   * 使在途额度查询失效并取消定时查询：关闭 / 卸载 / 退到后台 / 身份变化 /
   * 提交成功 / 收到额度错误时调用。旧查询结果不得再写回额度。
   */
  private invalidateQuotaRefresh(): void {
    this.quotaSeq++;
    this.cancelQuotaTimer();
  }

  /**
   * 统一调度额度查询（同一时刻最多一个定时器）：
   * - 未登录 / 面板未打开 / 应用不在前台 → 不排程；
   * - 刷新失败 → 30 秒后重试（不对过期 resetAt 立即循环请求）；
   * - 额度用尽 → 每 30 秒一次，并与 resetAt 合并取更早者
   *   （后台调高额度后最多 30 秒即可恢复，无需关闭重开面板）；
   * - 其它状态 → 只在服务端 resetAt 排单次查询，到期只向服务端取最新值。
   */
  private scheduleQuotaRefresh(): void {
    this.cancelQuotaTimer();
    if (!this.tokenValid() || !this.openState) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (this.quotaInFlight) return; // 在途查询完成后会重新调度
    if (this.quotaRefreshFailed) {
      this.quotaTimer = setTimeout(() => void this.refreshQuota(), QUOTA_RETRY_MS);
      return;
    }
    const q = this.quota;
    // 不限形态（管理员）没有数值额度：不参与用尽轮询，显示也不依赖定时刷新。
    if (!q || q.unlimited === true || typeof q.remaining !== 'number' || typeof q.resetAt !== 'string')
      return;
    const reset = Date.parse(q.resetAt);
    const untilReset = Number.isFinite(reset) ? reset - Date.now() : Number.NaN;
    let delay: number | null;
    if (q.remaining <= 0) {
      delay = untilReset > 0 && untilReset < QUOTA_RETRY_MS ? untilReset : QUOTA_RETRY_MS;
    } else if (untilReset > 0) {
      delay = untilReset;
    } else {
      delay = null; // 非用尽且 resetAt 已过：等下一次打开 / 回到前台刷新
    }
    if (delay === null || delay <= 0) return;
    // 夹到安全上限：超长延时在宿主里会退化为立即触发（紧密循环）。
    delay = Math.min(delay, QUOTA_MAX_DELAY_MS);
    this.quotaTimer = setTimeout(() => void this.refreshQuota(), delay);
  }

  /**
   * 刷新额度与会话信息：打开面板、应用恢复前台、提交完成、额度用尽轮询时调用。
   * 不在本地擅自重置——跨过 resetAt 后由服务端返回新的 used / remaining。
   * 结果除校验身份与令牌外还校验查询序号：提交成功后的旧查询不得把次数加回。
   * 被旧查询 / 登录忙碌挡下时登记「待立即刷新」，结束后立即补发（T1-B）。
   */
  private async refreshQuota(): Promise<void> {
    const apiBase = this.effectiveApiBase;
    if (!apiBase || !this.tokenValid() || this.loginBusy || this.quotaInFlight) {
      // T1-B：打开面板 / 回到前台的刷新被旧查询或登录忙碌挡下时登记意图，
      // 不得丢弃；未登录 / 面板未打开 / 不在可见页时不登记（相应事件会重新登记）。
      if (
        apiBase &&
        this.tokenValid() &&
        this.openState &&
        (this.loginBusy || this.quotaInFlight) &&
        (typeof document === 'undefined' || document.visibilityState === 'visible')
      ) {
        this.quotaRefreshPending = true;
      }
      return;
    }
    const epoch = this.identityEpoch;
    const token = this.accessToken as string;
    const seq = ++this.quotaSeq;
    this.quotaInFlight = true;
    try {
      const res = await getSession(apiBase, token, { fetchFn: this.apiFetch });
      if (!this.quotaResultValid(seq, epoch, token)) return;
      this.authUser = res.user;
      this.quota = res.quota ?? null;
      this.applyCapabilities(res.capabilities);
      this.quotaRefreshFailed = false;
      this.syncUi();
    } catch (err) {
      if (!this.quotaResultValid(seq, epoch, token)) return;
      if (err instanceof ApiError && err.status === 401) {
        // 令牌过期/被撤销：保留草稿，回到需要登录态并停止额度定时查询；
        // 补发意图一并清除，避免对已失效会话的补发循环（重新登录后重新调度）。
        this.accessToken = null;
        this.tokenExpiresAt = 0;
        this.authRequired = true;
        this.authUser = null;
        this.quota = null;
        this.quotaRefreshFailed = false;
        this.quotaRefreshPending = false;
        this.invalidateQuotaRefresh();
        this.renderStatus('登录已过期，请重新登录。');
        this.syncUi();
        this.clearHostSession();
        return;
      }
      // 其它错误（网络 / 超时等）：保留旧额度 / 草稿，30 秒后重试。
      this.quotaRefreshFailed = true;
    } finally {
      this.quotaInFlight = false;
      this.consumeQuotaRefreshIntent();
    }
  }

  /**
   * 消费「待立即刷新」意图（T1-B）：优先于定时规则——旧查询结束 / 忙碌结束
   * 后条件仍满足时立即补发一次并清除标记；否则按现有 30 秒 / resetAt 规则
   * 排定时器（不会紧密循环，也不会因一次跳过而永久停摆）。
   */
  private consumeQuotaRefreshIntent(): void {
    if (
      this.quotaRefreshPending &&
      this.tokenValid() &&
      this.openState &&
      !this.loginBusy &&
      !this.quotaInFlight &&
      (typeof document === 'undefined' || document.visibilityState === 'visible')
    ) {
      this.quotaRefreshPending = false;
      void this.refreshQuota();
      return;
    }
    this.scheduleQuotaRefresh();
  }

  /** 额度查询结果是否仍然有效：序号 + 身份世代 + 令牌三者都要匹配。 */
  private quotaResultValid(seq: number, epoch: number, token: string): boolean {
    return seq === this.quotaSeq && epoch === this.identityEpoch && token === this.accessToken;
  }

  // ---------- v12 服务端能力 ----------

  /**
   * 应用服务端能力声明（登录 / 会话响应附带 `capabilities`）：
   * - `images: N` → 允许多图（上限取 min(N, 5)）；
   * - 字段缺失（旧服务端）→ 单图模式 + 升级提示；
   * - 字段存在且为 0/负值 → 同样按单图处理。
   * 会话响应携带 `capabilities` 对象即视为「已确认」（缺失 images 也确认）。
   */
  private applyCapabilities(raw: unknown): void {
    const caps = parseCapabilities(raw);
    if (caps === undefined) return; // 无 capabilities 字段：保持未确认（可能旧服务端）
    this.capabilitiesKnown = true;
    this.maxImages = Math.max(1, Math.min(MAX_IMAGES, caps.images ?? 1));
    this.dialogueSupported = caps.dialogue === true;
  }

  /**
   * 能力校准顺序：认证响应（login / session 的 capabilities）优先；
   * 能力仍未知且需要判断（提交多图）时才探测 `GET /api/features`
   * （无需登录，跨源放行）。探测成功即确认（响应缺 images → 单图模式）；
   * 探测失败保持未确认——乐观放行多图，由服务端裁决。
   * `GET /api/features` 同时以 api.ts 导出供宿主主动探测。
   */
  private async probeFeatures(): Promise<void> {
    const apiBase = this.effectiveApiBase;
    if (!apiBase || this.capabilitiesKnown || this.featuresProbing) return;
    const epoch = this.identityEpoch;
    this.featuresProbing = true;
    try {
      const caps = await getFeatures(apiBase, { fetchFn: this.apiFetch });
      if (epoch !== this.identityEpoch) return;
      this.applyCapabilities(caps);
    } catch {
      /* 探测失败：保持未确认（乐观多图），下次提交再试 */
    } finally {
      if (epoch === this.identityEpoch) this.featuresProbing = false;
    }
  }

  /** 公开 API：展开面板内登录表单（保留旧签名的返回值）。 */
  startLogin(): string {
    this.beginLogin(false);
    return '';
  }

  /**
   * 宿主注入会话：与面板内登录等价，但凭据由宿主提供——例如同源管理后台
   * 以自身 Cookie 会话调 `POST /api/auth/handshake` 换取的握手令牌。
   * 令牌同样仅存内存；宿主负责到期前续注（重新调用本方法）或在自身
   * 会话结束时调用 dropSession()。注入后组件自动拉取会话身份与额度。
   * 注入非法参数（空令牌 / 不可解析的过期时刻）按 no-op 处理。
   */
  adoptSession(session: { accessToken: string; expiresAt: number | string }): void {
    const token = typeof session?.accessToken === 'string' ? session.accessToken : '';
    const raw = session?.expiresAt;
    const exp = typeof raw === 'number' ? raw : Date.parse(typeof raw === 'string' ? raw : '');
    if (!token || !Number.isFinite(exp)) return;
    // 新凭据 = 新身份上下文：epoch 递增作废旧令牌的在途结果（额度 / 轮询 /
    // 提交回执），与 api-base / app-id 切换同一条守卫路径。
    this.identityEpoch++;
    this.resetTrackingViews();
    this.accessToken = token;
    this.tokenExpiresAt = exp;
    this.authRequired = false;
    this.loginVisible = false;
    this.loginBusy = false;
    this.loginError = '';
    this.quotaRefreshFailed = false;
    // v12：新凭据=新身份上下文——能力声明待会话响应校准，诊断缓冲清空（世代递增）
    this.capabilitiesKnown = false;
    this.maxImages = MAX_IMAGES;
    this._diagnostics?.clear();
    this.renderStatus('已登录。');
    this.syncUi();
    // 拉取会话身份与额度（GET /api/auth/session）；迟到 / 失效响应由
    // seq + epoch + token 三重校验丢弃，401 自动回到需要登录态。
    void this.refreshQuota();
    this.startSummaryPolling();
  }

  /**
   * 宿主清除注入的会话（如宿主自身退出登录）：丢弃令牌与身份，回到
   * 需要登录态；草稿 / 截图 / 日志保留（与令牌被撤销同语义）。
   */
  dropSession(): void {
    this.clearHostSession();
    if (this.accessToken === null) return;
    this.identityEpoch++;
    this.resetTrackingViews();
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this._diagnostics?.clear(); // 世代递增：旧身份写入的诊断缓冲一律丢弃
    this.authUser = null;
    this.quota = null;
    this.quotaRefreshFailed = false;
    this.quotaRefreshPending = false;
    this.invalidateQuotaRefresh();
    this.stopSummaryPolling();
    this.stopDialoguePolling();
    this.unreadCount = 0;
    this.syncUnreadBadge();
    this.authRequired = true;
    this.renderStatus('需要登录');
    this.syncUi();
  }

  private resetToCompose(): void {
    this.stopPolling();
    this.phase = 'idle';
    this.lastFeedbackId = null;
    this.submittedFeedbackEpoch = null;
    this.lastRecord = null;
    this.lastErrorSummary = null;
    this.waitingNotice = null;
    this.idempotencyKey = null;
    this.submitSnapshot = null;
    this.unconfirmedRequest = null;
    this.textarea.value = '';
    this.clearDraft();
    this.renderStatus('');
    this.syncUi();
    this.textarea.focus();
  }

  // ---------- 渲染与 UI 同步 ----------

  private renderStatus(text: string): void {
    this.statusRegion.textContent = text;
  }

  private syncUi(): void {
    const len = codePointLength(this.textarea.value);
    this.counter.textContent = `${len}/${MAX_TEXT}`;
    this.counter.classList.toggle('is-over', len > MAX_TEXT);

    const isAuthed = this.tokenValid();
    const accepted = this.dialogueSupported && this.submittedFeedbackEpoch === this.identityEpoch && this.lastFeedbackId !== null;
    this.body.classList.toggle('has-submitted-feedback', accepted && isAuthed);
    const busy = this.phase === 'submitting' || this.polling;

    // 额度用尽：禁止新提交，但结果未知的同键重试仍放行。
    const snap = this.submitSnapshot;
    const retryingUnknown =
      snap !== null &&
      snap.unknownOutcome &&
      snap.draftVersion === this.draft.version &&
      snap.text === this.textarea.value &&
      areImagesEqual(snap.images, this.draft.images.map(toImageInput)) &&
      areLogsEqual(snap.logs, this.draft.logs);
    const quotaBlocked =
      isAuthed &&
      this.quota !== null &&
      this.quota.unlimited !== true &&
      this.quota.remaining <= 0 &&
      !retryingUnknown;

    // 额度显示：仅在已登录且已取得额度时出现；管理员不限次数。
    if (isAuthed && this.quota) {
      this.quotaInfo.hidden = false;
      this.quotaInfo.textContent =
        this.quota.unlimited === true ? '不限次数' : `今日剩余 ${this.quota.remaining} 次`;
    } else {
      this.quotaInfo.hidden = true;
      this.quotaInfo.textContent = '';
    }
    // 额度用尽提示（含下次可提交时间）；同键未知结果重试时不再提示。
    if (quotaBlocked && this.quota) {
      const reset = new Date(this.quota.resetAt);
      this.quotaBlockedInfo.hidden = false;
      this.quotaBlockedInfo.textContent = Number.isFinite(reset.getTime())
        ? `今日提交次数已用完，下次可提交时间：${reset.toLocaleString()}`
        : '今日提交次数已用完，请在额度刷新后重试';
    } else {
      this.quotaBlockedInfo.hidden = true;
      this.quotaBlockedInfo.textContent = '';
    }

    // 面板内登录表单：展开 / 收起与忙碌态。
    // 「取消」在登录进行中保持可用：用户必须能中止一次挂起的登录，
    // 中止会递增登录序号使该次登录的迟到结果失效（T1-A）。
    this.loginPanel.hidden = !this.loginVisible;
    this.loginUsername.disabled = this.loginBusy;
    this.loginPassword.disabled = this.loginBusy;
    this.loginConfirmBtn.disabled = this.loginBusy;
    this.loginCancelBtn.disabled = false;
    this.loginConfirmBtn.textContent = this.loginBusy ? '登录中…' : '登录并提交';
    this.loginErrorEl.hidden = this.loginError === '';
    this.loginErrorEl.textContent = this.loginError;

    // 截图区同步：预览 / 首个截图入口 / 重拍 / 移除
    this.syncShotUi();

    // 日志区同步：列表 / 数量 / 按钮状态
    this.syncLogsUi();

    // T6：设置视图与主体互斥显示
    this.syncSettingsUi();

    if (this.tabComposeBtn) {
      this.tabComposeBtn.classList.toggle('active', this.activeTab === 'compose');
    }
    if (this.tabHistoryBtn) {
      this.tabHistoryBtn.classList.toggle('active', this.activeTab === 'history');
    }
    this.syncUnreadBadge();

    // 禁用态
    this.textarea.disabled = this.phase === 'submitting';

    // 确定主按钮文字与状态
    if (!isAuthed) {
      this.submitBtn.className = 'fb-submit fb-login';
      this.submitBtn.textContent = '登录并提交';
      this.submitBtn.disabled = len === 0 || len > MAX_TEXT || busy;
      if (!this.statusRegion.textContent && len > 0) {
        this.renderStatus('需要登录');
      }
    } else if (this.phase === 'submitting') {
      this.submitBtn.className = 'fb-submit';
      this.submitBtn.textContent = '提交中…';
      this.submitBtn.disabled = true;
    } else if (this.phase === 'archived') {
      this.submitBtn.className = 'fb-submit';
      this.submitBtn.textContent = '已归档';
      this.submitBtn.disabled = true;
    } else if (this.phase === 'failed' && this.idempotencyKey !== null && !this.lastRecord) {
      // 提交未成功（未保存到服务端），允许重试提交
      this.submitBtn.className = 'fb-submit';
      this.submitBtn.textContent = '重试提交';
      this.submitBtn.disabled = busy || len === 0 || len > MAX_TEXT || quotaBlocked;
    } else {
      this.submitBtn.className = 'fb-submit';
      this.submitBtn.textContent = '提交';
      this.submitBtn.disabled = busy || len === 0 || len > MAX_TEXT || this.phase === 'tracking' || quotaBlocked;
    }

    // 状态卡片构建
    this.errorRegion.textContent = '';
    this.errorRegion.hidden = true;

    if (this.dialogueSupported && this.submittedFeedbackEpoch === this.identityEpoch && this.lastFeedbackId) {
      this.errorRegion.hidden = false;
      const receipt = el('div', 'fb-status-card is-success fb-submission-receipt');
      receipt.append(
        el('p', 'fb-receipt-title', '已提交并保存'),
        el('p', 'fb-header-meta', `反馈编号：${this.lastFeedbackId}`),
        el('p', undefined, '稍后可在「我的反馈」查看处理进展和回复。'),
      );
      const progressBtn = el('button', 'fb-submit fb-view-progress', '查看进展');
      progressBtn.type = 'button';
      const feedbackId = this.lastFeedbackId;
      progressBtn.addEventListener('click', () => void this.openDialogue(feedbackId));
      const newBtn = el('button', 'fb-btn-secondary fb-receipt-new', '再记一条');
      newBtn.type = 'button';
      newBtn.addEventListener('click', () => this.resetToCompose());
      receipt.append(progressBtn, newBtn);
      this.errorRegion.append(receipt);
    }

    // 1. 已归档卡片
    if (this.phase === 'archived') {
      this.errorRegion.hidden = false;
      const card = el('div', 'fb-status-card is-success');
      card.append(el('p', undefined, '反馈已归档。感谢你的支持！'));

      const actions = el('div', 'fb-card-actions');
      if (this.lastRecord?.kaneoUrl) {
        const link = el('a', 'fb-task-link', '查看任务');
        const kaneoUrl = this.lastRecord.kaneoUrl;
        link.href = kaneoUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.setAttribute('aria-label', '打开 Kaneo 归档任务');
        link.addEventListener('click', (ev) => {
          if (this._hostBridge?.onOpenExternal) {
            ev.preventDefault();
            this.openExternal(kaneoUrl);
          }
        });
        actions.append(link);
      }
      const newBtn = el('button', 'fb-btn-secondary', '再记一条');
      newBtn.type = 'button';
      newBtn.hidden = accepted;
      newBtn.addEventListener('click', () => this.resetToCompose());
      actions.append(newBtn);

      card.append(actions);
      this.errorRegion.append(card);
    }

    // 2. 状态：已保存但后台处理失败 (failed from server record)
    //    服务端已接收（原话在服务端）→ 只提供「刷新状态 / 复制标识 / 再记一条」，
    //    绝不再次 POST /api/feedback（重复提交由"提交未到达服务"分支负责重试）。
    else if (this.phase === 'failed' && this.lastRecord) {
      this.errorRegion.hidden = false;
      const card = el('div', 'fb-status-card is-warn');
      card.append(el('p', undefined, '原话已保存，后台整理未完成，可在管理页处理。请勿重复提交。'));
      if (this.lastErrorSummary) {
        card.append(el('p', 'fb-header-meta', `详情：${this.lastErrorSummary}`));
      }
      const failedId = this.lastFeedbackId ?? this.lastRecord.id;
      card.append(
        el('p', 'fb-header-meta', `反馈标识：${failedId}（可在管理页据此找回原话与截图）`),
      );
      const actions = el('div', 'fb-card-actions');
      const refreshBtn = el(
        'button',
        'fb-btn-secondary fb-refresh-btn',
        this.refreshing ? '刷新中…' : '刷新状态',
      );
      refreshBtn.type = 'button';
      refreshBtn.setAttribute('aria-label', '刷新反馈处理状态');
      refreshBtn.disabled = this.refreshing;
      refreshBtn.addEventListener('click', () => void this.refreshLastRecord());
      const copyBtn = el('button', 'fb-btn-secondary fb-copy-id-btn', '复制标识');
      copyBtn.type = 'button';
      copyBtn.setAttribute('aria-label', '复制反馈标识');
      copyBtn.addEventListener('click', () => this.copyFeedbackId());
      const newBtn = el('button', 'fb-btn-secondary', '再记一条');
      newBtn.type = 'button';
      newBtn.hidden = accepted;
      newBtn.addEventListener('click', () => this.resetToCompose());
      actions.append(refreshBtn, copyBtn, newBtn);
      card.append(actions);
      this.errorRegion.append(card);
    }

    // 3. 状态：待核对 (needs_review from server record)
    else if (this.phase === 'needs_review') {
      this.errorRegion.hidden = false;
      const card = el('div', 'fb-status-card is-warn');
      card.append(el('p', undefined, '归档结果待确认。原话已保存，将在管理页人工复核。'));
      const actions = el('div', 'fb-card-actions');
      const newBtn = el('button', 'fb-btn-secondary', '再记一条');
      newBtn.type = 'button';
      newBtn.hidden = accepted;
      newBtn.addEventListener('click', () => this.resetToCompose());
      actions.append(newBtn);
      card.append(actions);
      this.errorRegion.append(card);
    }

    // 4. 状态：每日额度用尽（明确未接收，不提供「结果未知」重试）
    else if (this.phase === 'quota') {
      this.errorRegion.hidden = false;
      const card = el('div', 'fb-status-card is-warn');
      card.append(el('p', undefined, '今日提交次数已用完。文字与截图已保留，额度刷新后可直接再提交。'));
      if (this.quota) {
        const reset = new Date(this.quota.resetAt);
        if (Number.isFinite(reset.getTime())) {
          card.append(el('p', 'fb-header-meta', `下次可提交时间：${reset.toLocaleString()}`));
        }
      }
      this.errorRegion.append(card);
    }

    // 5. 状态：提交未成功（网络异常 / 5xx，尚未保存）
    else if (this.phase === 'failed' && !this.lastRecord) {
      this.errorRegion.hidden = false;
      const card = el('div', 'fb-status-card is-error');
      card.append(el('p', 'fb-error-summary', '尚未确认保存，请检查网络后重试。'));
      if (this.unconfirmedRequest) {
        // 结果未知的原请求被新编辑取代：保留标识与时间供人工核对，不静默覆盖
        const req = this.unconfirmedRequest;
        card.append(
          el(
            'p',
            'fb-header-meta',
            `已保留一条结果未知的原请求（标识 ${req.key.slice(0, 8)}…，截图时间 ${req.capturedAt ?? '未知'}），请先核对其是否已被服务端接收，避免重复提交。`,
          ),
        );
      }
      if (this.lastErrorSummary) {
        card.append(el('p', 'fb-header-meta', this.lastErrorSummary));
      }
      const actions = el('div', 'fb-card-actions');
      const retryBtn = el('button', 'fb-btn-secondary fb-retry fb-retry-btn', '重试提交');
      retryBtn.type = 'button';
      retryBtn.addEventListener('click', () => void this.submit());
      actions.append(retryBtn);
      card.append(actions);
      this.errorRegion.append(card);
    }

    // 5. 状态：处理中说明 / 等待管理员处理
    else if (this.phase === 'tracking') {
      this.errorRegion.hidden = false;
      const card = el('div', 'fb-status-card is-warn');
      if (this.waitingNotice !== null) {
        // T4：等待不是失败，也不是「正在处理」——明确说明等待什么，并提供手动刷新。
        card.append(el('p', undefined, this.waitingNotice));
        card.append(el('p', 'fb-header-meta', '无需重复提交；管理员处理后点「刷新状态」即可查看结果。'));
        const actions = el('div', 'fb-card-actions');
        const refreshBtn = el('button', 'fb-btn-secondary fb-refresh-btn', this.refreshing ? '刷新中…' : '刷新状态');
        refreshBtn.type = 'button';
        refreshBtn.setAttribute('aria-label', '刷新反馈处理状态');
        refreshBtn.disabled = this.refreshing;
        refreshBtn.addEventListener('click', () => void this.refreshLastRecord());
        const newBtn = el('button', 'fb-btn-secondary', '再记一条');
        newBtn.type = 'button';
      newBtn.hidden = accepted;
        newBtn.addEventListener('click', () => this.resetToCompose());
        actions.append(refreshBtn, newBtn);
        card.append(actions);
      } else {
        card.append(el('p', undefined, '已保存，正在整理。您可以关闭面板，我们将继续在后台处理。'));
      }
      this.errorRegion.append(card);
    }
  }

  // ---------- 键盘与焦点 ----------

  private onKeydown(ev: KeyboardEvent): void {
    // 图片编辑器打开期间：Esc / 快捷键全部由编辑器自己处理（Esc 取消、
    // Cmd/Ctrl+Z 撤销），面板层不响应——否则 Esc 会穿透关闭整个面板。
    if (this.editorHandle) return;
    // 局部选区覆盖层打开期间：按键由覆盖层自己处理（Esc=取消、回车=确认）
    if (this.regionSession) return;
    if (this.handledKey === ev) return;
    this.handledKey = ev;

    // 快捷键提交：桌面支持 ⌘/Ctrl + Enter（中文输入法组词期间不触发）
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      // 检查输入法合成状态
      if (!ev.isComposing && ev.keyCode !== 229) {
        if (!this.submitBtn.disabled) {
          ev.preventDefault();
          void this.onPrimaryAction();
          return;
        }
      }
    }

    // Esc 关闭：先关日志文本预览，再关全屏截图预览，再收设置视图，最后关闭反馈面板
    if (ev.key === 'Escape') {
      if (this.logPreviewModal && this.logPreviewModal.classList.contains('is-open')) {
        ev.preventDefault();
        this.closeLogPreview();
        return;
      }
      if (this.zoomModal && this.zoomModal.classList.contains('is-open')) {
        ev.preventDefault();
        this.closeZoomModal();
        return;
      }
      if (this.settingsOpen) {
        ev.preventDefault();
        this.closeServerSettings();
        return;
      }
      if (this.openState) {
        const active = this.root.activeElement;
        const inside =
          active !== null ||
          this.contains(document.activeElement) ||
          this === document.activeElement;
        if (inside) {
          ev.preventDefault();
          this.close();
          return;
        }
      }
    }

    // 移动端全屏模式进行模态焦点锁，桌面端允许 Tab 自然进出宿主
    if (ev.key === 'Tab' && this.openState && this.isMobile()) {
      const focusables = this.focusables();
      if (focusables.length === 0) return;
      const active = this.root.activeElement;
      const idx = active ? focusables.indexOf(active as HTMLElement) : -1;
      if (idx === -1) {
        ev.preventDefault();
        focusables[0]?.focus();
        return;
      }
      if (ev.shiftKey && idx === 0) {
        ev.preventDefault();
        focusables[focusables.length - 1]?.focus();
      } else if (!ev.shiftKey && idx === focusables.length - 1) {
        ev.preventDefault();
        focusables[0]?.focus();
      }
    }
  }

  private focusables(): HTMLElement[] {
    const nodes = this.panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), a[href], [tabindex="0"]',
    );
    // `[hidden]` 只是 display:none（见 styles.ts 的兜底规则），元素仍会被选择器选中：
    // 不排除隐藏节点，窄屏焦点锁会把焦点交给不可见元素（表现为焦点凭空消失）。
    return Array.from(nodes).filter((n) => n.closest('[hidden]') === null);
  }
}
