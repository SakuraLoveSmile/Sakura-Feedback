import { NativeSelect } from "@mantine/core";
import { useColorScheme } from "@mantine/hooks";

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

/** 让组件库、工作台布局和浏览器原生控件使用相同的实际主题。 */
export function useThemeSync(): ResolvedTheme {
  const [pref] = useThemePreference();
  const system = useColorScheme("light", { getInitialValueInEffect: false });
  const resolved = pref === "system" ? system : pref;
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);
  return resolved;
}

/** 登录页、顶栏与侧栏共用同一份持久化偏好。 */
export function ThemeSelect() {
  const [pref, setPref] = useThemePreference();
  return (
    <NativeSelect
      size="xs"
      className="theme-select"
      aria-label="主题"
      value={pref}
      onChange={(e) => setPref(e.target.value as ThemePreference)}
    >
      <option value="system">跟随系统</option>
      <option value="light">浅色</option>
      <option value="dark">深色</option>
    </NativeSelect>
  );
}
