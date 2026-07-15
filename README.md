Welcome to your new TanStack Start app! 

# Slides Generator

Upload an `.xlsx` → an LLM plans and generates a slide deck → download a `.pptx` with native, editable charts. Spec: `docs/slides-generator-spec-v0.md`. Runs as a Cloudflare Workflow (`SlidesWorkflow`) exported from the custom server entry `src/server.ts`.

## API

- `POST /api/jobs` — multipart form with `file` (.xlsx, ≤10 MB) and optional `presentation_id`. Returns `202 {jobId}`. Requires an `X-User-Id` header (v0 auth stub).
- `GET /api/jobs/:jobId` — poll status: `queued | processing | done | failed` (+ `failedStep`, `errorMsg`).
- `GET /api/jobs/:jobId/download` — the finished `.pptx` (404 until `done`).

## Setup

- Local: copy `.dev.vars.example` to `.dev.vars` and set `LLM_API_KEY`. Apply migrations: `bunx wrangler d1 migrations apply slidesguy-db --local`.
- LLM provider defaults to **OpenAI** (`LLM_PROVIDER=openai`, `LLM_MODEL=gpt-4o`, `LLM_BASE_URL=https://api.openai.com` in `wrangler.jsonc` `vars`). Uses OpenAI Chat Completions with JSON-object response mode. Set `LLM_PROVIDER=anthropic` to switch to the Anthropic Messages API instead; change the model/base URL to match.
- Production: `wrangler secret put LLM_API_KEY` and (optionally) `wrangler secret put ALERT_WEBHOOK_URL`; `bunx wrangler d1 migrations apply slidesguy-db --remote` before first deploy.
- **Workers Paid plan is effectively required**: the free plan caps CPU at 10 ms per Workflow step, which the pptxgenjs assemble step will exceed on any realistic deck.

## R2 lifecycle rule (configure manually)

R2 lifecycle rules match key **prefixes only** — the per-object-type expiry the spec wanted (`*/slides/*` after 2 days) is not expressible. Configure instead, on the `slidesguy-jobs` bucket: **expire objects under prefix `jobs/` after 30 days**. Tradeoff: intermediate fragments and plans live the full 30 days instead of 2; they are small JSON objects, so the cost is negligible, and keeping them preserves debuggability and the future partial-reuse option.

## Testing

Unit tests: `bun run test` (schemas, normalization, number verification, assembly/chart XML). End-to-end testing runs against the real LLM through the frontend: `bun run dev`, open `http://localhost:3000`, upload a spreadsheet. `bun scripts/make-fixtures.ts` writes sample `.xlsx` files to `tests/fixtures/` if you need upload material.

Fault injection for retry testing: set `SLIDEGEN_FAULT=transient-twice:<idx>` or `nonretryable:<idx>` in `.dev.vars` (see `.dev.vars.example`).

## Hallucination controls

Three layers keep decks grounded in the uploaded spreadsheet:

1. **Grounding prompts** — plan and slide prompts declare the spreadsheet the only source of truth and forbid metrics/concepts absent from it.
2. **Charts computed by construction** — the LLM never writes chart numbers. It emits a query (`labelColumn` + per-series `columns` to sum + optional `groupBy`), and `chartdata.ts` computes the values from actual cells. Derived series (e.g. "Total expenses" across several columns, per-category aggregation) are supported. Prompts include computed column profiles (numeric/text/mixed) so the model picks valid columns; a bad query gets one repair re-prompt with the usable columns named, and if it still can't resolve, the chart is dropped and the slide ships as text (`evt: slide_chart_dropped`) rather than failing the deck.
3. **Verified statistics** (`facts.ts`) — per-column stats (presence with month lists, sum, avg, min/max with row attribution) plus the sheet's own Total/Subtotal/Profit rows (extracted from the data by the parser) are computed in code and injected into generation ("cite verbatim") and audit ("these are grounded"). Neither model can reliably sum sparse scattered cells, so derived prose numbers must come from here.
4. **Deck-level audit** (`audit` workflow step) — an LLM call reviews all slide prose against the data + verified statistics. Each finding must carry an explicit `supported` verdict (LLM judges over-fill violation lists; only `supported: false` counts). Flagged slides are regenerated with the violations as feedback, up to two repair rounds; anything still flagged after that ships with warnings (`evt: audit_unresolved`) rather than failing the deck — the auditor is a noisy judge and the hard numeric guarantees are already deterministic.

