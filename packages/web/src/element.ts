import {
  ApiError,
  MAX_TEXT,
  codePointLength,
  getFeedback,
  submitFeedback,
  uuid,
  type FeedbackCaptureInfo,
  type FeedbackContext,
  type FeedbackRecord,
  type FeedbackStatus,
} from './api';
import { LoginHandshake, type AuthMessage } from './auth';
import { STYLES } from './styles';
import {
  CAPTURE_FAILURE_MESSAGE,
  CaptureError,
  captureViewport,
  countVisibleSensitiveRegions,
  logicalViewport,
  validateProviderResult,
  type CaptureProvider,
} from './capture';

interface DraftState {
  text: string;
  screenshotBlob: Blob | null;
  screenshotUrl: string | null;
  captureInfo: FeedbackCaptureInfo | null;
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
  /** 截图字节与元数据。 */
  blob: Blob | null;
  captureInfo: FeedbackCaptureInfo | null;
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

type Phase =
  | 'idle' // 可编辑可提交
  | 'submitting' // POST 进行中
  | 'tracking' // 201/200 后轮询（已接收/处理中）
  | 'archived' // 终态：已归档
  | 'failed' // 提交未成功（接口/网络报错）或服务端处理失败（failed/needs_review）
  | 'needs_review'; // 服务端标记需要人工核对

const POLL_START_MS = 2000;
const POLL_MAX_MS = 5000;
const POLL_BUDGET_MS = 120000; // ~2 分钟

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

function svgOrbIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'fb-orb-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '8.5');

  const centerDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  centerDot.setAttribute('cx', '12');
  centerDot.setAttribute('cy', '12');
  centerDot.setAttribute('r', '2.5');
  centerDot.setAttribute('fill', 'currentColor');

  svg.append(circle, centerDot);
  return svg;
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

export class FeedbackWidget extends HTMLElement {
  /** Shadow DOM 模式：默认 open；注册前可设 FeedbackWidget.shadowMode='closed'。 */
  static shadowMode: 'open' | 'closed' = 'open';

