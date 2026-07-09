# Slides Generator — Implementation Spec (v0)

This document is the authoritative spec for building the v0 slides generator. It encodes final architecture decisions; do not re-litigate them. Items you MUST verify against current Cloudflare docs before coding are listed in §12.

## 1. Overview

Users upload a spreadsheet; the system uses an LLM to plan and generate a slide deck (text + native PPTX charts) and produces a downloadable `.pptx`. Generation is asynchronous; the client polls for status.

Failure policy: each slide batch gets limited retries. If any batch exhausts retries, the ENTIRE job is marked failed and the user must regenerate. Failures must be debuggable from D1 + logs alone (support scenario: user emails with a jobId or account email).

## 2. Stack (fixed decisions)

- Cloudflare Workers + **Cloudflare Workflows** (orchestration). NO Queues, NO Durable Object counters, NO hand-rolled fan-out/join.
- **D1**: job records (status, errors, ownership).
- **R2**: source spreadsheet, slide fragments (JSON), final `.pptx`.
- **pptxgenjs** running inside the Workflow's assemble step. Charts are generated NATIVELY via `slide.addChart()` — real OOXML chart objects. NO chart rasterization, NO client-side chart rendering, NO PNG chart images, NO containers.
- Spreadsheet parsing: SheetJS (`xlsx` package).
- Validation: zod.
- Config: `wrangler.jsonc` (no Alchemy, no Terraform).
- Frontend (upload UI / polling) is out of scope for this spec except for the HTTP API contract in §6. Assume a separate client consumes the API.

## 3. Repository layout

```
/src
  index.ts            # Worker entrypoint: HTTP routes (upload, status, download)
  workflow.ts         # SlidesWorkflow (WorkflowEntrypoint)
  lib/
    llm.ts            # LLM client wrapper (provider-agnostic; see §8)
    slides.ts         # SlideSpec zod schemas + validation
    generate.ts       # per-slide generation (LLM call -> validated spec -> R2)
    assemble.ts       # pptxgenjs replay: fragments -> final.pptx
    spreadsheet.ts    # SheetJS parsing -> normalized table data
    db.ts             # D1 helpers (typed queries)
    r2keys.ts         # single source of truth for R2 key construction
    errors.ts         # error taxonomy helpers (NonRetryableError usage)
    alert.ts          # webhook notifier for failures
/migrations
  0001_init.sql
wrangler.jsonc
```

## 4. R2 key scheme (single source of truth in `r2keys.ts`)

```
jobs/{jobId}/source.xlsx                      # uploaded spreadsheet
jobs/{jobId}/plan.json                        # deck plan (list of slide inputs)
jobs/{jobId}/slides/slide-{NN}.json           # fragment per slide, NN zero-padded 2 digits
jobs/{jobId}/final.pptx                       # assembled deck
```

Rules:
- Zero-padded indices; ordering is ALWAYS derived from the index in the key/payload, never from any delivery or listing order assumption beyond lexicographic sort of zero-padded keys.
- Fragment writes are idempotent by construction (deterministic keys, overwrite-safe).
- Do NOT delete fragments on failure. Cleanup is handled by an R2 lifecycle rule (§11), preserving the future option of partial-reuse regeneration.

## 5. D1 schema (`0001_init.sql`)

```sql
CREATE TABLE jobs (
  job_id          TEXT PRIMARY KEY,
  presentation_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  total_slides    INTEGER,            -- NULL until plan step completes
  status          TEXT NOT NULL,      -- queued | processing | done | failed
  failed_step     TEXT,               -- e.g. 'plan', 'slides-00-09', 'assemble'
  error_msg       TEXT,               -- truncated to 1000 chars
  created_at      INTEGER NOT NULL,   -- unix ms
  finished_at     INTEGER
);
CREATE INDEX idx_jobs_user ON jobs(user_id, created_at DESC);
```

- `job_id` = one ephemeral generation run. `presentation_id` = durable document identity (regenerate = new job_id, same presentation_id).
- v0 auth is a stub: accept `user_id` from a header (`X-User-Id`) with a TODO marker for real auth. All queries that return job data MUST filter by `user_id`.

