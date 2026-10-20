/**
 * One live dashboard subscription for the whole shell (SSE first, 10s poll
 * fallback — see api.ts subscribeDashboard). Routes read it via useDashboard();
 * switching routes never reconnects, and a refresh never resets view state
 * (DESIGN.md: selection state is sacred).
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { subscribeDashboard, type DashboardData } from "./api";

interface DashboardState {
  data: DashboardData | null;
  error: string | null;
}

export const DashboardContext = createContext<DashboardState>({ data: null, error: null });

export function useDashboard(): DashboardState {
  return useContext(DashboardContext);
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return subscribeDashboard(
      (d) => {
        setData(d);
        setError(null);
      },
      (e) => setError((prev) => prev ?? e)
    );
  }, []);

  return <DashboardContext.Provider value={{ data, error }}>{children}</DashboardContext.Provider>;
}
