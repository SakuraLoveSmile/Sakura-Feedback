/**
 * 反馈工作台：收件箱 / 已归档 / 回收站。
 * - URL 保存 view/q/status/appId/from/to/id，刷新与前进后退可恢复；
 * - 搜索防抖 300ms、上限 200 字符；游标分页每页 50；
 * - 有活动处理时每 5 秒原位刷新（不打断选择、详情与草稿），页面隐藏停止；
 * - 批量只操作已勾选记录（≤100 条），逐项结果不回滚。
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
  type MgmtView,
  STATUS_LABELS,
  VIEW_LABELS,
} from "../api.ts";
import {
  ConfirmDialog,
  EmptyState,
  FilterChip,
  Icon,
  InlineError,
  MoreMenu,
  PageHeader,
  SkeletonRows,
  StatusBadge,
  useToast,
} from "../ui.tsx";
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

/** 中文时间：今天 HH:mm / MM-DD HH:mm / YYYY-MM-DD。完整时间放 title。 */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return `今天 ${hm}`;
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (d.getFullYear() === now.getFullYear()) return `${md} ${hm}`;
  return `${d.getFullYear()}-${md}`;
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
  const [dateOpen, setDateOpen] = useState(false);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [batchResult, setBatchResult] = useState<{
    action: string;
    failures: { id: string; message: string }[];
  } | null>(null);
  const [detail, setDetail] = useState<FeedbackDetail | "loading" | "purged" | null>(null);
  /** 列表请求序号：切换筛选/区域后的迟到响应直接丢弃，不回写旧数据。 */
  const listSeq = useRef(0);
  const dateRef = useRef<HTMLSpanElement>(null);

  // 搜索输入防抖 300ms：本地草稿即时回显，防抖后写入 URL（replace，不产生历史）。
  const [qDraft, setQDraft] = useState(q);
  useEffect(() => setQDraft(q), [q]);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onSearch = useCallback(
    (v: string) => {
      const clipped = v.slice(0, 200);
      setQDraft(clipped);
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => setParams({ q: clipped }, true), 300);
    },
    [setParams],
  );

  // 日期面板点击外部 / Escape 关闭
  useEffect(() => {
    if (!dateOpen) return;
    function onDoc(e: MouseEvent) {
      if (dateRef.current && !dateRef.current.contains(e.target as Node)) setDateOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setDateOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [dateOpen]);

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
          // 原位刷新：窗口内已加载记录按 id 更新；窗口内消失的记录视为离开本区域（移除）；
          // 顶部出现的全新记录不自动插入（避免滚动跳动），只提示“有新反馈”。
          setItems((prev) => {
            const fresh = new Map(r.items.map((i) => [i.id, i]));
            const next: FeedbackListItem[] = [];
            for (const [idx, it] of prev.entries()) {
              const f = fresh.get(it.id);
              if (f) next.push(f);
              else if (idx >= limit) next.push(it); // 超出刷新窗口的保留原样
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
    try {
      setCounts(await api.get<FeedbackCounts>(`/api/admin/feedback/counts?${filterQuery()}`));
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
    let alive = true;
    setDetail("loading");
    api
      .get<FeedbackDetail>(`/api/admin/feedback/${detailId}`)
      .then((d) => alive && setDetail(d))
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 410) setDetail("purged");
        else {
          setDetail(null);
          toast("err", err instanceof ApiError ? err.message : "加载详情失败");
        }
      });
    return () => {
      alive = false;
    };
  }, [detailId]);

  // 轮询：页面可见且存在活动处理时每 5 秒原位刷新；隐藏即停，重新可见立即刷新。
  const hasActive =
    items.some((i) => ACTIVE_STATUSES.has(i.status)) ||
    (detail !== null && typeof detail === "object" && ACTIVE_STATUSES.has(detail.status));
  // biome-ignore lint/correctness/useExhaustiveDependencies: 轮询回调每次触发时取最新函数引用，避免定时器频繁重建
  useEffect(() => {
    if (!hasActive) return;
    let stopped = false;
    const tick = () => {
      if (document.visibilityState === "visible") {
        void loadList("poll");
        void loadCounts();
        if (detailId && detail !== "loading" && detail !== "purged") {
          api
            .get<FeedbackDetail>(`/api/admin/feedback/${detailId}`)
            .then((d) => setDetail(d))
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
    await Promise.all([loadList("reset"), loadCounts()]);
    if (detailId) {
      try {
        setDetail(await api.get<FeedbackDetail>(`/api/admin/feedback/${detailId}`));
      } catch (err) {
        if (err instanceof ApiError && err.status === 410) setDetail("purged");
      }
    }
  }, [loadList, loadCounts, detailId]);

  const runLifecycle = useCallback(
    async (action: LifecycleAction, targets: { id: string; expectedVersion: number }[]): Promise<boolean> => {
      try {
        const r = await api.post<LifecycleBatchResponse>("/api/admin/feedback/lifecycle", {
          action,
          items: targets,
        });
        const failures = r.results.filter((x) => !x.ok);
        const okIds = new Set(r.results.filter((x) => x.ok).map((x) => x.id));
        setSelected((sel) => new Set([...sel].filter((id) => !okIds.has(id))));
        if (failures.length === 0) {
          toast("ok", `已完成「${actionLabel(action)}」${r.results.length} 条`);
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
  const hasFilters = Boolean(q || status || appId || from || to);
  const appName = (id: string) => appOptions.find((o) => o.appId === id)?.name ?? id;

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
  const clearFilters = useCallback(
    () => setParams({ q: null, status: null, appId: null, from: null, to: null }, true),
    [setParams],
  );

  return (
    <div className="page-list">
      <PageHeader
        title="反馈"
        sub="查看用户反馈，完成分类与同步。"
        actions={
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
        }
      />

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
            {VIEW_LABELS[v]}
            <span className="count">{counts ? counts[v] : "…"}</span>
          </button>
        ))}
      </div>

      <div className="filter-bar">
        <span className="search-box">
          <span className="search-icon">
            <Icon name="search" size={16} />
          </span>
          <input
            type="search"
            placeholder="搜索反馈内容或 ID"
            aria-label="搜索反馈"
            value={qDraft}
            onChange={(e) => onSearch(e.target.value)}
          />
          {qDraft && (
            <button type="button" className="icon-btn search-clear" aria-label="清空搜索" onClick={() => onSearch("")}>
              <Icon name="close" size={14} />
            </button>
          )}
        </span>
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
        <span className="date-popover-wrap" ref={dateRef}>
          <button
            type="button"
            className={`btn${from || to ? " active-filter" : ""}`}
            aria-expanded={dateOpen}
            aria-haspopup="dialog"
            onClick={() => setDateOpen((v) => !v)}
          >
            <Icon name="calendar" size={16} />
            提交时间
            <Icon name="chevron" size={14} />
          </button>
          {dateOpen && (
            <div className="date-popover" role="dialog" aria-label="提交时间筛选">
              <div className="field">
                <label htmlFor="f-from">开始日期</label>
                <input
                  id="f-from"
                  type="date"
                  value={from}
                  onChange={(e) => setParams({ from: e.target.value }, true)}
                />
              </div>
              <div className="field">
                <label htmlFor="f-to">结束日期</label>
                <input id="f-to" type="date" value={to} onChange={(e) => setParams({ to: e.target.value }, true)} />
              </div>
              <button type="button" className="btn sm" onClick={() => setDateOpen(false)}>
                完成
              </button>
            </div>
          )}
        </span>
      </div>

      {hasFilters && (
        <div className="chips">
          {q && <FilterChip label={`搜索：${q}`} onClear={() => setParams({ q: null }, true)} />}
          {appId && <FilterChip label={`软件：${appName(appId)}`} onClear={() => setParams({ appId: null }, true)} />}
          {status && (
            <FilterChip
              label={`状态：${STATUS_LABELS[status] ?? status}`}
              onClear={() => setParams({ status: null }, true)}
            />
          )}
          {(from || to) && (
            <FilterChip
              label={`时间：${from || "…"} ~ ${to || "…"}`}
              onClear={() => setParams({ from: null, to: null }, true)}
            />
          )}
          <button type="button" className="clear-all" onClick={clearFilters}>
            清除筛选
          </button>
        </div>
      )}

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
            取消选择
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
          {hasFilters ? (
            <EmptyState title="没有匹配结果" hint="当前筛选条件下没有反馈。" />
          ) : (
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
          )}
          {hasFilters && (
            <div style={{ textAlign: "center", paddingBottom: "var(--sp-4)" }}>
              <button type="button" className="btn sm" onClick={clearFilters}>
                清除筛选
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* 桌面表格（≥768px） */}
          <div className="table-wrap fb-table">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input type="checkbox" aria-label="全选当前已加载记录" checked={allChecked} onChange={toggleAll} />
                  </th>
                  <th>反馈内容</th>
                  <th>软件</th>
                  <th>处理状态</th>
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
                    <td className="fb-cell">
                      <button
                        type="button"
                        className="fb-cell-title"
                        title={it.title ?? it.textPreview ?? undefined}
                        onClick={(e) => {
                          // 行本身也可点击；阻止冒泡避免重复 pushState（后退一次即关闭抽屉）。
                          e.stopPropagation();
                          openDetail(it.id);
                        }}
                      >
                        {it.title ?? it.textPreview ?? "（无标题）"}
                      </button>
                      {(it.title && it.textPreview) || it.username ? (
                        <div className="fb-cell-sum">
                          {it.title ? it.textPreview : null}
                          {it.username && <span className="fb-user">　{it.username}</span>}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <span className="nowrap-ellipsis" style={{ maxWidth: 140, display: "inline-block" }}>
                        {it.appName ?? it.appId}
                      </span>
                      {it.appDeleted && <StatusBadge tone="warn">软件已删除</StatusBadge>}
                    </td>
                    <td>
                      <StatusBadge tone={it.status}>{STATUS_LABELS[it.status] ?? it.status}</StatusBadge>
                      {it.resumePaused && <div className="muted small">已暂停</div>}
                      {waitingText(it) && <div className="muted small nowrap-ellipsis">{waitingText(it)}</div>}
                    </td>
                    <td>
                      {it.hasScreenshot || it.logCount ? (
                        <span className="fb-attach">
                          {it.hasScreenshot && (
                            <span className="fb-attach-item" title="截图 1">
                              <Icon name="image" size={14} />1
                            </span>
                          )}
                          {it.logCount ? (
                            <span className="fb-attach-item" title={`日志 ${it.logCount}`}>
                              <Icon name="file" size={14} />
                              {it.logCount}
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <span className="fb-time" title={new Date(it.createdAt).toLocaleString()}>
                        {fmtTime(it.createdAt)}
                      </span>
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

          {/* 移动卡片（<768px）：标题+状态居上，摘要居中，软件/附件/时间居下 */}
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
                  <span className="fb-card-status">
                    <StatusBadge tone={it.status}>{STATUS_LABELS[it.status] ?? it.status}</StatusBadge>
                  </span>
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
                {(it.title && it.textPreview) || it.username ? (
                  <div className="fb-card-sum">
                    {it.title ? it.textPreview : null}
                    {it.username && <span className="fb-user">　{it.username}</span>}
                  </div>
                ) : null}
                <div className="fb-card-bottom">
                  <span>{it.appName ?? it.appId}</span>
                  {/* 用三元而非 &&：false || 0 会得到 0，React 会渲染出字面量 "0" */}
                  {it.hasScreenshot || it.logCount ? (
                    <span className="fb-attach">
                      {it.hasScreenshot && (
                        <span className="fb-attach-item">
                          <Icon name="image" size={14} />1
                        </span>
                      )}
                      {it.logCount ? (
                        <span className="fb-attach-item">
                          <Icon name="file" size={14} />
                          {it.logCount}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                  <span className="fb-time" title={new Date(it.createdAt).toLocaleString()}>
                    {fmtTime(it.createdAt)}
                  </span>
                  {it.resumePaused && <span>已暂停</span>}
                </div>
              </div>
            ))}
          </div>

          <div className="fb-list-meta">
            已加载 {items.length} 条{nextCursor ? "" : "（全部）"}
          </div>
          {nextCursor && (
            <div style={{ padding: "var(--sp-2)", textAlign: "center" }}>
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
