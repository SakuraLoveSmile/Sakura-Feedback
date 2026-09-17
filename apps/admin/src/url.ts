/**
 * /admin/ 下的 URL 查询参数状态：刷新、复制链接、浏览器前进后退可恢复页面。
 * 导航性参数（page / view / id）用 pushState；筛选参数（q / status / appId / 日期）用 replaceState。
 */
import { useCallback, useEffect, useState } from "react";

export type UrlPatch = Record<string, string | null | undefined>;

function applyPatch(patch: UrlPatch, replace: boolean): URLSearchParams {
  const cur = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") cur.delete(k);
    else cur.set(k, v);
  }
  const qs = cur.toString();
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  return cur;
}

export function useUrlState(): [URLSearchParams, (patch: UrlPatch, replace?: boolean) => void] {
  const [params, setParams] = useState(() => new URLSearchParams(window.location.search));
  useEffect(() => {
    const onPop = () => setParams(new URLSearchParams(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const set = useCallback((patch: UrlPatch, replace = false) => {
    setParams(applyPatch(patch, replace));
  }, []);
  return [params, set];
}
