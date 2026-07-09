import { z } from 'zod'

import { describeColumns, runChartQuery } from './chartdata'
import { logEvent, nonRetryable } from './errors'
import { callLLM, extractJson } from './llm'
import { coerceDeckPlan, coerceSlideSpec } from './normalize'
import {
  ChartType,
  DeckPlan,
  LayoutType,
  MAX_SLIDES,
  SlideSpec,
  SlideSpecLLM,
} from './slides'

import type { LLMConfig } from './llm'
import type { DeckPlanT, PlanSlideT, SlideSpecT } from './slides'
import type { ParsedWorkbook } from './spreadsheet'

const deckPlanJsonSchema = JSON.stringify(z.toJSONSchema(DeckPlan))
const slideSpecJsonSchema = JSON.stringify(z.toJSONSchema(SlideSpecLLM))

const LAYOUTS = LayoutType.options.join(', ')
const CHARTS = ChartType.options.join(', ')

interface GenerateOptions<T> {
  // Runs after schema validation; violations take the same repair path.
  semanticCheck?: (value: T) => Array<string>
  // Providers count reserved output tokens against TPM budgets, so each call
  // type declares how much output it actually needs.
  maxTokens?: number
  // Last resort when the repair attempt STILL fails only the semantic check
  // (the shape is valid, the content can't be satisfied): return a degraded
  // but usable value instead of failing, or null to fail after all.
  salvage?: (value: T) => T | null
}

// Parse + validate LLM output with ONE in-step repair re-prompt. A second
// deterministic failure is non-retryable: the model will keep producing the
// same bad shape and step retries would only burn tokens.
async function generateValidated<T>(
  config: LLMConfig,
  prompt: string,
  schema: z.ZodType<T>,
  schemaHint: string,
  coerce: (raw: unknown) => unknown,
  onAttemptFail: (attempt: number, err: unknown) => void,
  options: GenerateOptions<T> = {},
): Promise<T> {
  const { semanticCheck, maxTokens, salvage } = options

  let raw: string
  try {
    raw = await callLLM(config, prompt, { schemaHint, maxTokens })
  } catch (err) {
    onAttemptFail(1, err)
    throw err
  }

  const firstTry = tryParse(raw, schema, coerce, semanticCheck)
  if (firstTry.ok) return firstTry.value

  onAttemptFail(1, firstTry.error)

  const repairPrompt = `${prompt}\n\nYour previous response was invalid:\n${raw.slice(0, 2000)}\n\nValidation errors:\n${firstTry.error}\n\nReturn a corrected JSON object.`
  let repairedRaw: string
  try {
    repairedRaw = await callLLM(config, repairPrompt, { schemaHint, maxTokens })
  } catch (err) {
    onAttemptFail(2, err)
    throw err
  }

  const secondTry = tryParse(repairedRaw, schema, coerce, semanticCheck)
  if (secondTry.ok) return secondTry.value

  onAttemptFail(2, secondTry.error)

  if (!secondTry.ok && secondTry.schemaValidValue !== undefined && salvage) {
    const saved = salvage(secondTry.schemaValidValue)
    if (saved !== null) return saved
  }

  throw nonRetryable(
    `output failed validation after repair attempt: ${secondTry.error.slice(0, 500)}`,
  )
}