## 6. HTTP API (Worker `index.ts`)

### POST /api/jobs
Multipart form: `file` (.xlsx), `presentation_id` (optional; generate if absent).
1. Validate file (extension + size cap 10 MB; reject otherwise with 400).
2. `jobId = crypto.randomUUID()`.
3. Put spreadsheet to `jobs/{jobId}/source.xlsx`.
4. INSERT D1 row (`status='queued'`).
5. `env.SLIDES_WORKFLOW.create({ id: jobId, params: { jobId, userId, presentationId } })`.
   - Instance id = jobId (free dedup: duplicate create for same id must fail; treat that error as 409).
6. Return `202 { jobId }`.

Order matters: R2 put → D1 insert → workflow create. If workflow create fails, mark the D1 row failed and return 500.

### GET /api/jobs/:jobId
Return the D1 row (status, total_slides, failed_step, error_msg, timestamps). 404 if not found or user_id mismatch. Client polls this.

### GET /api/jobs/:jobId/download
Check D1: status must be `done` and user_id must match. Stream `jobs/{jobId}/final.pptx` from R2 through the Worker with
`Content-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation` and a Content-Disposition filename. Do NOT use presigned URLs.

## 7. The Workflow (`workflow.ts`)

One class `SlidesWorkflow extends WorkflowEntrypoint`. Steps, in order:

1. **`mark-processing`** — D1 `status='processing'`.
2. **`plan`** — read `source.xlsx` from R2, parse with SheetJS (`spreadsheet.ts`), call the LLM once to produce a deck plan: an ordered array of per-slide inputs (which data rows/ranges each slide uses, slide intent, suggested chart type). Validate with zod. Write `plan.json` to R2; UPDATE D1 `total_slides`. Return `{ planKey, totalSlides }` (keys/counts only — never the plan content).
   - Retries: `{ limit: 3, delay: '10 seconds', backoff: 'exponential' }`, timeout `2 minutes`.
   - Cap: if plan yields > 60 slides, throw `NonRetryableError('deck too large')`.
3. **Slide batches** — for slide indices in batches of 10, SEQUENTIAL batches, one step per batch named `slides-{start}-{end}` (e.g. `slides-00-09`):
   - Inside the step: `Promise.all` over the batch with concurrency 5 (use a tiny p-limit-style helper; do not add a dependency for it).
   - Each slide: `generateSlide(plan.slides[i])` → LLM call → zod-validate the returned SlideSpec → write `slides/slide-{NN}.json` to R2.
   - Step returns ONLY the array of R2 keys. NEVER return slide content, spec JSON, or any base64 from a step — step results are persisted/replayed and must stay tiny.
   - Retries: `{ limit: 3, delay: '10 seconds', backoff: 'exponential' }`, timeout `4 minutes` per batch step.
   - The step must be idempotent: re-running regenerates and overwrites fragments at the same keys. Acceptable.
4. **`assemble`** — list `jobs/{jobId}/slides/`, verify count === total_slides (mismatch → `NonRetryableError`), sort keys lexicographically, load each fragment JSON, replay through pptxgenjs (§9), write `final.pptx` to R2. Return the output key only. Retries: `{ limit: 2 }` (no LLM cost to retry; deterministic).
5. **`mark-done`** — D1 `status='done'`, `finished_at=now`.

Wrap steps 2–5 in try/catch. Catch block:
- `step.do('mark-failed', ...)`: D1 `status='failed'`, `failed_step`, `error_msg` (truncate 1000 chars), `finished_at`.
- `step.do('alert', ...)`: POST webhook (§10). Webhook failure must not mask the original error — catch and log it.
- Rethrow the original error so the workflow instance itself shows as errored in the dashboard.

Failure semantics to preserve: a batch exhausting retries rejects its `Promise.all`, propagates out, and kills the whole job. Do NOT build partial-success handling, cancellation of in-flight siblings, or resume-from-partial. Explicit non-goals for v0.

## 8. LLM integration (`llm.ts`, `generate.ts`)

