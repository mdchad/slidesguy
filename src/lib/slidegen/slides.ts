import { z } from 'zod'

// Closed chart vocabulary: only types pptxgenjs renders natively. The LLM
// must not invent types. 'bar' and 'column' both map to pptxgenjs ChartType.bar
// (barDir 'bar' vs 'col') at assembly time.
export const ChartType = z.enum([
  'bar',
  'column',
  'line',
  'area',
  'pie',
  'doughnut',
  'scatter',
  'radar',
])

export const ChartSpec = z.object({
  type: ChartType,
  title: z.string().max(120).optional(),
  series: z
    .array(
      z.object({
        name: z.string(),
        labels: z.array(z.string()).max(50),
        values: z.array(z.number()).max(50),
      }),
    )
    .min(1)
    .max(8),
  showLegend: z.boolean().default(true),
  showValueLabels: z.boolean().default(false),
})

// Closed layout vocabulary: each maps to a hardcoded positioning table in
// assemble.ts. The LLM must not invent layouts.
export const LayoutType = z.enum([
  'title',
  'title-body',
  'title-chart',
  'title-body-chart',
  'two-column',
])

export const SlideSpec = z.object({
  index: z.number().int().min(0),
  layout: LayoutType,
  title: z.string().max(200),
  body: z.array(z.string().max(500)).max(8).optional(), // bullet lines
  chart: ChartSpec.optional(),
  notes: z.string().max(1000).optional(), // speaker notes
})

export type SlideSpecT = z.infer<typeof SlideSpec>
export type ChartSpecT = z.infer<typeof ChartSpec>

// What the LLM returns for a chart: a QUERY over the spreadsheet, never
// literal numbers. The system resolves it against the data slice, so chart
// values are grounded by construction — the model cannot fabricate them.
export const ChartQuery = z.object({
  labelColumn: z.string(), // column supplying category labels
  series: z
    .array(
      z.object({
        name: z.string().max(80),
        // One or more numeric columns, summed together per row (enables
        // derived series like "Total expenses" = Hosting + Marketing + ...).
        columns: z.array(z.string()).min(1).max(20),
      }),
    )
    .min(1)
    .max(8),
  // true => aggregate rows sharing a label (e.g. spend per category).
  groupBy: z.boolean().default(false),
})
export type ChartQueryT = z.infer<typeof ChartQuery>

export const ChartSpecLLM = z.object({
  type: ChartType,
  title: z.string().max(120).optional(),
  query: ChartQuery,
  showLegend: z.boolean().default(true),
  showValueLabels: z.boolean().default(false),
})

export const SlideSpecLLM = SlideSpec.omit({ chart: true }).extend({
  chart: ChartSpecLLM.optional(),
})
export type SlideSpecLLMT = z.infer<typeof SlideSpecLLM>

// Plan step output: one entry per slide describing what the slide should
// cover and which parsed data it draws from. Kept small — the per-slide
// generation prompt embeds one of these plus the relevant data slice.
export const PlanSlide = z.object({
  index: z.number().int().min(0),
  intent: z.string().max(500), // what this slide should communicate
  layout: LayoutType,
  suggestedChartType: ChartType.optional(),
  sheet: z.string().optional(), // source sheet name
  rowRange: z
    .object({ start: z.number().int().min(0), end: z.number().int().min(0) })
    .optional(),
  columns: z.array(z.string()).max(60).optional(),
})

export const DeckPlan = z.object({
  deckTitle: z.string().max(200),
  slides: z.array(PlanSlide).min(1),
})

export type DeckPlanT = z.infer<typeof DeckPlan>
export type PlanSlideT = z.infer<typeof PlanSlide>

export const MAX_SLIDES = 60