function tryParse<T>(
  raw: string,
  schema: z.ZodType<T>,
  coerce: (raw: unknown) => unknown,
  semanticCheck?: (value: T) => Array<string>,
):
  | { ok: true; value: T }
  | { ok: false; error: string; schemaValidValue?: T } {
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJson(raw))
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${String(err).slice(0, 200)}` }
  }
  // Snap benign drift (bad enums, oversized arrays, string numbers) to valid
  // values before validating, so only genuinely malformed output fails.
  try {
    parsed = coerce(parsed)
  } catch {
    // Coercion is best-effort; fall through to zod on the raw parse.
  }
  const result = schema.safeParse(parsed)
  if (!result.success) {
    return { ok: false, error: z.prettifyError(result.error).slice(0, 1500) }
  }
  const violations = semanticCheck?.(result.data) ?? []
  if (violations.length) {
    return {
      ok: false,
      error: violations.join('\n').slice(0, 1500),
      schemaValidValue: result.data,
    }
  }
  return { ok: true, value: result.data }
}

export async function generatePlan(
  config: LLMConfig,
  jobId: string,
  workbook: ParsedWorkbook,
): Promise<DeckPlanT> {
  const prompt = [
    'You are planning a slide deck from spreadsheet data.',
    `Design a deck of at most ${MAX_SLIDES} slides: an opening title slide, then slides that tell the story of the data (trends, comparisons, breakdowns), ending with a takeaways slide.`,
    'For each slide state its intent, layout, which sheet/rows/columns it draws from, and a suggested chart type where a chart helps.',
    '',
    'Constraints (follow exactly):',
    '- Each slide "intent" states the TAKEAWAY the slide must prove (an insight like "EU drove all of Q4 growth"), never a topic label like "Revenue overview".',
    '- Read the action titles in sequence during planning: together they must tell the complete story of the data on their own.',
    '- One point per slide. If an intent covers two comparisons, split it into two slides.',
    `- Each slide "layout" MUST be exactly one of: ${LAYOUTS}.`,
    `- "suggestedChartType", when present, MUST be exactly one of: ${CHARTS}.`,
    '- "columns" lists at most 60 column names.',
    `- Column profiles (computed from the data): ${workbook.sheets
      .map(
        (s) =>
          `sheet "${s.name}" — ${describeColumns({ sheet: s.name, headers: s.headers, rows: s.rows })}`,
      )
      .join(' | ')}. Only plan chart slides where numeric columns exist.`,
    '',
    'GROUNDING (critical):',
    '- The spreadsheet below is the ONLY source of truth. Use no outside knowledge about businesses, websites, or industries.',
    `- The available data is exactly: ${describeWorkbook(workbook)}. Plan slides about nothing else.`,
    '- Never plan a slide about a metric, category, or concept whose name does not appear in the data (for example: do not invent revenue streams, subscriptions, or advertising if those words are not in the spreadsheet).',
    '- The closing takeaways slide may only restate findings that earlier slides support with this data.',
    '',
    'Spreadsheet data (rows shown may be truncated; totalRows is the real count, and rowRange may reference any row up to it):',
    JSON.stringify(truncateWorkbookRows(workbook, 80)),
  ].join('\n')

  const plan = await generateValidated(
    config,
    prompt,
    DeckPlan,
    deckPlanJsonSchema,
    coerceDeckPlan,
    (attempt, err) =>
      logEvent('plan_fail', {
        jobId,
        attempt,
        err: String(err).slice(0, 500),
      }),
  )

  if (plan.slides.length > MAX_SLIDES) {
    throw nonRetryable(`deck too large: ${plan.slides.length} slides`)
  }

  // Plan order is authoritative; normalize indices to position.
  plan.slides = plan.slides.map((slide, i) => ({ ...slide, index: i }))
  return plan
}

export async function generateSlide(
  config: LLMConfig,
  jobId: string,
  deckTitle: string,
  planSlide: PlanSlideT,
  workbook: ParsedWorkbook,
  faultFlag?: string,
  groundingFeedback?: Array<string>,
): Promise<SlideSpecT> {
  maybeInjectFault(faultFlag, jobId, planSlide.index)

  const slice = sliceDataForSlide(workbook, planSlide)
  const prompt = [
    `You are generating one slide of the deck "${deckTitle}".`,
    `Slide intent: ${planSlide.intent}`,
    `Required layout: ${planSlide.layout}`,
    planSlide.suggestedChartType
      ? `Suggested chart type: ${planSlide.suggestedChartType}`
      : '',
    `The slide's "index" field must be ${planSlide.index}.`,
    'Layouts containing "chart" must include a chart built from the data below; layouts without "chart" must omit the chart field.',
    'Keep bullet lines short and factual. Add concise speaker notes.',
    '',
    'Constraints (follow exactly):',
    '- "title" MUST be an action title: one complete sentence stating the takeaway with a number where possible (e.g. "Revenue grew 23% in Q4, driven by EU"). Never a topic label ("Results", "Overview"). Maximum ~12 words.',
    '- "body": at most 5 bullets, each ONE fact in telegraphic style (drop articles and filler; e.g. "EU revenue +41% YoY"), at most 12 words per bullet, under 40 words total.',
    '- The body must not restate the title; it adds supporting evidence or context.',
    `- "layout" MUST be exactly one of: ${LAYOUTS}.`,
    `- If a chart is present, "chart.type" MUST be exactly one of: ${CHARTS}.`,
    '- You NEVER write chart numbers. A chart is a QUERY the system runs against the spreadsheet: "chart.query" = {"labelColumn": <column whose values become the category labels>, "series": [{"name": <short legend name>, "columns": [<one or more numeric columns, summed together per row>]}], "groupBy": <true to aggregate rows that share a label>}.',
    '- Query examples: monthly total from several expense columns => {"labelColumn":"Month","series":[{"name":"Total expenses","columns":["Hosting","Marketing","Domains"]}],"groupBy":false}. Spend per category when rows repeat categories => {"labelColumn":"Category","series":[{"name":"Spend","columns":["Amount"]}],"groupBy":true}.',
    '- Every column name in the query MUST be copied exactly from the data headers below.',
    `- Column profile (computed from the data): ${describeColumns(slice)}. Pick "labelColumn" from text/mixed columns and series "columns" from numeric/mixed columns; never use empty columns.`,
    '',
    'GROUNDING (critical):',
    '- The data below is the ONLY source of truth. Use no outside knowledge.',
    '- Chart values are computed by the system from your query — never write them yourself.',
    '- Every claim in title, body, and notes must be verifiable from the data. Never mention metrics, categories, or concepts that do not appear in it.',
    ...(groundingFeedback?.length
      ? [
          '',
          'A previous version of this slide FAILED a grounding audit for the following violations. Do not repeat them:',
          ...groundingFeedback.map((v) => `- ${v}`),
        ]
      : []),
    '',
    'Relevant data (rows shown may be truncated; your chart query runs against ALL rows, so pick columns from the headers):',
    JSON.stringify({
      ...slice,
      rows: slice.rows.slice(0, 60),
      totalRows: slice.rows.length,
    }),
  ]
    .filter(Boolean)
    .join('\n')

  const llmSpec = await generateValidated(
    config,
    prompt,
    SlideSpecLLM,
    slideSpecJsonSchema,
    coerceSlideSpec,
    (attempt, err) =>
      logEvent('slide_fail', {
        jobId,
        slideIndex: planSlide.index,
        attempt,
        err: String(err).slice(0, 500),
      }),
    {
      // Unresolvable chart queries (unknown columns, no numeric data) take
      // the repair path with the specific problem quoted back.
      semanticCheck: (candidate) =>
        candidate.chart
          ? runChartQuery(candidate.chart.query, slice).violations
          : [],
      maxTokens: 2500, // slide JSON is small; don't reserve 4k against TPM
      // A chart that still can't be built after repair is a capability
      // failure, not hallucination — ship the slide as grounded text rather
      // than failing the whole deck.
      salvage: (candidate) => {
        if (!candidate.chart) return null
        logEvent('slide_chart_dropped', {
          jobId,
          slideIndex: planSlide.index,
          reason: 'chart query unresolvable after repair',
        })
        return {
          ...candidate,
          chart: undefined,
          layout: candidate.layout.includes('chart')
            ? 'title-body'
            : candidate.layout,
        }
      },
    },
  )

  // Resolve the chart query into literal series — values come from actual
  // cells, so the stored fragment is grounded by construction.
  const spec: SlideSpecT = SlideSpec.parse({
    ...llmSpec,
    // The plan's position is authoritative regardless of what the model echoed.
    index: planSlide.index,
    chart: llmSpec.chart
      ? {
          type: llmSpec.chart.type,
          title: llmSpec.chart.title,
          showLegend: llmSpec.chart.showLegend,
          showValueLabels: llmSpec.chart.showValueLabels,
          series: runChartQuery(llmSpec.chart.query, slice).series,
        }
      : undefined,
  })
  return spec
}

