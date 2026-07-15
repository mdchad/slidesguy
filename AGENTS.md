# Repository Guidelines

## Project Structure & Module Organization

Application code lives in `src/`. TanStack Start page and API routes are file-based under `src/routes/`; `src/routeTree.gen.ts` is generated and must not be edited manually. The spreadsheet-to-deck pipeline is implemented in `src/lib/slidegen/`, while `src/workflow.ts` coordinates the Cloudflare Workflow and `src/server.ts` is the Worker entry point. Unit tests are in `tests/slidegen/`, with Cloudflare stubs in `tests/stubs/` and sample workbooks in `tests/fixtures/`. Database changes belong in `migrations/`; static browser assets belong in `public/`. See `docs/slides-generator-spec-v0.md` for product behavior.

## Build, Test, and Development Commands

Use Bun; dependencies are locked in `bun.lock`.

- `bun install` installs dependencies.
- `bun run dev` starts the instrumented local server on port 3000.
- `bun run build` creates the production Vite/Cloudflare build.
- `bun run test` runs the Vitest suite once; use `bun run test tests/slidegen/facts.test.ts` for one file.
- `bunx vitest` runs tests in watch mode.
- `bunx tsc --noEmit` performs strict type checking.
- `bun run generate-routes` refreshes the generated route tree.
- `bun run cf-typegen` refreshes Worker binding types after `wrangler.jsonc` changes.

## Coding Style & Naming Conventions

Write strict TypeScript/TSX using ES modules, two-space indentation, single quotes, and trailing commas where the existing style does. Prefer `#/` imports for code under `src/`. Use `camelCase` for values/functions, `PascalCase` for components and types, and lowercase descriptive filenames such as `chartdata.ts`. Keep route filenames aligned with TanStack conventions (for example, `$jobId.download.ts`). There is no separate formatter or linter; match nearby code and ensure TypeScript reports no unused declarations.

## Testing Guidelines

Vitest discovers `tests/**/*.test.ts`. Name suites after the unit under test and write behavior-focused `it(...)` descriptions. Add deterministic unit coverage for parsing, normalization, chart data, validation, and assembly changes. Reuse fixtures where practical; mock external LLM requests and Cloudflare-only modules. Run the full suite before submitting.

## Commit & Pull Request Guidelines

Recent history uses short, direct subjects (for example, `added verification`); keep commits focused and use an imperative summary that states the outcome. Pull requests should explain the change, testing performed, configuration or migration impact, and link relevant issues. Include screenshots for UI changes and sample `.pptx` output details for deck-generation changes.

## Security & Configuration

Copy `.dev.vars.example` for local secrets. Never commit API keys or place secrets in `wrangler.jsonc`; use `wrangler secret put` for production. Document any new D1, R2, Workflow, or environment binding and regenerate its types.
