/**
 * 主题状态与切换控件。
 * 偏好（"system" | "light" | "dark"）持久化到 localStorage（key: feedback.admin.theme）；
 * 解析结果只写 <html> 的 dataset.theme 与 style.colorScheme，取值仅 "light" | "dark"（绝不写 "system"）。
 * 模块级 store + useSyncExternalStore：登录页 / 侧栏 / 顶栏三处 ThemeSelect 共享同一份状态，
 * 切换只触发重渲染，不 remount 业务视图、不清空输入草稿。
 */
import { useEffect, useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "feedback.admin.theme";

function isThemePreference(v: unknown): v is ThemePreference {
  return v === "system" || v === "light" || v === "dark";
}

/** 读持久化偏好：缺失 / 非法值 / 存储不可用（隐私模式等）一律回退 "system"。 */
function readPreference(): ThemePreference {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return isThemePreference(v) ? v : "system";
  } catch {
    return "system";
  }
}

/** 写偏好：存储抛错时静默——只丢持久化，本次页面内切换不受影响。 */
function writePreference(p: ThemePreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, p);
  } catch {
    /* 隐私模式等场景下退化为不持久化 */
  }
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** 把偏好解析为实际主题，结果只有 "light" | "dark"。 */
export function resolveTheme(p: ThemePreference): ResolvedTheme {
  return p === "system" ? systemTheme() : p;
}

/** 把解析结果写到 <html>：dataset.theme 与 style.colorScheme 同步同值。 */
function applyTheme(p: ThemePreference): void {
  const resolved = resolveTheme(p);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

// ---------- 模块级 store（三处 ThemeSelect 共享同一份 preference） ----------

let preference: ThemePreference = readPreference();
const listeners = new Set<() => void>();

export function getThemePreference(): ThemePreference {
  return preference;
}

export function setThemePreference(next: ThemePreference): void {
  if (next === preference) return;
  preference = next;
  writePreference(next);
  applyTheme(next);
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/**
 * 绑定偏好状态：返回 [当前偏好, 设置函数]。
 * 纯 store 订阅，不注册系统主题监听（监听由 useThemeSync 统一管理）。
 */
export function useThemePreference(): [ThemePreference, (p: ThemePreference) => void] {
  const pref = useSyncExternalStore(subscribe, getThemePreference);
  return [pref, setThemePreference];
}

/**
 * 在 App 顶层调用一次：把偏好同步到 <html>，并仅在 "system" 时跟随系统主题变化。
 * 监听器在 effect 内注册、清理函数移除（StrictMode 双挂载安全）；
 * 偏好为 light/dark 时不注册监听，系统变化不影响页面。
 */
export function useThemeSync(): void {
  const [pref] = useThemePreference();
  useEffect(() => {
    applyTheme(pref);
    if (pref !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [pref]);
}

/** 主题切换控件：<select> 自带 .theme-select，避免继承表单控件 width:100% 撑开工具栏/页头；多处实例共享模块级 store，显示值始终一致。 */
export function ThemeSelect() {
  const [pref, setPref] = useThemePreference();
  return (
    <select
      className="theme-select"
      aria-label="主题"
      value={pref}
      onChange={(e) => setPref(e.target.value as ThemePreference)}
    >
      <option value="system">跟随系统</option>
      <option value="light">浅色</option>
      <option value="dark">深色</option>
    </select>
  );
}
