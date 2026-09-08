import type { ToolProgressIntegrationContext } from "../agent/tool-progress-integration";
import type { IntegrationProvider } from "../integrations/types";

/** Catalog enrichment is run-scoped, bounded, and never a prerequisite for executing a tool. */
export function createActivityCatalog(
  loadProvider?: () => Promise<Pick<IntegrationProvider, "providerId" | "listApps"> | null>,
) {
  let request: Promise<ToolProgressIntegrationContext | undefined> | undefined;
  return () => {
    if (request) return request;
    request = (async () => {
      if (!loadProvider) return undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            const provider = await loadProvider();
            if (!provider) return undefined;
            const result = await provider.listApps(undefined, 256);
            return {
              providerId: provider.providerId,
              apps: result.apps.slice(0, 256).map((app) => ({
                id: app.id,
                name: app.name,
                description: "",
                ...(app.icon && /^https?:\/\//i.test(app.icon) ? { icon: app.icon } : {}),
              })),
            };
          })(),
          new Promise<undefined>((resolve) => {
            timeout = setTimeout(() => resolve(undefined), 2_000);
            timeout.unref?.();
          }),
        ]);
      } catch {
        return undefined;
      } finally {
        clearTimeout(timeout);
      }
    })();
    return request;
  };
}
