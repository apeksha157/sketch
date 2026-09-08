import { Button } from "@sketch/ui/components/button";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { rootRoute } from "./root";

export const benchmarkSetupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/benchmark-setup",
  component: BenchmarkSetupPage,
});

interface SetupContext {
  connectionError?: string;
  owner: { name: string; email: string };
  connections: { id: string; name: string }[];
  connectUrl: string;
}
interface Location {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
}

export function BenchmarkSetupPage() {
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "");
  const [context, setContext] = useState<SetupContext | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [integration, setIntegration] = useState("clickup");
  const [accountId, setAccountId] = useState("");
  const [spaceId, setSpaceId] = useState("");
  const [secondSpaceId, setSecondSpaceId] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  async function post<T>(path: string, body: object): Promise<T> {
    const response = await fetch(`/api/benchmark-setup/${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, ...body }),
    });
    const value = await response.json();
    if (!response.ok)
      throw new Error(
        typeof value.error === "string"
          ? value.error
          : "Sign in to this test tenant first, then return to this setup tab.",
      );
    return value;
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Setup could not finish.");
    } finally {
      setBusy(false);
    }
  }
  const field = "h-10 rounded-md border bg-background px-3 text-sm";
  return (
    <main className="mx-auto max-w-2xl space-y-6 p-8 sm:pt-16">
      <header>
        <h1 className="text-2xl font-semibold">Connect a benchmark test profile</h1>
        <p className="mt-2 text-muted-foreground">Set up once here, then run batches from Sketch Platform.</p>
      </header>
      {!token && <p role="alert">Open a fresh setup link from the Benchmarks tab in Platform.</p>}
      {done ? (
        <div aria-live="polite" className="rounded-lg border p-6">
          <h2 className="font-medium">Your test profile is ready</h2>
          <p className="mt-2 text-sm">Return to Platform Benchmarks and select it. You can close this tab.</p>
        </div>
      ) : (
        <>
          <section className="space-y-4 rounded-xl border p-5">
            <h2 className="font-medium">1. Sign in and connect</h2>
            <p className="text-sm text-muted-foreground">
              Use a dedicated Sketch test identity. The setup link doesn’t sign you in or grant access to another
              person’s integrations.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild variant="outline">
                <a href="/integrations?connect=clickup" target="_blank" rel="noreferrer">
                  Sign in / connect ClickUp
                </a>
              </Button>
              <Button
                disabled={!token || busy}
                onClick={() =>
                  void perform(async () => {
                    setContext(await post<SetupContext>("context", {}));
                  })
                }
              >
                Refresh my connections
              </Button>
            </div>
            {context && (
              <p className="text-sm">
                Signed in as <strong>{context.owner.name}</strong> ({context.owner.email})
              </p>
            )}
          </section>
          {context && (
            <section className="space-y-4 rounded-xl border p-5">
              {context.connectionError && (
                <p role="alert" className="text-sm">
                  {context.connectionError}
                </p>
              )}
              <h2 className="font-medium">2. Choose what to test</h2>
              <label className="flex flex-col gap-2 text-sm">
                Test profile
                <select
                  className={field}
                  value={integration}
                  onChange={(event) => {
                    setIntegration(event.target.value);
                    setConsent(false);
                  }}
                >
                  <option value="clickup">ClickUp integration and automations</option>
                  <option value="none">Core automations — no integration needed</option>
                </select>
              </label>
              {integration === "clickup" && (
                <>
                  <label className="flex flex-col gap-2 text-sm">
                    Your connected account
                    <select
                      className={field}
                      value={accountId}
                      onChange={(event) => {
                        const id = event.target.value;
                        setAccountId(id);
                        setSpaceId("");
                        setSecondSpaceId("");
                        setLocations([]);
                        void perform(async () =>
                          setLocations(
                            (await post<{ locations: Location[] }>("locations", { accountId: id })).locations,
                          ),
                        );
                      }}
                    >
                      <option value="">Select account</option>
                      {context.connections.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="text-sm text-muted-foreground">
                    Each case creates its own temporary lists and tasks in these test Spaces, then cleans them up.
                  </p>
                  <label className="flex flex-col gap-2 text-sm">
                    First test Space
                    <select
                      className={field}
                      value={spaceId}
                      onChange={(event) => {
                        setSpaceId(event.target.value);
                        setSecondSpaceId("");
                      }}
                    >
                      <option value="">Select Space</option>
                      {locations.map((location) => (
                        <option key={location.id} value={location.id}>
                          {location.teamName} / {location.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-2 text-sm">
                    Second test Space
                    <select
                      className={field}
                      value={secondSpaceId}
                      onChange={(event) => setSecondSpaceId(event.target.value)}
                    >
                      <option value="">Select Space</option>
                      {locations
                        .filter(
                          (location) => location.teamId === locations.find((entry) => entry.id === spaceId)?.teamId,
                        )
                        .map((location) => (
                          <option key={location.id} value={location.id}>
                            {location.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </>
              )}
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                  className="mt-1"
                />
                <span>
                  I’m using a dedicated test identity and allow people with Platform Benchmarks access to run tests
                  using this profile. Tests may create temporary automations, files and integration records. A shared
                  ops login identifies the ops account, not an individual person.
                </span>
              </label>
              <Button
                disabled={busy || !consent || (integration === "clickup" && (!accountId || !spaceId || !secondSpaceId))}
                onClick={() =>
                  void perform(async () => {
                    await post("enrollment", {
                      enrollment: {
                        integration,
                        accountId: integration === "none" ? "sketch" : accountId,
                        teamId:
                          integration === "none" ? "0" : locations.find((location) => location.id === spaceId)?.teamId,
                        spaceId: integration === "none" ? "0" : spaceId,
                        secondSpaceId: integration === "none" ? "0" : secondSpaceId,
                        dedicatedTestAccount: true,
                        sharedWithBenchmarkTeam: true,
                      },
                    });
                    setDone(true);
                    window.history.replaceState(null, "", window.location.pathname);
                  })
                }
              >
                Make available in Benchmarks
              </Button>
            </section>
          )}
          {error && (
            <p role="alert" className="rounded-lg border p-4 text-sm">
              {error}
            </p>
          )}
        </>
      )}
    </main>
  );
}