- Provider-agnostic wrapper: `callLLM(prompt, { schemaHint }): Promise<string>`. Read API key from a Workers secret (`LLM_API_KEY`), model + base URL from vars. Implement for the Anthropic Messages API by default.
- Error taxonomy (this drives retry cost — implement exactly):
  - HTTP 429 / 5xx / network / timeout → throw a NORMAL Error (Workflows retries the step).
  - HTTP 400 (malformed request), content refusal, or output that fails zod validation after ONE in-step repair attempt (re-prompt once with the validation errors appended) → throw `NonRetryableError` from `cloudflare:workers` with a descriptive message. Retrying deterministic failures burns money for nothing.
- Prompting: the LLM must return ONLY JSON matching the SlideSpec schema (§9). Include the JSON schema in the prompt. Strip markdown fences before parsing.

## 9. SlideSpec schema and assembly (`slides.ts`, `assemble.ts`)

zod schemas — keep the chart vocabulary CLOSED (only types pptxgenjs supports natively; do not let the LLM invent types):

```ts
const ChartType = z.enum(['bar', 'column', 'line', 'area', 'pie', 'doughnut', 'scatter', 'radar']);

const ChartSpec = z.object({
  type: ChartType,
  title: z.string().max(120).optional(),
  series: z.array(z.object({
    name: z.string(),
    labels: z.array(z.string()).max(50),
    values: z.array(z.number()).max(50),
  })).min(1).max(8),
  showLegend: z.boolean().default(true),
  showValueLabels: z.boolean().default(false),
});

const SlideSpec = z.object({
  index: z.number().int().min(0),
  layout: z.enum(['title', 'title-body', 'title-chart', 'title-body-chart', 'two-column']),
  title: z.string().max(200),
  body: z.array(z.string().max(500)).max(8).optional(),   // bullet lines
  chart: ChartSpec.optional(),
  notes: z.string().max(1000).optional(),                  // speaker notes
});
```

Assembly (`assemble.ts`):
- `const pptx = new pptxgenjs(); pptx.defineLayout(...)` 16:9.
- For each fragment in index order: `pptx.addSlide()`, place title/body via `addText`, chart via `slide.addChart(pptx.ChartType[map(spec.chart.type)], data, options)` mapping ChartSpec → pptxgenjs chart data format (`[{ name, labels, values }]`). Map `bar` → horizontal bar, `column` → vertical bar per pptxgenjs conventions.
- Speaker notes via `slide.addNotes(spec.notes)`.
- Keep positioning simple and hardcoded per layout enum (a small layout table of x/y/w/h). No template/theming system in v0.
- Output: `pptx.write({ outputType: 'arraybuffer' })` (verify exact API for current pptxgenjs version) → `env.BUCKET.put(finalKey, buffer)`.
- pptxgenjs runs on Workers runtime: verify it imports cleanly (it may touch Node/browser globals; enable `nodejs_compat` flag; if a specific global is missing, shim minimally rather than switching libraries).

## 10. Logging, observability, alerting

- `wrangler.jsonc`: `"observability": { "enabled": true }`.
- Every failed slide attempt: `console.error(JSON.stringify({ evt: 'slide_fail', jobId, slideIndex, attempt, err: String(err).slice(0, 500) }))`. Log EVERY attempt failure, not only the terminal one (support needs to see whether it failed the same way 3×).
- Same pattern for `plan_fail`, `assemble_fail`, `job_failed`.
- `alert.ts`: POST to `ALERT_WEBHOOK_URL` (secret) with `{ jobId, userId, failedStep, errorMsg, dashboardHint: jobId }`. Fire only from the workflow catch block. If the secret is unset, no-op.

## 11. wrangler.jsonc requirements

- Workflow binding `SLIDES_WORKFLOW` → class `SlidesWorkflow`.
- D1 binding `DB`, R2 binding `BUCKET`.
- `compatibility_flags: ["nodejs_compat"]`.
- Secrets (via `wrangler secret put`): `LLM_API_KEY`, `ALERT_WEBHOOK_URL`.
- Document (in README) the R2 lifecycle rule to configure: expire objects under prefix `jobs/` matching `*/slides/*` and `*/plan.json` after 2 days; `final.pptx` retained 30 days. If prefix-granular rules aren't expressible, expire the whole `jobs/` prefix at 30 days and note the tradeoff.

