/**
 * MockQueryProvider — pre-seeds React Query cache with mock data.
 * Used by demo/empty routes so pages render without a real backend.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

interface MockEntry {
  queryKey: unknown[];
  data: unknown;
}

export function MockQueryProvider({ mocks, children }: { mocks: MockEntry[]; children: React.ReactNode }) {
  const queryClient = useQueryClient();

  // Seed cache and prevent refetches
  useEffect(() => {
    for (const mock of mocks) {
      queryClient.setQueryData(mock.queryKey, mock.data);
      queryClient.setQueryDefaults(mock.queryKey, {
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchInterval: false,
      });
    }

    return () => {
      for (const mock of mocks) {
        queryClient.removeQueries({ queryKey: mock.queryKey });
        queryClient.setQueryDefaults(mock.queryKey, {});
      }
    };
  }, [queryClient, mocks]);

  return <>{children}</>;
}

/** Merge query params into the URL without losing existing ones. */
function mergeSearchParams(params: Record<string, string>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(params)) {
    if (!url.searchParams.has(key)) url.searchParams.set(key, value);
  }
  window.history.replaceState(null, "", url.pathname + url.search);
}

/** Inject ?trial=none to hide the trial banner on demo routes. */
export function hideTrialBanner() {
  mergeSearchParams({ trial: "none" });
}

/** Inject ?role=member so the dashboard returns member auth context. */
export function setMemberRole() {
  mergeSearchParams({ trial: "none", role: "member" });
}
