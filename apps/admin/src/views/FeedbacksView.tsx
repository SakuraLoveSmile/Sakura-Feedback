/**
 * 反馈工作台：收件箱 / 已归档 / 回收站。
 * - URL 保存 view/q/status/appId/from/to/id，刷新与前进后退可恢复；
 * - 搜索防抖 300ms、上限 200 字符；游标分页每页 50；
 * - 有活动处理时每 5 秒原位刷新（不打断选择、详情与草稿），页面隐藏停止；
 * - 批量只操作已勾选记录（超过服务端单次上限 100 条时自动分片），逐项结果不回滚。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  api,
  type FeedbackAppOption,
  type FeedbackCounts,
  type FeedbackDetail,
  type FeedbackListItem,
  type LifecycleAction,
  type LifecycleBatchResponse,
  type LifecycleItemResult,
  type MgmtView,
  STATUS_LABELS,
  VIEW_LABELS,
} from "../api.ts";
import { ConfirmDialog, EmptyState, Icon, InlineError, MoreMenu, SkeletonRows, useToast } from "../ui.tsx";
import { useUrlState } from "../url.ts";
import FeedbackDrawer from "./FeedbackDrawer.tsx";

const STATUSES = Object.keys(STATUS_LABELS);
const VIEWS: MgmtView[] = ["inbox", "archived", "trash"];
const PAGE_SIZE = 50;
const POLL_MS = 5000;
/** 仍在活动处理中的状态（驱动轮询）。 */
const ACTIVE_STATUSES = new Set(["received", "processing", "archiving"]);