## 12. VERIFY AGAINST CURRENT CLOUDFLARE DOCS BEFORE CODING

Do not trust this spec (or your training data) for these — they change:
1. Workflows: max steps per instance, max step return-payload size, max retries config shape, `NonRetryableError` import path, `WorkflowEntrypoint` signature.
2. Whether `step.do` supports the `{ retries, timeout }` config object syntax shown here, or current equivalent.
3. Workflow instance creation API from a Worker binding (`.create({ id, params })`) and duplicate-id error behavior.
4. pptxgenjs current version: Workers compatibility, `write()` output types, chart data format, chart type enum names.
5. D1 and R2 binding config syntax in `wrangler.jsonc`.
6. R2 lifecycle rule capabilities (prefix granularity).

## 13. Acceptance criteria

1. Upload a sample xlsx → 202 with jobId; polling transitions queued → processing → done; download returns a valid .pptx that opens in PowerPoint with native, editable charts (click a chart → chart tools appear, not a picture).
2. Slide order in the deck matches plan order for a 25-slide deck.
3. Two jobs created concurrently (different jobIds) both complete; fragments and outputs land under their own prefixes; no cross-contamination (assert by listing R2 prefixes).
4. Kill/fault injection: force `generateSlide` to throw a normal Error twice then succeed → job still completes (retries work, fragments not duplicated/corrupted).
5. Force a `NonRetryableError` on one slide → job goes to `failed` with correct `failed_step` and `error_msg` in D1; webhook fired; workflow instance shows errored in dashboard; other in-flight batch slides do not corrupt state.
6. Duplicate POST with same workflow id → 409, single D1 row remains consistent.
7. Download endpoint returns 404 for a different `X-User-Id`.
8. Memory check: generate a 60-slide deck where every slide has a chart; assemble completes on Workers (log `performance.memory`-equivalent if available, or at minimum confirm no OOM). Record the result in the README.

## 14. Non-goals (do not build)

Partial-failure resume/reuse of fragments; cancellation of in-flight LLM calls; chart rasterization or containers; PPTX theming/templates; real auth; rate-limiter DO (add only if 429s appear under load — leave a TODO); Alchemy/IaC migration; editing existing presentations.

---

## Addendum: §12 verification results (2026-07-08)

1. `WorkflowEntrypoint`/`WorkflowStep`/`WorkflowEvent` import from `cloudflare:workers`; **`NonRetryableError` imports from `cloudflare:workflows`** (§8's `cloudflare:workers` was wrong). Limits (free plan): 1,024 steps/instance, 1 MiB step return, 100 concurrent instances — all fine for this design. Free plan caps CPU at 10 ms/step, so Workers Paid is effectively required for the assemble step.
2. `step.do(name, { retries: { limit, delay, backoff }, timeout }, fn)` syntax confirmed current.
3. `env.SLIDES_WORKFLOW.create({ id, params })` confirmed; duplicate id throws with **no documented error code** — implementation catches and message-matches to map to 409 (plus D1 PK violation as first line of defence).
4. pptxgenjs 4.0.1: `await pptx.write({ outputType: 'arraybuffer' })`; no `column` enum — `bar`/`column` both map to `ChartType.bar` with `barDir: 'bar' | 'col'`. Runs on Workers (verified empirically in workerd; charts emit native `c:chartSpace` OOXML). SheetJS: npm `xlsx` is stale — installed 0.20.3 from cdn.sheetjs.com tarball.
5. Binding syntax confirmed; see `wrangler.jsonc`.
6. R2 lifecycle rules are **prefix-only** — the fallback applies: expire `jobs/` at 30 days (documented in README).

Deployment deviation from §3: the generator lives inside the existing TanStack Start app (custom server entry `src/server.ts` exports `SlidesWorkflow`; HTTP API is TanStack server routes under `src/routes/api/jobs/`; libs under `src/lib/slidegen/`).