// One extra LLM call per deck: an auditor that sees every slide's prose plus
// the source data and flags claims the data cannot support. Charts are
// already verified deterministically, so the auditor focuses on text.
export const AuditReport = z.object({
  violations: z
    .array(
      z.object({
        index: z.number().int().min(0),
        claim: z.string().max(300),
        reason: z.string().max(300),
      }),
    )
    .max(60),
})
export type AuditReportT = z.infer<typeof AuditReport>
const auditJsonSchema = JSON.stringify(z.toJSONSchema(AuditReport))

export async function auditDeck(
  config: LLMConfig,
  jobId: string,
  workbook: ParsedWorkbook,
  specs: Array<SlideSpecT>,
): Promise<AuditReportT> {
  const slidesForAudit = specs.map((s) => ({
    index: s.index,
    title: s.title,
    body: s.body,
    notes: s.notes,
    chartSeries: s.chart?.series.map((series) => series.name),
  }))

  const prompt = [
    'You are auditing a generated slide deck for hallucination against its source spreadsheet.',
    'Flag ONLY clear violations: claims, metrics, categories, or concepts that do not appear in the data and cannot be derived from it.',
    'Do NOT flag: restatements of data that is present, arithmetic derived from the data (totals, differences, percentages, averages), reasonable descriptive language, or stylistic choices.',
    `Each violation needs the slide "index", the offending "claim" (quoted), and a short "reason". Return {"violations": []} if the deck is fully grounded.`,
    '',
    'Source data (rows shown may be truncated; judge concepts/categories by the headers and sample):',
    JSON.stringify(truncateWorkbookRows(workbook, 40)),
    '',
    'Slides:',
    JSON.stringify(slidesForAudit),
  ].join('\n')

  return generateValidated(
    config,
    prompt,
    AuditReport,
    auditJsonSchema,
    (raw) => raw,
    (attempt, err) =>
      logEvent('audit_fail', {
        jobId,
        attempt,
        err: String(err).slice(0, 500),
      }),
    // Violations list is tiny; a big output reservation just burns TPM budget.
    { maxTokens: 1500 },
  )
}