/** 本地日期输入 → UTC ISO（from 含边界；to 传次日凌晨作半开区间上界）。 */
function dayToIso(day: string, end: boolean): string | undefined {
  if (!day) return undefined;
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return undefined;
  if (end) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

interface PendingConfirm {
  kind: "trash" | "purge";
  items: { id: string; expectedVersion: number }[];
  /** needs_review 或已有远端关联的记录数（额外提示）。 */
  remoteCount: number;
}

export default function FeedbacksView() {
  const toast = useToast();
  const [params, setParams] = useUrlState();

  const view = (VIEWS.includes(params.get("view") as MgmtView) ? params.get("view") : "inbox") as MgmtView;
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const appId = params.get("appId") ?? "";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const detailId = params.get("id");

  const [items, setItems] = useState<FeedbackListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<FeedbackCounts | null>(null);
  const [appOptions, setAppOptions] = useState<FeedbackAppOption[]>([]);
  const [loading, setLoading] = useState<"initial" | "more" | "poll" | null>("initial");
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hasNew, setHasNew] = useState(false);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [batchResult, setBatchResult] = useState<{
    action: string;
    failures: { id: string; message: string }[];
  } | null>(null);
  const [detail, setDetail] = useState<FeedbackDetail | "loading" | "purged" | "error" | null>(null);
  /** 详情拉取失败后的重试计数：自增触发详情 effect 重新请求。 */
  const [detailRetry, setDetailRetry] = useState(0);
  /** 列表请求序号：切换筛选/区域后的迟到响应直接丢弃，不回写旧数据。 */
  const listSeq = useRef(0);
  /** 计数请求序号：同 listSeq——筛选快速变化时迟到计数不得回写。 */
  const countsSeq = useRef(0);
  /** 详情身份与请求序号：切换或关闭抽屉后，迟到响应不得回写新详情。 */
  const detailIdentityRef = useRef<string | null>(detailId);
  const detailRequestSeq = useRef(0);
  if (detailIdentityRef.current !== detailId) {
    detailIdentityRef.current = detailId;
    detailRequestSeq.current += 1;
  }

  // 搜索输入防抖 300ms：本地草稿即时回显，防抖后写入 URL（replace，不产生历史）。
  const [qDraft, setQDraft] = useState(q);
  useEffect(() => setQDraft(q), [q]);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // 卸载时取消防抖：否则切换页面后迟到的写入会把 ?q= 拼到目标页 URL 上。
  useEffect(() => () => clearTimeout(debounceRef.current), []);
  const onSearch = useCallback(
    (v: string) => {
      const clipped = v.slice(0, 200);
      setQDraft(clipped);
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => setParams({ q: clipped }, true), 300);
    },
    [setParams],
  );

  const filterQuery = useCallback(
    (extra?: Record<string, string>) => {
      const p = new URLSearchParams();
      if (status) p.set("status", status);
      if (appId) p.set("appId", appId);
      if (q) p.set("q", q);
      const f = dayToIso(from, false);
      const t = dayToIso(to, true);
      if (f) p.set("from", f);
      if (t) p.set("to", t);
      for (const [k, v] of Object.entries(extra ?? {})) p.set(k, v);
      return p.toString();
    },
    [status, appId, q, from, to],
  );

  const loadList = useCallback(
    async (mode: "reset" | "more" | "poll") => {
      // 轮询刷新窗口 = 已加载条数（封顶 100，与服务端 limit 上限一致）。
      const limit = mode === "poll" ? Math.min(Math.max(items.length, PAGE_SIZE), 100) : PAGE_SIZE;
      const p = new URLSearchParams(filterQuery({ view, limit: String(limit) }));
      if (mode === "more" && nextCursor) p.set("cursor", nextCursor);
      const seq = ++listSeq.current;
      setLoading(mode === "poll" ? "poll" : mode === "reset" ? "initial" : "more");
      try {
        const r = await api.get<{ items: FeedbackListItem[]; nextCursor: string | null }>(
          `/api/admin/feedback?${p.toString()}`,
        );
        if (seq !== listSeq.current) return; // 迟到响应丢弃
        if (mode === "more") {
          setItems((prev) => [...prev, ...r.items.filter((i) => !prev.some((x) => x.id === i.id))]);
          setNextCursor(r.nextCursor);
        } else if (mode === "poll") {
          // 原位刷新：响应窗口内的记录按 id 更新；未出现在响应中的已加载项保留，
          // 因为它们可能位于服务端返回窗口之外。顶部出现的全新记录不自动插入，只提示“有新反馈”。
          setItems((prev) => {
            const fresh = new Map(r.items.map((i) => [i.id, i]));
            const windowTail = r.items.at(-1);
            const next: FeedbackListItem[] = [];
            for (const it of prev) {
              const f = fresh.get(it.id);
              if (f) next.push(f);
              else if (
                r.nextCursor &&
                windowTail &&
                (it.createdAt < windowTail.createdAt ||
                  (it.createdAt === windowTail.createdAt && it.id < windowTail.id))
              ) {
                next.push(it); // 早于响应尾项的记录在窗口外，保留分页/勾选项
              }
            }
            if (r.items.some((i) => !prev.some((x) => x.id === i.id))) setHasNew(true);
            setSelected((sel) => new Set([...sel].filter((id) => next.some((i) => i.id === id))));
            return next;
          });
        } else {
          setItems(r.items);
          setNextCursor(r.nextCursor);
          setHasNew(false);
        }
        setListError(null);
      } catch (err) {
        if (seq === listSeq.current && mode !== "poll") {
          setListError(err instanceof ApiError ? err.message : "加载失败");
        }
      } finally {
        if (seq === listSeq.current) setLoading(null);
      }
    },
    [filterQuery, view, nextCursor, items.length],
  );

  const loadCounts = useCallback(async () => {
    const seq = ++countsSeq.current;
    try {
      const r = await api.get<FeedbackCounts>(`/api/admin/feedback/counts?${filterQuery()}`);
      if (seq === countsSeq.current) setCounts(r); // 快速切换筛选时丢弃迟到计数，避免旧筛选的数字覆盖新筛选
    } catch {
      /* 计数失败不打断列表 */
    }
  }, [filterQuery]);

  // 筛选/区域变化：重置列表与选择（详情按 id 独立保留）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在筛选参数变化时重置；loadList/loadCounts 引用最新闭包
  useEffect(() => {
    setSelected(new Set());
    setNextCursor(null);
    setItems([]);
    setLoading("initial");
    void loadList("reset");
    void loadCounts();
  }, [view, q, status, appId, from, to]);

  useEffect(() => {
    api.get<{ items: FeedbackAppOption[] }>("/api/admin/feedback/app-options").then(
      (r) => setAppOptions(r.items),
      () => undefined,
    );
  }, []);

  // 详情抽屉：由 URL id 驱动；410 显示已删除提示。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅随 URL id 重新拉取详情；toast 为稳定引用
  useEffect(() => {
    if (!detailId) {
      setDetail(null);
      return;
    }
    const requestedId = detailId;
    const requestSeq = ++detailRequestSeq.current;
    let alive = true;
    setDetail("loading");
    api
      .get<FeedbackDetail>(`/api/admin/feedback/${requestedId}`)
      .then(
        (d) =>
          alive && requestSeq === detailRequestSeq.current && detailIdentityRef.current === requestedId && setDetail(d),
      )
      .catch((err) => {
        if (!alive || requestSeq !== detailRequestSeq.current || detailIdentityRef.current !== requestedId) return;
        if (err instanceof ApiError && err.status === 410) setDetail("purged");
        else {
          setDetail("error");
          toast("err", err instanceof ApiError ? err.message : "加载详情失败");
        }
      });
    return () => {
      alive = false;
    };
  }, [detailId, detailRetry]);

  // 轮询：页面可见且存在活动处理时每 5 秒原位刷新；隐藏即停，重新可见立即刷新。
  const hasActive =
    items.some((i) => ACTIVE_STATUSES.has(i.status)) ||
    (detail !== null && typeof detail === "object" && ACTIVE_STATUSES.has(detail.status));
  // tick 经 ref 取最新引用：刷新窗口随已加载条数变化、详情状态实时读取，无需重建定时器。
  const pollRef = useRef({ loadList, loadCounts, detail });
  pollRef.current = { loadList, loadCounts, detail };
  useEffect(() => {
    if (!hasActive) return;
    let stopped = false;
    const tick = () => {
      if (document.visibilityState === "visible") {
        const { loadList: refresh, loadCounts: refreshCounts, detail: d } = pollRef.current;
        void refresh("poll");
        void refreshCounts();
        if (detailId && d !== "loading" && d !== "purged") {
          const requestedId = detailId;
          const requestSeq = ++detailRequestSeq.current;
          api
            .get<FeedbackDetail>(`/api/admin/feedback/${requestedId}`)
            .then((x) => {
              if (requestSeq === detailRequestSeq.current && detailIdentityRef.current === requestedId) setDetail(x);
            })
            .catch(() => undefined);
        }
      }
    };
    const timer = setInterval(tick, POLL_MS);
    const onVis = () => !stopped && tick();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [hasActive, detailId]);

  // ---------- 生命周期动作 ----------

  const refreshAfterAction = useCallback(async () => {
    const requestedId = detailId;
    const requestSeq = detailId ? ++detailRequestSeq.current : detailRequestSeq.current;
    await Promise.all([loadList("reset"), loadCounts()]);
    if (requestedId && requestSeq === detailRequestSeq.current && detailIdentityRef.current === requestedId) {
      try {
        const next = await api.get<FeedbackDetail>(`/api/admin/feedback/${requestedId}`);
        if (requestSeq === detailRequestSeq.current && detailIdentityRef.current === requestedId) setDetail(next);
      } catch (err) {
        if (requestSeq !== detailRequestSeq.current || detailIdentityRef.current !== requestedId) return;
        if (err instanceof ApiError && err.status === 410) setDetail("purged");
        else setDetail("error"); // 刷新失败与首次加载一致：给出可重试的错误态，不留陈旧详情
      }
    }
  }, [loadList, loadCounts, detailId]);

  const runLifecycle = useCallback(
    async (action: LifecycleAction, targets: { id: string; expectedVersion: number }[]): Promise<boolean> => {
      try {
        // 服务端单次批量上限 100：选中更多已加载记录时按 100 分片顺序提交并合并逐项结果。
        const results: LifecycleItemResult[] = [];
        for (let i = 0; i < targets.length; i += 100) {
          const r = await api.post<LifecycleBatchResponse>("/api/admin/feedback/lifecycle", {
            action,
            items: targets.slice(i, i + 100),
          });
          results.push(...r.results);
        }
        const failures = results.filter((x) => !x.ok);
        const okIds = new Set(results.filter((x) => x.ok).map((x) => x.id));
        setSelected((sel) => new Set([...sel].filter((id) => !okIds.has(id))));
        if (failures.length === 0) {
          toast("ok", `已完成「${actionLabel(action)}」${results.length} 条`);
        } else {
          setBatchResult({
            action: actionLabel(action),
            failures: failures.map((f) => ({ id: f.id, message: f.message ?? f.code ?? "失败" })),
          });
        }
        await refreshAfterAction();
        return failures.length === 0;
      } catch (err) {
        // 单条失败时服务端直接返回错误状态；批量入口本身失败也走这里。
        toast("err", err instanceof ApiError ? err.message : "操作失败");
        await refreshAfterAction();
        return false;
      }
    },
    [toast, refreshAfterAction],
  );

  /** 单条动作（详情抽屉用）：成功后刷新详情与列表。 */
  const singleAction = useCallback(
    async (action: LifecycleAction, id: string) => {
      const item = items.find((i) => i.id === id);
      const detailItem = typeof detail === "object" && detail?.id === id ? detail : null;
      const expectedVersion = detailItem?.lifecycleVersion ?? item?.lifecycleVersion ?? 0;
      return runLifecycle(action, [{ id, expectedVersion }]);
    },
    [items, detail, runLifecycle],
  );

  function askTrash(targets: FeedbackListItem[]) {
    const remoteCount = targets.filter((i) => i.status === "needs_review" || i.kaneoUrl).length;
    setConfirm({
      kind: "trash",
      items: targets.map((i) => ({ id: i.id, expectedVersion: i.lifecycleVersion })),
      remoteCount,
    });
  }
  function askPurge(targets: FeedbackListItem[]) {
    const remoteCount = targets.filter((i) => i.status === "needs_review" || i.kaneoUrl).length;
    setConfirm({
      kind: "purge",
      items: targets.map((i) => ({ id: i.id, expectedVersion: i.lifecycleVersion })),
      remoteCount,
    });
  }

  const selectedItems = items.filter((i) => selected.has(i.id));
  const allChecked = items.length > 0 && items.every((i) => selected.has(i.id));

  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(items.map((i) => i.id)));
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const openDetail = useCallback((id: string) => setParams({ id }, false), [setParams]);
  const closeDetail = useCallback(() => setParams({ id: null }, false), [setParams]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>反馈</h1>
          <div className="sub">收件箱只保留需要关注的反馈；已同步内容可整理，测试数据可安全清理。</div>
        </div>
        <button
          type="button"
          className="btn"
          disabled={loading === "initial"}
          onClick={() => {
            setHasNew(false);
            void loadList("reset");
            void loadCounts();
          }}
        >
          <Icon name="refresh" size={16} />
          刷新
        </button>
      </div>

      <div className="view-tabs" role="tablist" aria-label="反馈区域">
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            className={`view-tab${view === v ? " active" : ""}`}
            onClick={() => setParams({ view: v === "inbox" ? null : v }, false)}
          >
            <Icon name={v === "inbox" ? "inbox" : v === "archived" ? "archive" : "trash"} size={16} />
            {VIEW_LABELS[v]}
            <span className="count">{counts ? counts[v] : "…"}</span>
          </button>
        ))}
      </div>

      <div className="filter-bar">
        <input
          type="search"
          placeholder="搜索标题、原文或反馈 ID"
          aria-label="搜索反馈"
          value={qDraft}
          onChange={(e) => onSearch(e.target.value)}
        />
        <select aria-label="软件筛选" value={appId} onChange={(e) => setParams({ appId: e.target.value }, true)}>
          <option value="">全部软件</option>
          {appOptions.map((o) => (
            <option key={o.appId} value={o.appId}>
              {o.name}
              {o.deleted ? "（已删除）" : ""}
            </option>
          ))}
        </select>
        <select aria-label="处理状态筛选" value={status} onChange={(e) => setParams({ status: e.target.value }, true)}>
          <option value="">全部状态</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <input
          type="date"
          aria-label="开始日期"
          value={from}
          onChange={(e) => setParams({ from: e.target.value }, true)}
        />
        <span className="muted small">至</span>
        <input type="date" aria-label="结束日期" value={to} onChange={(e) => setParams({ to: e.target.value }, true)} />
      </div>

      {hasNew && (
        <div className="notice-bar" role="status">
          有新的反馈
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setHasNew(false);
              void loadList("reset");
              void loadCounts();
            }}
          >
            刷新列表
          </button>
        </div>
      )}

      {selected.size > 0 && (
        <div className="batch-bar" role="toolbar" aria-label="批量操作">
          <span className="small">已选 {selected.size} 条</span>
          {view === "inbox" && (
            <>
              <button
                type="button"
                className="btn sm primary"
                disabled={!selectedItems.every((i) => i.status === "archived")}
                title={
                  selectedItems.every((i) => i.status === "archived")
                    ? "将选中项移入已归档"
                    : "仅完整同步（已同步）的反馈可归档"
                }
                onClick={() =>
                  void runLifecycle(
                    "archive",
                    selectedItems.map((i) => ({ id: i.id, expectedVersion: i.lifecycleVersion })),
                  )
                }
              >
                <Icon name="archive" size={14} />
                归档
              </button>
              <button type="button" className="btn sm" onClick={() => askTrash(selectedItems)}>
                <Icon name="trash" size={14} />
                移入回收站
              </button>
            </>
          )}
          {view === "archived" && (
            <>
              <button
                type="button"
                className="btn sm"
                onClick={() =>
                  void runLifecycle(
                    "unarchive",
                    selectedItems.map((i) => ({ id: i.id, expectedVersion: i.lifecycleVersion })),
                  )
                }
              >
                <Icon name="restore" size={14} />
                恢复到收件箱
              </button>
              <button type="button" className="btn sm" onClick={() => askTrash(selectedItems)}>
                <Icon name="trash" size={14} />
                移入回收站
              </button>
            </>
          )}
          {view === "trash" && (
            <>
              <button
                type="button"
                className="btn sm"
                onClick={() =>
                  void runLifecycle(
                    "restore",
                    selectedItems.map((i) => ({ id: i.id, expectedVersion: i.lifecycleVersion })),
                  )
                }
              >
                <Icon name="restore" size={14} />
                恢复
              </button>
              <button type="button" className="btn sm danger" onClick={() => askPurge(selectedItems)}>
                <Icon name="trash" size={14} />
                彻底删除
              </button>
            </>
          )}
          <button type="button" className="btn sm ghost" onClick={() => setSelected(new Set())}>
            清除选择
          </button>
        </div>
      )}

      {listError && <InlineError message={listError} onRetry={() => void loadList("reset")} />}

      {loading === "initial" && items.length === 0 ? (
        <div className="table-wrap">
          <SkeletonRows rows={6} />
        </div>
      ) : items.length === 0 ? (
        <div className="table-wrap">
          <EmptyState
            title={view === "trash" ? "回收站为空" : view === "archived" ? "还没有已归档的反馈" : "收件箱为空"}
            hint={
              view === "inbox"
                ? "新提交的反馈会先出现在这里；同步完成后可手动归档整理。"
                : view === "archived"
                  ? "只有完整同步到 Kaneo 的反馈可以归档。"
                  : "移入回收站的反馈会保留全部内容，可恢复或手动彻底删除。"
            }
          />
        </div>
      ) : (
        <>
          {/* 桌面表格（≥768px） */}
          <div className="table-wrap fb-table">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <input type="checkbox" aria-label="全选当前已加载记录" checked={allChecked} onChange={toggleAll} />
                  </th>
                  <th>标题 / 摘要</th>
                  <th>软件</th>
                  <th>提交账号</th>
                  <th>状态</th>
                  <th>附件</th>
                  <th>提交时间</th>
                  <th style={{ width: 80 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr
                    key={it.id}
                    className={`clickable${selected.has(it.id) ? " selected" : ""}`}
                    onClick={() => openDetail(it.id)}
                  >
                    {/* biome-ignore lint/a11y/useKeyWithClickEvents: 仅阻止行点击冒泡，本身无交互 */}
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`选择反馈 ${it.title ?? it.id}`}
                        checked={selected.has(it.id)}
                        onChange={() => toggleOne(it.id)}
                      />
                    </td>
                    <td style={{ minWidth: 220 }}>
                      {/* 整行可点之外，标题做成真按钮：键盘 Tab/Enter 与读屏可直达详情。 */}
                      <button
                        type="button"
                        className="cell-open"
                        onClick={(e) => {
                          e.stopPropagation();
                          openDetail(it.id);
                        }}
                      >
                        <span className="clamp-2">{it.title ?? it.textPreview ?? "（无标题）"}</span>
                      </button>
                    </td>
                    <td>
                      <div>{it.appName ?? it.appId}</div>
                      <div className="muted small wrap-anywhere">{it.appId}</div>
                      {it.appDeleted && <span className="tag tone-warn">软件已删除</span>}
                    </td>
                    <td>{it.username ?? <span className="muted">—</span>}</td>
                    <td>
                      <span className={`tag ${it.status}`}>{STATUS_LABELS[it.status] ?? it.status}</span>
                      {it.resumePaused && <div className="muted small">已暂停</div>}
                      {waitingText(it) && <div className="muted small clamp-2">{waitingText(it)}</div>}
                    </td>
                    <td className="muted small nowrap-ellipsis">
                      {it.hasScreenshot ? "图" : ""}
                      {it.logCount ? `${it.logCount} 日志` : ""}
                      {!it.hasScreenshot && !it.logCount ? "—" : ""}
                    </td>
                    <td className="muted small" style={{ whiteSpace: "nowrap" }}>
                      {new Date(it.createdAt).toLocaleString()}
                    </td>
                    {/* biome-ignore lint/a11y/useKeyWithClickEvents: 仅阻止行点击冒泡，本身无交互 */}
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="row" style={{ gap: 4 }}>
                        {it.kaneoUrl && (
                          <a
                            className="icon-btn"
                            href={it.kaneoUrl}
                            target="_blank"
                            rel="noreferrer"
                            aria-label="在 Kaneo 中打开"
                            title="在 Kaneo 中打开"
                          >
                            <Icon name="external" size={16} />
                          </a>
                        )}
                        <MoreMenu
                          items={rowMenuItems(it, {
                            onArchive: () =>
                              void runLifecycle("archive", [{ id: it.id, expectedVersion: it.lifecycleVersion }]),
                            onUnarchive: () =>
                              void runLifecycle("unarchive", [{ id: it.id, expectedVersion: it.lifecycleVersion }]),
                            onResume: () =>
                              void runLifecycle("resume_processing", [
                                { id: it.id, expectedVersion: it.lifecycleVersion },
                              ]),
                            onTrash: () => askTrash([it]),
                            onRestore: () =>
                              void runLifecycle("restore", [{ id: it.id, expectedVersion: it.lifecycleVersion }]),
                            onPurge: () => askPurge([it]),
                          })}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 移动卡片（<768px）：两行摘要 + 状态/时间单独一行 */}
          <div className="fb-cards">
            {items.map((it) => (
              <div key={it.id} className="fb-card">
                <div className="fb-card-top">
                  <input
                    type="checkbox"
                    aria-label={`选择反馈 ${it.title ?? it.id}`}
                    checked={selected.has(it.id)}
                    onChange={() => toggleOne(it.id)}
                  />
                  <button
                    type="button"
                    className="fb-card-open"
                    style={{ flex: 1, minWidth: 0 }}
                    onClick={() => openDetail(it.id)}
                  >
                    <span className="fb-card-title">{it.title ?? it.textPreview ?? "（无标题）"}</span>
                  </button>
                  <MoreMenu
                    items={rowMenuItems(it, {
                      onArchive: () =>
                        void runLifecycle("archive", [{ id: it.id, expectedVersion: it.lifecycleVersion }]),
                      onUnarchive: () =>
                        void runLifecycle("unarchive", [{ id: it.id, expectedVersion: it.lifecycleVersion }]),
                      onResume: () =>
                        void runLifecycle("resume_processing", [{ id: it.id, expectedVersion: it.lifecycleVersion }]),
                      onTrash: () => askTrash([it]),
                      onRestore: () =>
                        void runLifecycle("restore", [{ id: it.id, expectedVersion: it.lifecycleVersion }]),
                      onPurge: () => askPurge([it]),
                    })}
                  />
                </div>
                <div className="fb-card-meta">
                  <span className={`tag ${it.status}`}>{STATUS_LABELS[it.status] ?? it.status}</span>
                  <span>{it.appName ?? it.appId}</span>
                  <span>{new Date(it.createdAt).toLocaleString()}</span>
                  {it.resumePaused && <span>已暂停</span>}
                </div>
              </div>
            ))}
          </div>

          {nextCursor && (
            <div style={{ padding: "var(--sp-3)", textAlign: "center" }}>
              <button type="button" className="btn" disabled={loading === "more"} onClick={() => void loadList("more")}>
                {loading === "more" ? "加载中…" : "加载更多"}
              </button>
            </div>
          )}
        </>
      )}

      {/* 确认弹窗 */}
      {confirm?.kind === "trash" && (
        <ConfirmDialog
          title={`移入回收站（${confirm.items.length} 条）`}
          confirmLabel="移入回收站"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            void runLifecycle("trash", c.items);
          }}
          body={
            <>
              <p>正文、截图、日志、分类与同步证据全部保留；已有 Kaneo 任务与附件会保留，不做远端删除。</p>
              <p>移入后停止自动处理；可在回收站恢复，或手动彻底删除。</p>
              {confirm.remoteCount > 0 && (
                <p className="err">其中 {confirm.remoteCount} 条已有远端关联或结果待核对，远端内容可能已经存在。</p>
              )}
            </>
          }
        />
      )}
      {confirm?.kind === "purge" && (
        <ConfirmDialog
          title={`彻底删除（${confirm.items.length} 条）`}
          confirmLabel="彻底删除"
          danger
          requireText="删除"
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            void runLifecycle("purge", c.items);
          }}
          body={
            <>
              <p>将永久删除本地反馈及截图、日志与操作记录，不可恢复；不会删除 Kaneo 中已存在的内容。</p>
              {confirm.remoteCount > 0 && (
                <p className="err">其中 {confirm.remoteCount} 条已有远端关联或结果待核对，远端内容可能已经存在。</p>
              )}
            </>
          }
        />
      )}
      {batchResult && (
        <ConfirmDialog
          title={`「${batchResult.action}」部分项目未完成`}
          confirmLabel="知道了"
          onClose={() => setBatchResult(null)}
          onConfirm={() => setBatchResult(null)}
          body={
            <ul style={{ maxHeight: 240, overflowY: "auto" }}>
              {batchResult.failures.map((f) => (
                <li key={f.id}>
                  <code>{f.id.slice(0, 8)}</code>：{f.message}
                </li>
              ))}
            </ul>
          }
        />
      )}

      {/* 详情抽屉 */}
      {detailId && (
        <FeedbackDrawer
          key={detailId}
          detail={detail}
          onClose={closeDetail}
          onRetry={() => setDetailRetry((n) => n + 1)}
          onAction={singleAction}
          onTrash={(d) => askTrash([detailToListItem(d)])}
          onPurge={(d) => askPurge([detailToListItem(d)])}
          onChanged={() => void refreshAfterAction()}
        />
      )}
    </div>
  );
}

