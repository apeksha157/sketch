# Resolution Eval Harness

All commands must be run from the repository root and must pass the database name or connection string explicitly. Do not rely on `.env` for tenant selection.

## Build the pinned manifest

```bash
. ~/.nvm/nvm.sh && nvm use > /dev/null 2>&1 && pnpm --dir packages/server exec tsx src/scripts/resolution-eval/build-manifest.ts sketch_canvas_ai --out src/scripts/resolution-eval/eval-manifest.json
```

## Refresh the eval snapshot

```bash
. ~/.nvm/nvm.sh && nvm use > /dev/null 2>&1 && pnpm --dir packages/server exec tsx src/scripts/resolution-eval/snapshot.ts sketch_canvas_ai --eval-db sketch_canvas_ai_eval
```

If `CREATE DATABASE ... TEMPLATE` cannot get a quiet source database, the script falls back to `pg_dump | pg_restore`. Use `--force-dump` to take that path directly.

## Run the baseline assertions

```bash
. ~/.nvm/nvm.sh && nvm use > /dev/null 2>&1 && pnpm --dir packages/server exec tsx src/scripts/resolution-eval/run-eval.ts --db sketch_canvas_ai_eval --set baseline
```

To refresh and run in one command:

```bash
. ~/.nvm/nvm.sh && nvm use > /dev/null 2>&1 && pnpm --dir packages/server exec tsx src/scripts/resolution-eval/run-eval.ts --source-db sketch_canvas_ai --eval-db sketch_canvas_ai_eval --refresh-snapshot --set baseline
```

Reports are written to `packages/server/src/scripts/resolution-eval/reports/` as both JSON and Markdown.

## Backfill entity mentions

Dry-run first:

```bash
. ~/.nvm/nvm.sh && nvm use > /dev/null 2>&1 && pnpm --dir packages/server exec tsx src/scripts/backfill-entity-mentions.ts --db sketch_capmobfinance_gates
```

Apply after reviewing the JSON census:

```bash
. ~/.nvm/nvm.sh && nvm use > /dev/null 2>&1 && pnpm --dir packages/server exec tsx src/scripts/backfill-entity-mentions.ts --db sketch_capmobfinance_gates --apply

## Backfill Zoho source meta

Dry-run first; the script prints a JSON census and does not write without `--apply`.

```bash
. ~/.nvm/nvm.sh && nvm use > /dev/null 2>&1 && pnpm --dir packages/server exec tsx src/scripts/backfill-zoho-source-meta.ts --db sketch_capmobfinance_gates
```

```bash
. ~/.nvm/nvm.sh && nvm use > /dev/null 2>&1 && pnpm --dir packages/server exec tsx src/scripts/backfill-zoho-source-meta.ts --db sketch_capmobfinance_gates --apply
```

## Verify the harness

```bash
. ~/.nvm/nvm.sh && nvm use > /dev/null 2>&1 && pnpm --dir packages/server exec vitest run --project unit src/scripts/resolution-eval/manifest.test.ts src/scripts/resolution-eval/report.test.ts src/scripts/resolution-eval/adjacency.test.ts
```

```bash
. ~/.nvm/nvm.sh && nvm use > /dev/null 2>&1 && pnpm biome check
```

```bash
. ~/.nvm/nvm.sh && nvm use > /dev/null 2>&1 && pnpm typecheck
```

```bash
. ~/.nvm/nvm.sh && nvm use > /dev/null 2>&1 && pnpm test
```

```bash
. ~/.nvm/nvm.sh && nvm use > /dev/null 2>&1 && pnpm build
```
