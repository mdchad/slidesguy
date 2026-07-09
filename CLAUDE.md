# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **bun** (see `bun.lock`). Prefer `bun --bun run <script>`.

- `bun run dev` — dev server on port 3000. Loads `.env.local` via `dotenv` and preloads Sentry instrumentation. Use this rather than a bare `vite dev`, or env vars and Sentry won't be wired up.
- `bun run build` — Vite build; also copies `instrument.server.mjs` into `.output/server`.
- `bun run test` — run the full Vitest suite once. A single test: `bun run test <path>` or `bun run test -t "<name>"`. Watch mode: `bunx vitest`.
- `bun run deploy` — build then `wrangler deploy` to Cloudflare Workers.
- `bun run generate-routes` — regenerate `src/routeTree.gen.ts` from `src/routes/` (also runs automatically in dev/build via the router plugin).
- `bun run cf-typegen` — regenerate `worker-configuration.d.ts` after changing Cloudflare bindings in `wrangler.jsonc`.

There is no separate lint step; type checking is via `tsc` (strict mode, `noUnusedLocals`/`noUnusedParameters` on).

## Architecture

TanStack Start (React 19 SSR) app that runs as a **single Cloudflare Worker**. `vite.config.ts` wires the Cloudflare plugin (`ssr` environment) together with TanStack Start; `wrangler.jsonc` points `main` at `@tanstack/react-start/server-entry`, so both server and client build from the same entry.

**Routing** is file-based under `src/routes/`. `src/routeTree.gen.ts` is generated — never edit it by hand. `src/routes/__root.tsx` is the app shell (html/head/body, header/footer, devtools, and an inline theme-init script that resolves light/dark before hydration). API endpoints live alongside page routes as files exporting a `server.handlers` object.

**Path aliases:** both `#/*` and `@/*` map to `src/*` (`#/*` is also a real Node subpath import in `package.json`, so it works at runtime, not just in TS).

### Three parallel API layers

The app deliberately exposes the same oRPC router three ways — know which you're touching:

1. **oRPC RPC** (`src/routes/api.rpc.$.ts`) — `RPCHandler` at `/api/rpc`, consumed by the typed client in `src/orpc/client.ts`.
2. **oRPC OpenAPI** (`src/routes/api.$.ts`) — `OpenAPIHandler` at `/api` with a Scalar playground and OpenAPI spec generation from the same procedures.
3. **Better Auth** (`src/routes/api/auth/$.ts`) — delegates all `/api/auth/*` to `auth.handler`.

Procedures are defined in `src/orpc/router/` (built with `os` from `@orpc/server`, Zod-validated inputs) and aggregated in `src/orpc/router/index.ts`. To add an endpoint, write the procedure there and register it in the index — all three layers pick it up automatically.

**oRPC client** (`src/orpc/client.ts`) is isomorphic via `createIsomorphicFn`: on the server it calls the router directly (in-process, forwarding request headers as context); in the browser it goes over HTTP to `/api/rpc`. `orpc` wraps the client with TanStack Query utils, so components consume procedures as query/mutation options.

### Auth

Better Auth (`src/lib/auth.ts`) with email/password and the `tanstackStartCookies()` plugin for cookie handling. Client is `src/lib/auth-client.ts`. Currently stateless (no database configured) — the README documents how to add a Postgres pool and run migrations.

### Data & state

TanStack Query is the data layer; the `QueryClient` is created per request in `src/integrations/tanstack-query/root-provider.tsx` and threaded through router context (`MyRouterContext`), wired for SSR by `setupRouterSsrQueryIntegration` in `src/router.tsx`. TanStack Store is used for local client state.

### Observability

Sentry is initialized in `instrument.server.mjs` (preloaded via `NODE_OPTIONS --import`) and configured in `src/router.tsx` for error collection. Per `.cursorrules`: wrap server-function bodies in `Sentry.startSpan({ name: '...' }, async () => { ... })` to instrument them.

## Conventions

- **shadcn/ui** ("new-york" style, zinc base, Lucide icons). Add components with `pnpm dlx shadcn@latest add <name>`. `cn()` helper lives in `src/lib/utils.ts`; UI components go in `src/components/ui`.
- Files prefixed **`demo-`** (components, hooks, lib, data) and everything under **`src/routes/demo/`** are scaffolding from the starter — safe to delete, and not part of the real app. The `demo/` routes exercise the installed features (oRPC todos, TanStack AI chat/image/TTS/transcription/structured output, store, better-auth, Sentry testing).
- Cloudflare bindings (KV, D1, R2, Durable Objects, vars) are declared in `wrangler.jsonc`; run `cf-typegen` after changes. Secrets go through `wrangler secret put`, not `wrangler.jsonc`.
