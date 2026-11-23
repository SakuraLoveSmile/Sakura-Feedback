/**
 * /admin/ 下的 URL 查询参数状态：刷新、复制链接、浏览器前进后退可恢复页面。
 * 导航性参数（page / view / id）用 pushState；筛选参数（q / status / appId / 日期）用 replaceState。
 */
import { useCallback, useEffect, useState } from "react";

import type { EditState } from "./page-edits.ts";

const historyAccepted = "feedback-admin-history-accepted";
let position = window.history.state?.feedbackPosition ?? 0;
let currentQuery = window.location.search;
window.history.replaceState({ ...window.history.state, feedbackPosition: position }, "");

/** 后退取消时返回原历史项，保留实际 URL、前进记录和内存中的表单。 */
export function useHistoryEditGuard(edits: Set<{ state: EditState }>, report: (text: string | null) => void) {
  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      const nextPosition = event.state?.feedbackPosition;
      const old = new URLSearchParams(currentQuery);
      const next = new URLSearchParams(window.location.search);
      const leaving = next.get("page") !== old.get("page") || next.get("id") !== old.get("id");
      if (leaving && Number.isInteger(nextPosition) && nextPosition !== position && edits.size > 0) {
        const saving = [...edits].some((item) => item.state === "saving");
        if (saving || !window.confirm("离开会丢弃未保存的修改。确定离开吗？")) {
          event.stopImmediatePropagation();
          if (saving) report("操作正在提交，请稍后再离开。");
          window.history.go(position - nextPosition);
          return;
        }
      }
      if (Number.isInteger(nextPosition)) position = nextPosition;
      currentQuery = window.location.search;
      window.dispatchEvent(new Event(historyAccepted));
    };
    window.addEventListener("popstate", onPop, true);
    return () => window.removeEventListener("popstate", onPop, true);
  }, [edits, report]);
}

export type UrlPatch = Record<string, string | null | undefined>;

function applyPatch(patch: UrlPatch, replace: boolean): URLSearchParams {
  const cur = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") cur.delete(k);
    else cur.set(k, v);
  }
  const qs = cur.toString();
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  if (replace) window.history.replaceState({ ...window.history.state, feedbackPosition: position }, "", url);
  else window.history.pushState({ feedbackPosition: ++position }, "", url);
  currentQuery = window.location.search;
  return cur;
}

export function useUrlState(): [URLSearchParams, (patch: UrlPatch, replace?: boolean) => void] {
  const [params, setParams] = useState(() => new URLSearchParams(window.location.search));
  useEffect(() => {
    const onPop = () => setParams(new URLSearchParams(window.location.search));
    window.addEventListener(historyAccepted, onPop);
    return () => window.removeEventListener(historyAccepted, onPop);
  }, []);
  const set = useCallback((patch: UrlPatch, replace = false) => {
    setParams(applyPatch(patch, replace));
  }, []);
  return [params, set];
}