  static get observedAttributes(): string[] {
    return [
      'api-base',
      'app-id',
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
  /** 截图区 = 预览（有截图才可见）+ 操作区（没有截图时是「截取当前页面」）。 */
  private shotArea!: HTMLDivElement;
  private screenshotWrap!: HTMLDivElement;
  private screenshotThumbBox!: HTMLDivElement;
  private screenshotThumb!: HTMLImageElement;
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

  private phase: Phase = 'idle';
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollDelay = POLL_START_MS;
  private pollStartedAt = 0;
  private openState = false;
  private authRequired = false;
  private loginFallbackUrl: string | null = null;
  private lastLoginUrl: string | null = null;
  /** 手动刷新服务端记录状态进行中（按钮禁用 + 防重入）。 */
  private refreshing = false;

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
  private isCapturing = false;
  /** 进行中的捕获会话控制器：cancelCapture / 卸载时 abort，使旧会话失效。 */
  private captureController: AbortController | null = null;
  /** 捕获会话序号：新会话 / 失效操作递增；异步步骤后校验，旧会话结果一律丢弃。 */
  private captureSeq = 0;
  /** 正在进行的捕获会话：普通呼出合并到该会话，不重复发起。 */
  private captureInFlight: Promise<void> | null = null;

  /**
   * 未提交草稿：组件实例所有（断开重连保留字节并重建自己的预览 URL），
   * 仅存内存，刷新即弃，绝不用 localStorage；appId 变化时整体废弃，
   * 旧捕获/旧草稿不得写入新身份。
   */
  private readonly draft: DraftState = {
    text: '',
    screenshotBlob: null,
    screenshotUrl: null,
    captureInfo: null,
    version: 0,
  };

  /** 当前提交快照（冻结）；失败且草稿未变时复用（同 key 同字节重试）。 */
  private submitSnapshot: SubmitSnapshot | null = null;
  /** 结果未知的原提交请求：草稿被修改时保留供人工核对，不静默覆盖。 */
  private unconfirmedRequest: { key: string; capturedAt: string | null; textSummary: string } | null = null;

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

  /** 令牌仅存组件实例内存；页面刷新后靠重新握手恢复。 */
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  private idempotencyKey: string | null = null;
  private lastFeedbackId: string | null = null;
  private lastSubmittedText = '';
  private lastErrorSummary: string | null = null;
  private lastRecord: FeedbackRecord | null = null;

  private handshake: LoginHandshake | null = null;
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

  get appId(): string | null {
    return this.getAttribute('app-id');
  }
  set appId(v: string | null) {
    this.reflect('app-id', v);
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
    this.openState = true;
    this.launcher.classList.add('is-hidden');
    this.launcher.setAttribute('aria-expanded', 'true');
    this.orb.classList.add('is-hidden');
    this.orb.setAttribute('aria-expanded', 'true');
    this.panel.classList.add('is-open');
    this.panel.hidden = false;

    // 移动端设模态锁，桌面端不设
    this.updateAriaModal();

    // 打开时焦点移到 textarea（草稿已恢复）
    this.textarea.focus();

    // 键盘监听：Esc 与 Tab
    this.keydownHandler = (ev: KeyboardEvent) => this.onKeydown(ev);
    document.addEventListener('keydown', this.keydownHandler, true);

    if (this.phase === 'tracking') {
      void this.resumePolling();
    }
  }

  close(): void {
    // 即使面板尚未打开（先截图后开面板阶段），关闭也必须取消进行中的截图
    this.invalidateCaptureSession();
    this.captureInFlight = null;
    this.restoreCaptureUi();

    if (!this.openState) return;
    this.openState = false;
    this.closeZoomModal();
    this.panel.classList.remove('is-open');
    window.setTimeout(() => {
      if (!this.openState) this.panel.hidden = true;
    }, 200);

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
    this.isDragging = false;
    this.orb.classList.remove('is-dragging');
    this.orb.style.transform = '';
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
    this.restoreCaptureUi();
  }

  /** 恢复被捕获流程隐藏的组件 UI（会话失效方负责恢复）。 */
  private restoreCaptureUi(): void {
    this.panel.style.visibility = '';
    this.launcher.style.visibility = '';
    this.orb.style.visibility = '';
    this.isCapturing = false;
    // 会话结束（成功 / 失败 / 失效）后按钮必须回到真实可用性：
    // 首次失败保留手动重试入口，重拍失败保留旧图与文字。
    this.syncShotUi();
  }

  /** 草稿是否已有内容（有文字或截图的草稿再次呼出时恢复草稿、不重拍）。 */
  private isDraftDirty(): boolean {
    return this.draft.text.trim().length > 0 || this.draft.screenshotBlob !== null;
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
   * 截图区同步：**预览与操作分离**。
   * - 预览只在真的有可渲染 blob URL 时出现：绝不留下空 src 的破图占位
   *   （历史故障与其成因见 styles.ts 的 `[hidden]` 兜底注释）。
   * - 无截图 → 只显示「截取当前页面」，缩略图 / 放大 / 移除全部隐藏；
   *   有截图 → 预览 + 「重新截图 / 移除截图」；移除后回到首个入口，文字保留。
   * - 提交、轮询与捕获会话进行中，三个操作一律禁用（防重入）。
   */
  private syncShotUi(): void {
    if (!this.shotArea) return;
    const url = this.draft.screenshotUrl;
    const hasShot = this.draft.screenshotBlob !== null;
    const locked = this.phase === 'submitting' || this.polling || this.isCapturing;

    this.screenshotWrap.hidden = url === null;
    if (url !== null) this.screenshotThumb.src = url;
    // 无截图时连 src 一起撤掉：移除 / 清空草稿会 revoke 旧 blob URL，
    // 留着它就是一条「有 src 却加载失败」的破图记录（历史故障形态）。
    else this.screenshotThumb.removeAttribute('src');
    // 无截图时缩略图必须离开 tab 序列：`[hidden]` 只是 display:none，
    // 仍会被焦点锁选中，把焦点交给不可见元素（表现为焦点凭空消失）。
    this.screenshotThumbBox.tabIndex = url === null ? -1 : 0;

    this.captureBtn.hidden = hasShot;
    this.retakeBtn.hidden = !hasShot;
    this.removeBtn.hidden = !hasShot;

    this.captureBtn.disabled = locked;
    this.retakeBtn.disabled = locked;
    this.removeBtn.disabled = locked;

    // 加载态：捕获期间面板整体 `visibility: hidden`，因此这里的文案与 aria-busy
    // 不可能被拍进截图；它保证会话结束后与辅助技术读到的是真实状态。
    this.captureBtn.textContent = this.isCapturing ? CAPTURE_BUSY_LABEL : CAPTURE_ACTION_LABEL;
    if (this.isCapturing) this.captureBtn.setAttribute('aria-busy', 'true');
    else this.captureBtn.removeAttribute('aria-busy');
    this.shotArea.classList.toggle('is-capturing', this.isCapturing);
  }

  /** 单次捕获会话主体：每个异步步骤后与更新草稿 / 开面板前都校验会话有效性。 */
  private async runCapture(opts: { releasePoint?: { x: number; y: number } }): Promise<void> {
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
    this.panel.style.visibility = 'hidden';
    this.launcher.style.visibility = 'hidden';
    this.orb.style.visibility = 'hidden';

    let captureFailure: string | null = null;

    try {
      if (signal.aborted || !active()) throw new CaptureError('aborted', '截图会话已失效');

      if (typeof window === 'undefined') throw new CaptureError('locate-failed', '无可用 window 环境');
      const viewport = logicalViewport(window);

      // 有效且仍可见的敏感区域（坐标非有限会抛错，不允许静默跳过）
      const sensitiveRegionCount = countVisibleSensitiveRegions(document, {
        ignore: (el) => this.isOwnFeedbackUi(el),
      });

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
      // 失败路径不触碰 draft——旧草稿与旧截图原样保留。
      if (this.draft.screenshotUrl) {
        URL.revokeObjectURL(this.draft.screenshotUrl);
      }
      this.draft.screenshotBlob = blob;
      this.draft.screenshotUrl = URL.createObjectURL(blob);
      this.draft.captureInfo = {
        viewportWidth,
        viewportHeight,
        pixelWidth,
        pixelHeight,
        capturedAt: new Date().toISOString(),
        ...(opts.releasePoint ? { releasePoint: opts.releasePoint } : {}),
      };
      this.draft.version++;
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
    if (!wasOpen) {
      this.open();
    }
    this.syncUi();
    if (captureFailure) {
      this.renderStatus(captureFailure);
    }
  }

  private openZoomModal(): void {
    if (!this.draft.screenshotUrl) return;
    this.zoomImg.src = this.draft.screenshotUrl;
    this.zoomModal.classList.add('is-open');
  }

  private closeZoomModal(): void {
    if (this.zoomModal) {
      this.zoomModal.classList.remove('is-open');
    }
  }

  /** 移除截图：同时移除落点与时间（captureInfo 整体废弃），并递增草稿版本。 */
  private removeScreenshot(): void {
    // 与按钮禁用态一致（截图 / 移除在提交与轮询期间一并禁用）：
    // 已冻结的快照不会被面板上的操作分叉。
    if (this.phase === 'submitting' || this.polling) return;
    if (this.draft.screenshotUrl) {
      URL.revokeObjectURL(this.draft.screenshotUrl);
      this.draft.screenshotUrl = null;
    }
    this.draft.screenshotBlob = null;
    this.draft.captureInfo = null;
    this.draft.version++;
    this.syncUi();
  }

  /** 清空草稿（提交成功后 / appId 变化时），字节与预览 URL 一并释放。 */
  private clearDraft(): void {
    this.draft.text = '';
    if (this.draft.screenshotUrl) {
      URL.revokeObjectURL(this.draft.screenshotUrl);
      this.draft.screenshotUrl = null;
    }
    this.draft.screenshotBlob = null;
    this.draft.captureInfo = null;
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
    this.submitBtn.addEventListener('click', () => void this.onPrimaryAction());
  }

  connectedCallback(): void {
    if (!this.hasAttribute('side')) this.setAttribute('side', 'right');
    this.updateLauncherBottomCss();
    this.updateMetaInfo();

    // 断开重连：截图字节保留在实例草稿中，重连时重建自己的预览 URL
    if (this.draft.screenshotBlob && !this.draft.screenshotUrl) {
      this.draft.screenshotUrl = URL.createObjectURL(this.draft.screenshotBlob);
    }
    this.syncUi();
  }

  disconnectedCallback(): void {
    // 卸载使进行中的捕获会话失效：旧截图结果不得再写入草稿
    this.invalidateCaptureSession();
    this.captureInFlight = null;
    this.stopPolling();
    this.handshake?.cancel();
    // 取消后必须丢弃引用：否则重挂载后的登录会误判"已有握手"而永不开窗
    this.handshake = null;
    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler, true);
      this.keydownHandler = null;
    }
    // 断开只释放预览 URL；截图字节保留在实例草稿中，重连时重建
    if (this.draft.screenshotUrl) {
      URL.revokeObjectURL(this.draft.screenshotUrl);
      this.draft.screenshotUrl = null;
    }
  }

  attributeChangedCallback(name: string, oldVal: string | null, newVal: string | null): void {
    if (name === 'api-base' && oldVal !== newVal) {
      // 服务身份切换：先递增世代（在途请求全部作废），再清空属于旧服务的一切
      this.identityEpoch++;
      this.resetForServiceSwitch();
    }
    if (name === 'app-id' && oldVal !== newVal) {
      // 同一服务内的应用身份变化：令牌保留，草稿 / 捕获 / 结果 / 握手整体作废
      this.identityEpoch++;
      this.resetForAppIdSwitch();
    }
    if (name === 'launcher-bottom') {
      this.updateLauncherBottomCss();
    }
    if (name === 'app-version' || name === 'page-label') {
      this.updateMetaInfo();
    }
    // theme / side / show-launcher / capture-mode 不触碰草稿、令牌、任务态与截图
  }

  /**
   * `api-base` 变化 = 完整身份切换：取消并清空一切属于旧服务的东西
   * （捕获会话 / 提交快照 / 幂等键 / 握手 / 轮询 / 令牌 / 任务态 / 草稿）。
   * 新服务必须重新登录，旧令牌绝不外泄给新基址；旧服务的迟到响应由 epoch 校验丢弃。
   */
  private resetForServiceSwitch(): void {
    this.invalidateCaptureSession();
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
    this.loginFallbackUrl = null;
    this.lastLoginUrl = null;
    if (this.handshake) {
      this.handshake.cancel();
      this.handshake = null;
    }
    this.lastFeedbackId = null;
    this.lastRecord = null;
    this.lastErrorSummary = null;
    this.lastSubmittedText = '';
    this.refreshing = false;
    this.phase = 'idle';
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
    this.invalidateCaptureSession();
    this.captureInFlight = null;
    this.restoreCaptureUi();
    this.stopPolling();
    this.pollDelay = POLL_START_MS;
    this.pollStartedAt = 0;
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
    // 旧身份的握手（登录页 URL 携带旧 appId）一并作废；令牌保留
    if (this.handshake) {
      this.handshake.cancel();
      this.handshake = null;
      this.pendingSubmit = false;
      this.loginFallbackUrl = null;
    }
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

  private initOrbGesture(): void {
    let startX = 0;
    let startY = 0;
    let isPointerDown = false;

    this.orb.addEventListener('pointerdown', (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      startX = ev.clientX;
      startY = ev.clientY;
      isPointerDown = true;
      this.isDragging = false;
      this.orbPointerId = ev.pointerId;
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
          this.orb.classList.add('is-dragging');
        }
      }
      if (this.isDragging) {
        this.orb.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.1)`;
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
      this.isDragging = false;
      this.orb.classList.remove('is-dragging');
      this.orb.style.transform = '';

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
        void this.captureAndOpen({ releasePoint });
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
    this.launcher.append(launcherIcon, launcherText);

    // 灵感球 (Inspiration Orb)
    this.orb = el('button', 'fb-launcher fb-orb');
    this.orb.type = 'button';
    this.orb.setAttribute('aria-label', '灵感球：拖动指出问题或点击反馈');
    this.orb.setAttribute('aria-expanded', 'false');
    this.orb.setAttribute('aria-controls', 'fb-panel');
    this.orb.append(svgOrbIcon());

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

    const closeBtn = el('button', 'fb-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '关闭反馈面板');
    closeBtn.append(svgCloseIcon());
    closeBtn.addEventListener('click', () => this.close());
    header.append(titleGroup, closeBtn);

    // 主体
    const body = el('div', 'fb-body');

    // 截图区：图片预览与操作区**分开**。
    // 预览只在有截图时出现（无截图时连缩略图一起隐藏，避免空 src 破图占位）；
    // 操作区始终在：没有截图时是「截取当前页面」——默认 capture-mode="off"
    // （不自动截图）宿主在「先输入文字」之后唯一的手动补拍入口。
    this.shotArea = el('div', 'fb-shot-area');

    this.screenshotWrap = el('div', 'fb-screenshot-wrap');
    this.screenshotWrap.hidden = true;

    this.screenshotThumbBox = el('div', 'fb-screenshot-thumb-box');
    this.screenshotThumbBox.setAttribute('role', 'button');
    this.screenshotThumbBox.setAttribute('tabindex', '0');
    this.screenshotThumbBox.setAttribute('aria-label', '查看完整截图');

    this.screenshotThumb = el('img', 'fb-screenshot-thumb');
    this.screenshotThumb.alt = '反馈截图缩略图';

    const badge = el('span', 'fb-screenshot-badge', '当前截图');
    const zoomHint = el('span', 'fb-screenshot-zoom-hint', '点击放大');
    this.screenshotThumbBox.append(this.screenshotThumb, badge, zoomHint);
    this.screenshotWrap.append(this.screenshotThumbBox);

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

    screenshotActions.append(this.captureBtn, this.retakeBtn, this.removeBtn);
    this.shotArea.append(this.screenshotWrap, screenshotActions);

    this.captureBtn.addEventListener('click', () => this.captureFromPanel());

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

    // 底部操作区：提交/登录按钮 + 次要说明
    const footer = el('footer', 'fb-footer');
    this.submitBtn = el('button', 'fb-submit', '提交');
    this.submitBtn.type = 'button';
    this.submitBtn.setAttribute('aria-label', '提交反馈');

    const footnote = el('p', 'fb-footnote', '会保留原话，整理为候选改进');
    footer.append(this.submitBtn, footnote);

    body.append(this.shotArea, promptLabel, textareaWrap, this.statusRegion, this.errorRegion, footer);
    this.panel.append(header, body);

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

    this.root.append(style, this.launcher, this.orb, this.panel, this.zoomModal);

    // 监听按键（支持 ⌘/Ctrl + Enter 提交）
    this.addEventListener('keydown', (ev: KeyboardEvent) => this.onKeydown(ev));
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
    const apiBase = this.apiBase;
    const appId = this.appId;
    if (!apiBase || !appId) {
      this.failPhase('缺少必填配置：api-base / app-id');
      return;
    }

    // ---- 冻结快照：请求标识 / 应用与来源 / 原话 / 截图字节 / 元数据 / 草稿版本 ----
    // 草稿未变 → 复用现有快照（重试走同 key 同字节）；
    // 草稿已变且原请求结果未知 → 先保留原请求供核对，再冻结新快照。
    let snap = this.submitSnapshot;
    const snapshotMatchesDraft =
      snap !== null &&
      snap.draftVersion === this.draft.version &&
      snap.text === this.textarea.value &&
      snap.blob === this.draft.screenshotBlob &&
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
      snap = {
        key: uuid(),
        apiBase,
        appId,
        context,
        text,
        blob: this.draft.screenshotBlob,
        captureInfo: this.draft.captureInfo ? { ...this.draft.captureInfo } : null,
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
    this.loginFallbackUrl = null;
    this.renderStatus('提交中…');
    this.syncUi();

    try {
      // HTTP 只读快照：提交期间的草稿变化不影响本次请求字节
      const res = await submitFeedback(frozen.apiBase, this.accessToken as string, {
        idempotencyKey: frozen.key,
        appId: frozen.appId,
        text: frozen.text,
        ...(Object.keys(frozen.context).length ? { context: frozen.context } : {}),
        ...(frozen.captureInfo ? { capture: frozen.captureInfo } : {}),
        ...(frozen.blob ? { screenshot: frozen.blob } : {}),
      });

      // 201/200 后才清空输入与截图，快照随之消费
      // 身份已切换 → 结果为旧服务所有：不写任务态、不清草稿、不派发事件、不轮询
      if (epoch !== this.identityEpoch) return;
      this.lastFeedbackId = res.feedbackId;
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
      this.renderStatus('已保存，正在整理');
      this.dispatchEvent(
        new CustomEvent<FeedbackSubmittedDetail>('feedback-submitted', {
          detail: { feedbackId: res.feedbackId, status: res.status, replayed: res.replayed === true },
          bubbles: true,
          composed: true,
        }),
      );
      this.syncUi();
      this.startPolling(res.feedbackId);
    } catch (err) {
      // 身份已切换 → 旧服务的失败同样不得改写新身份的状态（含 401 清令牌）
      if (epoch !== this.identityEpoch) return;
      if (err instanceof ApiError && err.status === 401) {
        // 令牌过期/无效：保留草稿与快照（登录后重发仍同 key 同字节），提示登录
        this.accessToken = null;
        this.tokenExpiresAt = 0;
        this.authRequired = true;
        this.phase = 'idle';
        this.renderStatus('需要登录（登录已过期）');
        this.syncUi();
        return;
      }
      this.phase = 'failed';
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
    const apiBase = this.apiBase;
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
    try {
      record = await getFeedback(apiBase, this.accessToken as string, id);
    } catch (err) {
      if (epoch !== this.identityEpoch) return; // 身份已切换：旧服务的错误一律丢弃
      if (err instanceof ApiError && err.status === 401) {
        this.polling = false;
        this.accessToken = null;
        this.authRequired = true;
        this.renderStatus('登录已过期，请重新登录后继续查看进度。');
        this.syncUi();
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
    const apiBase = this.apiBase;
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
    this.refreshing = true;
    this.renderStatus('正在刷新状态…');
    this.syncUi();

    try {
      const record = await getFeedback(apiBase, this.accessToken as string, id);
      if (epoch !== this.identityEpoch) return; // 身份已切换：旧服务的记录一律丢弃

      if (isTerminalStatus(record.status)) {
        this.stopPolling();
        this.applyRecordState(record);
        return;
      }

      // 仍在整理中：回到跟踪态并继续轮询（只读，不会重复提交）
      this.lastRecord = record;
      this.phase = 'tracking';
      this.renderStatus('已保存，正在整理');
      this.syncUi();
      if (!this.polling) this.startPolling(id);
    } catch (err) {
      if (epoch !== this.identityEpoch) return;
      if (err instanceof ApiError && err.status === 401) {
        this.accessToken = null;
        this.tokenExpiresAt = 0;
        this.authRequired = true;
        this.renderStatus('登录已过期，请重新登录后继续查看进度。');
        this.syncUi();
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

  // ---------- 登录握手 ----------

  private pendingSubmit = false;

  private beginLogin(pendingSubmit: boolean): void {
    const apiBase = this.apiBase;
    const appId = this.appId;
    if (!apiBase || !appId) {
      this.failPhase('缺少必填配置：api-base / app-id');
      return;
    }
    this.authRequired = true;
    this.pendingSubmit = pendingSubmit;
    if (this.handshake) {
      // 若已有握手在进行，更新 pendingSubmit 标记即可，不丢失当前 nonce
      return;
    }
    this.loginFallbackUrl = null;
    // 握手绑定发起时的服务身份：身份切换后的令牌回调一律 no-op
    const epoch = this.identityEpoch;
    const handshake = new LoginHandshake({
      apiBase,
      appId,
      hostOrigin: location.origin,
      onToken: (msg: AuthMessage) => {
        if (epoch !== this.identityEpoch) {
          // 旧身份的令牌绝不写入新身份，并丢弃这次失效的握手
          if (this.handshake === handshake) {
            handshake.cancel();
            this.handshake = null;
          }
          return;
        }
        this.accessToken = msg.accessToken;
        const exp = Date.parse(msg.expiresAt);
        this.tokenExpiresAt = Number.isFinite(exp) ? exp : Date.now() + 15 * 60_000;
        this.authRequired = false;
        this.loginFallbackUrl = null;
        this.handshake = null;
        this.renderStatus('已登录。');
        this.syncUi();
        if (this.pendingSubmit && codePointLength(this.textarea.value) > 0) {
          this.pendingSubmit = false;
          void this.submit();
        } else if (this.phase === 'tracking') {
          void this.resumePolling();
        }
      },
      onPopupBlocked: (loginUrl: string) => {
        if (epoch !== this.identityEpoch) return; // 同上：旧身份的登录页链接不再展示
        this.loginFallbackUrl = loginUrl;
        this.syncUi();
      },
    });
    this.handshake = handshake;
    const ticket = handshake.start();
    this.lastLoginUrl = ticket.loginUrl;
    this.handshake.openPopup(ticket);
    this.renderStatus('请在打开的登录窗口完成登录…（需要登录）');
    this.syncUi();
  }

  startLogin(): string {
    this.handshake?.cancel();
    this.handshake = null;
    this.beginLogin(false);
    return this.lastLoginUrl ?? '';
  }

  private resetToCompose(): void {
    this.stopPolling();
    this.phase = 'idle';
    this.lastFeedbackId = null;
    this.lastRecord = null;
    this.lastErrorSummary = null;
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
    const busy = this.phase === 'submitting' || this.polling;

    // 截图区同步：预览 / 首个截图入口 / 重拍 / 移除
    this.syncShotUi();

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
      this.submitBtn.disabled = busy || len === 0 || len > MAX_TEXT;
    } else {
      this.submitBtn.className = 'fb-submit';
      this.submitBtn.textContent = '提交';
      this.submitBtn.disabled = busy || len === 0 || len > MAX_TEXT || this.phase === 'tracking';
    }

    // 状态卡片构建
    this.errorRegion.textContent = '';
    this.errorRegion.hidden = true;

    // 1. 已归档卡片
    if (this.phase === 'archived') {
      this.errorRegion.hidden = false;
      const card = el('div', 'fb-status-card is-success');
      card.append(el('p', undefined, '反馈已归档。感谢你的支持！'));

      const actions = el('div', 'fb-card-actions');
      if (this.lastRecord?.kaneoUrl) {
        const link = el('a', 'fb-task-link', '查看任务');
        link.href = this.lastRecord.kaneoUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.setAttribute('aria-label', '打开 Kaneo 归档任务');
        actions.append(link);
      }
      const newBtn = el('button', 'fb-btn-secondary', '再记一条');
      newBtn.type = 'button';
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
      newBtn.addEventListener('click', () => this.resetToCompose());
      actions.append(newBtn);
      card.append(actions);
      this.errorRegion.append(card);
    }

    // 4. 状态：提交未成功（网络异常 / 5xx，尚未保存）
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

    // 5. 状态：处理中说明
    else if (this.phase === 'tracking') {
      this.errorRegion.hidden = false;
      const card = el('div', 'fb-status-card is-warn');
      card.append(el('p', undefined, '已保存，正在整理。您可以关闭面板，我们将继续在后台处理。'));
      this.errorRegion.append(card);
    }

    // 6. 弹窗被拦截降级链接
    if (this.loginFallbackUrl) {
      this.errorRegion.hidden = false;
      const card = el('div', 'fb-status-card is-warn');
      card.append(el('p', undefined, '登录弹窗可能被浏览器拦截，请点击下方链接完成登录：'));
      const a = el('a', 'fb-task-link fb-login-link', '打开登录窗口');
      a.href = this.loginFallbackUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      card.append(a);
      this.errorRegion.append(card);
    }
  }

  // ---------- 键盘与焦点 ----------

  private onKeydown(ev: KeyboardEvent): void {
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

    // Esc 关闭：先关闭全屏截图预览，再关闭反馈面板
    if (ev.key === 'Escape') {
      if (this.zoomModal && this.zoomModal.classList.contains('is-open')) {
        ev.preventDefault();
        this.closeZoomModal();
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
      'button:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]',
    );
    // `[hidden]` 只是 display:none（见 styles.ts 的兜底规则），元素仍会被选择器选中：
    // 不排除隐藏节点，窄屏焦点锁会把焦点交给不可见元素（表现为焦点凭空消失）。
    return Array.from(nodes).filter((n) => n.closest('[hidden]') === null);
  }
}
