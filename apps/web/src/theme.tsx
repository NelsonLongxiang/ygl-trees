/**
 * Theme switch (DESIGN.md ## Themes): dark / light, default follows
 * prefers-color-scheme, the pick persists in localStorage["ygl-theme"]
 * (system | light | dark). index.html applies the same key before first paint;
 * this provider keeps <html data-theme> and antd's ConfigProvider in step.
 */
import { createContext, useContext, useLayoutEffect, type ReactNode } from "react";
import { Button, ConfigProvider, Tooltip } from "antd";
import { DesktopOutlined, MoonOutlined, SunOutlined } from "@ant-design/icons";
import zhCN from "antd/locale/zh_CN";
import { useTheme } from "ahooks";
import { themeConfig, type ThemeName } from "./tokens";

export const THEME_KEY = "ygl-theme";
export type ThemeMode = "system" | "light" | "dark";

const NEXT: Record<ThemeMode, ThemeMode> = { system: "light", light: "dark", dark: "system" };
const MODE_LABEL: Record<ThemeMode, string> = { system: "跟随系统", light: "浅色", dark: "深色" };

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
  const { theme, themeMode, setThemeMode } = useTheme({ localStorageKey: THEME_KEY });
  const name: ThemeName = theme === "light" ? "light" : "dark";
  const mode = (["system", "light", "dark"].includes(themeMode) ? themeMode : "system") as ThemeMode;

  // layout effect: flip the attribute before paint so CSS vars and antd agree in one frame
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = name;
  }, [name]);

  return (
    <ThemeContext.Provider value={{ theme: name, mode, setMode: (m) => setThemeMode(m as Parameters<typeof setThemeMode>[0]) }}>
      <ConfigProvider locale={zhCN} theme={themeConfig(name)}>
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
      <Button
        type="text"
        aria-label="切换主题"
        icon={icon}
        onClick={() => setMode(NEXT[mode])}
      />
    </Tooltip>
  );
}
