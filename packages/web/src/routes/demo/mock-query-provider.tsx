/**
 * MockQueryProvider — pre-seeds React Query cache with mock data.
 * Used by demo/empty routes so pages render without a real backend.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

interface MockEntry {
  queryKey: unknown[];
  data: unknown;
}

/**
 * Wraps children in a dedicated, pre-seeded QueryClient so demo/prototype pages
 * render their mock data without a backend.
 *
 * Why a separate client rather than seeding the app's shared one:
 * - The data is seeded synchronously (lazy useState) BEFORE children mount, so a
 *   page's useQuery finds it immediately and never fires a (backend-less) fetch
 *   that would surface "failed to load" first.
 * - Refetching is disabled and nothing is ever removed, so React StrictMode's
 *   dev unmount/remount can't blank the cache and trigger a fetch.
 * - Being a distinct client instance, this mock state can never leak into the
 *   live production routes — they keep using the app's real QueryClient.
 */
export function MockQueryProvider({ mocks, children }: { mocks: MockEntry[]; children: React.ReactNode }) {
  const [client] = useState(() => {
    const mockClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
          gcTime: Number.POSITIVE_INFINITY,
          refetchOnMount: false,
          refetchOnWindowFocus: false,
          refetchOnReconnect: false,
        },
      },
    });
    for (const mock of mocks) {
      mockClient.setQueryData(mock.queryKey, mock.data);
    }
    return mockClient;
  });

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
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