function actionLabel(a: LifecycleAction): string {
  return {
    archive: "归档",
    unarchive: "恢复到收件箱",
    trash: "移入回收站",
    restore: "恢复",
    resume_processing: "恢复处理",
    purge: "彻底删除",
  }[a];
}

/** 行内“更多操作”菜单项：按当前可用动作生成（普通列表的删除收进这里）。 */
function rowMenuItems(
  it: FeedbackListItem,
  h: {
    onArchive: () => void;
    onUnarchive: () => void;
    onResume: () => void;
    onTrash: () => void;
    onRestore: () => void;
    onPurge: () => void;
  },
) {
  const av = new Set(it.availableActions ?? []);
  const items: { label: string; danger?: boolean; onClick: () => void }[] = [];
  if (av.has("archive")) items.push({ label: "归档", onClick: h.onArchive });
  if (av.has("unarchive")) items.push({ label: "恢复到收件箱", onClick: h.onUnarchive });
  if (av.has("resume_processing")) items.push({ label: "恢复处理", onClick: h.onResume });
  if (av.has("restore")) items.push({ label: "恢复", onClick: h.onRestore });
  if (av.has("purge")) items.push({ label: "彻底删除", danger: true, onClick: h.onPurge });
  if (av.has("trash")) items.push({ label: "移入回收站", danger: true, onClick: h.onTrash });
  return items;
}