The parser (`spreadsheet.ts`) handles real-world sheet mess: title rows, multi-row grouped headers with merged bands (producing names like `Expenses / Domains / Namecheap`), nested sub-headers, Total/Profit rows inside the grid (extracted as facts, excluded from chart data), and blank rows/columns.

**Memory check result (spec §13.8, run 2026-07-08):** a 60-slide deck with a native chart on every slide assembled successfully in local workerd (`vite dev`), producing a 1.8 MB `.pptx` (60 slide XMLs, 60 chart XMLs, no rasterized media); no OOM. Local dev does not enforce the production 128 MB isolate limit, so re-verify once after the first production deploy.

## Support / debugging a failed job

Given a `jobId` (or an account email → `SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC`):

1. `wrangler d1 execute slidesguy-db --remote --command "SELECT * FROM jobs WHERE job_id = '<jobId>'"` — shows `status`, `failed_step`, `error_msg`.
2. Workers observability logs: filter for the jobId; every failed attempt is logged as JSON (`evt: slide_fail | plan_fail | assemble_fail | job_failed`) including per-attempt errors.
3. Cloudflare dashboard → Workflows → `slides-workflow` → instance id = jobId shows the errored step and retry history.
4. Intermediate artifacts remain in R2 under `jobs/<jobId>/` (30-day lifecycle) for inspection.

# Getting Started

To run this application:

```bash
bun install
bun --bun run dev
```

# Building For Production

To build this application for production:

```bash
bun --bun run build
```

## Testing

