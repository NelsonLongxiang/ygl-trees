/**
 * Theme switch (DESIGN.md ## Themes): dark / light, default follows
 * prefers-color-scheme, the pick persists in localStorage["ygl-theme"]
 * (system | light | dark). index.html applies the same key before first paint
 * with the same rules as resolveTheme(readMode()) — tests/theme.spec.tsx runs
 * that inline script against this module to keep the two in step.
 *
 * Storage is guarded: blocked cookies, sandboxed frames and some private modes
 * throw on localStorage access, and a throw here would blank the whole app.
 */
import {
  createContext, useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode,
} from "react";
import { Button, ConfigProvider, Tooltip } from "antd";
import { DesktopOutlined, MoonOutlined, SunOutlined } from "@ant-design/icons";
import zhCN from "antd/locale/zh_CN";
import { themeConfig, type ThemeName } from "./tokens";

export const THEME_KEY = "ygl-theme";
export type ThemeMode = "system" | "light" | "dark";

const MODES: readonly ThemeMode[] = ["system", "light", "dark"];
const NEXT: Record<ThemeMode, ThemeMode> = { system: "light", light: "dark", dark: "system" };
const MODE_LABEL: Record<ThemeMode, string> = { system: "跟随系统", light: "浅色", dark: "深色" };
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Anything but a known mode (missing, "auto", garbage) means follow the system. */
export function normalizeMode(raw: unknown): ThemeMode {
  return MODES.includes(raw as ThemeMode) ? (raw as ThemeMode) : "system";
}

/** The saved mode; "system" when storage is absent or throws. */
export function readMode(storage?: Pick<Storage, "getItem"> | null): ThemeMode {
  try {
    const s = storage === undefined ? (typeof window === "undefined" ? null : window.localStorage) : storage;
    return normalizeMode(s?.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

function writeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* not persisted — the pick still applies for this page */
  }
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ThemeName {
  return mode === "system" ? (prefersDark ? "dark" : "light") : mode;
}

function subscribeDark(onChange: () => void): () => void {
  const mq = window.matchMedia?.(DARK_QUERY);
  mq?.addEventListener?.("change", onChange);
  return () => mq?.removeEventListener?.("change", onChange);
}
const prefersDarkNow = (): boolean => window.matchMedia?.(DARK_QUERY).matches ?? true;

/** Server render (tests) has no window: assume dark, the original theme. */
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface ThemeState {
  theme: ThemeName;
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeState>({ theme: "dark", mode: "system", setMode: () => {} });

/** The resolved theme ("dark" | "light") — xyflow colorMode and anything needing a literal. */
export function useThemeName(): ThemeName {
  return useContext(ThemeContext).theme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => readMode());
  const prefersDark = useSyncExternalStore(subscribeDark, prefersDarkNow, () => true);
  const theme = resolveTheme(mode, prefersDark);

  // layout effect: flip the attribute before paint so CSS vars and antd agree in one frame
  useIsoLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setMode = (m: ThemeMode) => {
    setModeState(m);
    writeMode(m);
  };

  return (
    <ThemeContext.Provider value={{ theme, mode, setMode }}>
      <ConfigProvider locale={zhCN} theme={themeConfig(theme)}>
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}

/** Header control: one icon button cycling 跟随系统 → 浅色 → 深色. */
export function ThemeToggle() {
  const { theme, mode, setMode } = useContext(ThemeContext);
  const icon = mode === "system" ? <DesktopOutlined /> : mode === "light" ? <SunOutlined /> : <MoonOutlined />;
  const tip = `主题：${MODE_LABEL[mode]}${mode === "system" ? `（当前${MODE_LABEL[theme]}）` : ""} · 点击切换为${MODE_LABEL[NEXT[mode]]}`;
  return (
    <Tooltip title={tip} placement="bottomRight">
      <Button type="text" aria-label="切换主题" data-mode={mode} icon={icon} onClick={() => setMode(NEXT[mode])} />
    </Tooltip>
  );
}