function detailToListItem(d: FeedbackDetail): FeedbackListItem {
  return { ...d, lifecycleVersion: d.lifecycleVersion };
}

/** 自动归档阻塞原因（配置问题 / 可恢复故障）。 */
function autoBlockedText(it: FeedbackListItem): string | null {
  if (!it.autoBlockedKind) return null;
  const prefix = it.autoBlockedKind === "retryable" ? "可恢复故障" : "配置问题";
  return `${prefix}：${it.autoBlockedReason ?? ""}`.slice(0, 120);
}

const COLLECTION_LABELS: Record<string, string> = {
  waiting_configuration: "等待配置",
  waiting_source_confirmation: "等待来源确认",
  waiting_manual_archive: "待人工分类",
  queued: "处理中",
};

function waitingText(it: FeedbackListItem): string | null {
  const blocked = autoBlockedText(it);
  if (blocked) return blocked;
  if (!it.collectionState) return null;
  // 终态记录不再显示排队/处理中标签——顶部状态标签已是最需要关注的一项。
  if (it.status === "archived" || it.status === "needs_review" || it.status === "failed") return null;
  // queued 只在确实在途处理时显示「处理中」，否则保持安静。
  if (it.collectionState === "queued" && !ACTIVE_STATUSES.has(it.status)) return null;
  const label = COLLECTION_LABELS[it.collectionState] ?? null;
  // 与顶部状态标签文案一致时不再重复（如「待人工分类」）。
  return label === STATUS_LABELS[it.status] ? null : label;
}