This project uses [Vitest](https://vitest.dev/) for testing. You can run the tests with:

```bash
bun --bun run test
```

## Styling

This project uses [Tailwind CSS](https://tailwindcss.com/) for styling.

### Removing Tailwind CSS

If you prefer not to use Tailwind CSS:

1. Remove the demo pages in `src/routes/demo/`
2. Replace the Tailwind import in `src/styles.css` with your own styles
3. Remove `tailwindcss()` from the plugins array in `vite.config.ts`
4. Uninstall the packages: `bun install @tailwindcss/vite tailwindcss -D`


## Deploy to Cloudflare Workers

This project uses the Cloudflare Vite plugin (configured in `vite.config.ts`) and `wrangler.jsonc`:

1. Install Wrangler: `npm install -g wrangler`
2. Authenticate: `wrangler login`
3. Deploy: `npx wrangler deploy`

For production env vars, run `wrangler secret put MY_VAR` for each secret listed in `.env.example`. Public (non-secret) vars go in `wrangler.jsonc` under `vars`.

KV, D1, R2, and Durable Object bindings are configured in `wrangler.jsonc` — see https://developers.cloudflare.com/workers/wrangler/configuration/.


## Setting up Better Auth

1. Generate and set the `BETTER_AUTH_SECRET` environment variable in your `.env.local`:

   ```bash
   bunx --bun @better-auth/cli secret
   ```

2. Visit the [Better Auth documentation](https://www.better-auth.com) to unlock the full potential of authentication in your app.

### Adding a Database (Optional)

Better Auth can work in stateless mode, but to persist user data, add a database:

```typescript
// src/lib/auth.ts
import { betterAuth } from "better-auth";
import { Pool } from "pg";

export const auth = betterAuth({
  database: new Pool({
    connectionString: process.env.DATABASE_URL,
  }),
  // ... rest of config
});
```

Then run migrations:

```bash
bunx --bun @better-auth/cli migrate
```


## Shadcn

Add components using the latest version of [Shadcn](https://ui.shadcn.com/).

```bash
pnpm dlx shadcn@latest add button
```


# TanStack Chat Application

Am example chat application built with TanStack Start, TanStack Store, and Claude AI.

## .env Updates

```env
ANTHROPIC_API_KEY=your_anthropic_api_key
```

## ✨ Features

### AI Capabilities
- 🤖 Powered by Claude 3.5 Sonnet 
- 📝 Rich markdown formatting with syntax highlighting
- 🎯 Customizable system prompts for tailored AI behavior
- 🔄 Real-time message updates and streaming responses (coming soon)

### User Experience
- 🎨 Modern UI with Tailwind CSS and Lucide icons
- 🔍 Conversation management and history
- 🔐 Secure API key management
- 📋 Markdown rendering with code highlighting

### Technical Features
- 📦 Centralized state management with TanStack Store
- 🔌 Extensible architecture for multiple AI providers
- 🛠️ TypeScript for type safety

## Architecture

### Tech Stack
- **Frontend Framework**: TanStack Start
- **Routing**: TanStack Router
- **State Management**: TanStack Store
- **Styling**: Tailwind CSS
- **AI Integration**: Anthropic's Claude API


## Routing

This project uses [TanStack Router](https://tanstack.com/router) with file-based routing. Routes are managed as files in `src/routes`.

### Adding A Route

To add a new route to your application just add a new file in the `./src/routes` directory.

TanStack will automatically generate the content of the route file for you.

Now that you have two routes you can use a `Link` component to navigate between them.

### Adding Links

To use SPA (Single Page Application) navigation you will need to import the `Link` component from `@tanstack/react-router`.

```tsx
import { Link } from "@tanstack/react-router";
```

Then anywhere in your JSX you can use it like so:

```tsx
<Link to="/about">About</Link>
```

This will create a link that will navigate to the `/about` route.

More information on the `Link` component can be found in the [Link documentation](https://tanstack.com/router/v1/docs/framework/react/api/router/linkComponent).

### Using A Layout

In the File Based Routing setup the layout is located in `src/routes/__root.tsx`. Anything you add to the root route will appear in all the routes. The route content will appear in the JSX where you render `{children}` in the `shellComponent`.

Here is an example layout that includes a header:

```tsx
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'My App' },
    ],
  }),
  shellComponent: ({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <header>
          <nav>
            <Link to="/">Home</Link>
            <Link to="/about">About</Link>
          </nav>
        </header>
        {children}
        <Scripts />
      </body>
    </html>
  ),
})
```

More information on layouts can be found in the [Layouts documentation](https://tanstack.com/router/latest/docs/framework/react/guide/routing-concepts#layouts).

## Server Functions

TanStack Start provides server functions that allow you to write server-side code that seamlessly integrates with your client components.

```tsx
import { createServerFn } from '@tanstack/react-start'

const getServerTime = createServerFn({
  method: 'GET',
}).handler(async () => {
  return new Date().toISOString()
})

// Use in a component
function MyComponent() {
  const [time, setTime] = useState('')
  
  useEffect(() => {
    getServerTime().then(setTime)
  }, [])
  
  return <div>Server time: {time}</div>
}
```

## API Routes

You can create API routes by using the `server` property in your route definitions:

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'

export const Route = createFileRoute('/api/hello')({
  server: {
    handlers: {
      GET: () => json({ message: 'Hello, World!' }),
    },
  },
})
```

## Data Fetching

There are multiple ways to fetch data in your application. You can use TanStack Query to fetch data from a server. But you can also use the `loader` functionality built into TanStack Router to load the data for a route before it's rendered.

For example:

```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/people')({
  loader: async () => {
    const response = await fetch('https://swapi.dev/api/people')
    return response.json()
  },
  component: PeopleComponent,
})

function PeopleComponent() {
  const data = Route.useLoaderData()
  return (
    <ul>
      {data.results.map((person) => (
        <li key={person.name}>{person.name}</li>
      ))}
    </ul>
  )
}
```

Loaders simplify your data fetching logic dramatically. Check out more information in the [Loader documentation](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading#loader-parameters).

# Demo files

Files prefixed with `demo` can be safely deleted. They are there to provide a starting point for you to play around with the features you've installed.

# Learn More

You can learn more about all of the offerings from TanStack in the [TanStack documentation](https://tanstack.com).

For TanStack Start specific documentation, visit [TanStack Start](https://tanstack.com/start).