// Keep prompts inside provider TPM budgets: headers and a row sample carry
// the signal; the full data never needs to ride along in every request.
function truncateWorkbookRows(workbook: ParsedWorkbook, maxRows: number) {
  return {
    sheets: workbook.sheets.map((s) => ({
      ...s,
      rows: s.rows.slice(0, maxRows),
    })),
  }
}

function describeWorkbook(workbook: ParsedWorkbook): string {
  return workbook.sheets
    .map((s) => `sheet "${s.name}" with columns [${s.headers.join(', ')}]`)
    .join('; ')
}

function sliceDataForSlide(workbook: ParsedWorkbook, planSlide: PlanSlideT) {
  const sheet =
    workbook.sheets.find((s) => s.name === planSlide.sheet) ??
    workbook.sheets[0]
  const rows = planSlide.rowRange
    ? sheet.rows.slice(planSlide.rowRange.start, planSlide.rowRange.end + 1)
    : sheet.rows
  return { sheet: sheet.name, headers: sheet.headers, rows }
}

// Test-only fault injection (acceptance criteria 4 & 5). Controlled by the
// SLIDEGEN_FAULT var: 'transient-twice:<idx>' fails that slide's first two
// step attempts with a retryable error; 'nonretryable:<idx>' always throws a
// NonRetryableError for that slide. In-memory attempt counting is fine for
// local dev, which is the only place this flag is ever set.
const faultAttempts = new Map<string, number>()

function maybeInjectFault(
  faultFlag: string | undefined,
  jobId: string,
  slideIndex: number,
): void {
  if (!faultFlag) return
  const [mode, idxRaw] = faultFlag.split(':')
  if (Number(idxRaw) !== slideIndex) return

  if (mode === 'nonretryable') {
    throw nonRetryable(`injected non-retryable fault on slide ${slideIndex}`)
  }
  if (mode === 'transient-twice') {
    const key = `${jobId}:${slideIndex}`
    const attempt = (faultAttempts.get(key) ?? 0) + 1
    faultAttempts.set(key, attempt)
    if (attempt <= 2) {
      throw new Error(
        `injected transient fault on slide ${slideIndex} (attempt ${attempt})`,
      )
    }
  }
}
