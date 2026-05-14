/**
 * Sidebar collapse state — persisted to localStorage so the user's preference
 * follows them across routes. The collapse toggle lives in the brand row of
 * the sidebar (§4.1) and applies to every route in the new shell.
 */
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

interface SidebarStateValue {
  collapsed: boolean;
  setCollapsed: (next: boolean) => void;
  toggle: () => void;
}

const SidebarStateContext = createContext<SidebarStateValue | undefined>(undefined);

const STORAGE_KEY = "sketch.sidebar.collapsed";

function readInitial(forceCollapsed: boolean | undefined): boolean {
  if (forceCollapsed !== undefined) return forceCollapsed;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

interface ProviderProps {
  children: ReactNode;
  /** Overrides the persisted value — used by /home/default-collapsed demo. */
  forceCollapsed?: boolean;
}

export function SidebarStateProvider({ children, forceCollapsed }: ProviderProps) {
  const [collapsed, setCollapsedState] = useState<boolean>(() => readInitial(forceCollapsed));

  useEffect(() => {
    if (forceCollapsed !== undefined) {
      setCollapsedState(forceCollapsed);
    }
  }, [forceCollapsed]);

  const setCollapsed = useCallback(
    (next: boolean) => {
      setCollapsedState(next);
      if (forceCollapsed === undefined) {
        try {
          window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
        } catch {}
      }
    },
    [forceCollapsed],
  );

  const toggle = useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed]);

  const value = useMemo(() => ({ collapsed, setCollapsed, toggle }), [collapsed, setCollapsed, toggle]);

  return <SidebarStateContext value={value}>{children}</SidebarStateContext>;
}

export function useSidebarState(): SidebarStateValue {
  const ctx = useContext(SidebarStateContext);
  if (!ctx) throw new Error("useSidebarState must be used inside SidebarStateProvider");
  return ctx;
}
