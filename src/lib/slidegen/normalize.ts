import { ChartType, LayoutType, MAX_SLIDES } from './slides'

// Best-effort normalization of raw LLM JSON before zod validation. LLMs drift
// off a closed vocabulary (invalid enums, oversized arrays, numbers-as-strings)
// even with schema hints; snapping those to valid values turns benign drift
// into a usable deck instead of a hard failure. Anything genuinely malformed
// still falls through to zod and the repair path.

const LAYOUTS = new Set<string>(LayoutType.options)
const CHARTS = new Set<string>(ChartType.options)

const CHART_SYNONYMS: Record<string, string> = {
  donut: 'doughnut',
  columns: 'column',
  col: 'column',
  bars: 'bar',
  barchart: 'bar',
  horizontalbar: 'bar',
  verticalbar: 'column',
  scatterplot: 'scatter',
  bubble: 'scatter',
  linechart: 'line',
  piechart: 'pie',
  areachart: 'area',
}

const MAX_TITLE = 200
const MAX_LINE = 500
const MAX_NOTES = 1000
const MAX_BODY = 8
const MAX_SERIES = 8

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown, max: number): string {
  return String(v ?? '').slice(0, max)
}

function coerceChartType(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const k = v.trim().toLowerCase()
  if (CHARTS.has(k)) return k
  const syn = CHART_SYNONYMS[k]
  return syn && CHARTS.has(syn) ? syn : undefined
}

// Pick a layout that actually matches the slide's content, so a dropped chart
// never leaves a chart-layout with no chart (or vice versa). The model's valid
// choice is preserved only where it's compatible (title, two-column).
function reconcileLayout(v: unknown, hasChart: boolean, hasBody: boolean): string {
  const base = typeof v === 'string' && LAYOUTS.has(v) ? v : undefined
  if (hasChart) return hasBody ? 'title-body-chart' : 'title-chart'
  if (base === 'title') return 'title'
  if (base === 'two-column' && hasBody) return 'two-column'
  return 'title-body'
}

export function coerceDeckPlan(raw: unknown): unknown {
  if (!isObj(raw)) return raw
  const slides = Array.isArray(raw.slides) ? raw.slides : []
  return {
    ...raw,
    deckTitle: str(raw.deckTitle ?? 'Untitled deck', MAX_TITLE),
    slides: slides.slice(0, MAX_SLIDES).map((s, i) => {
      if (!isObj(s)) return s
      const suggested = coerceChartType(s.suggestedChartType)
      const out: Record<string, unknown> = {
        ...s,
        index: i,
        intent: str(s.intent ?? '', MAX_LINE),
        layout: reconcileLayout(s.layout, Boolean(suggested), false),
      }
      if (suggested) out.suggestedChartType = suggested
      else delete out.suggestedChartType
      if (Array.isArray(s.columns)) {
        out.columns = s.columns.slice(0, 60).map((c) => String(c))
      }
      return out
    }),
  }
}

export function coerceSlideSpec(raw: unknown): unknown {
  if (!isObj(raw)) return raw

  // Charts arrive as a QUERY (labelColumn + columns to sum), never literal
  // numbers. Salvage the common drifts: type synonyms, query fields emitted
  // at the chart level instead of under "query", a single "column" string
  // instead of a "columns" array. An unsalvageable chart is dropped and the
  // layout reconciled, rather than failing the slide.
  let chart: Record<string, unknown> | undefined
  if (isObj(raw.chart)) {
    const type = coerceChartType(raw.chart.type)
    const queryRaw = isObj(raw.chart.query)
      ? raw.chart.query
      : typeof raw.chart.labelColumn === 'string'
        ? raw.chart // model flattened the query into the chart object
        : undefined
    if (type && queryRaw && typeof queryRaw.labelColumn === 'string') {
      const rawSeries = Array.isArray(queryRaw.series) ? queryRaw.series : []
      const series = rawSeries
        .slice(0, MAX_SERIES)
        .filter(isObj)
        .map((s) => {
          const columns = (
            Array.isArray(s.columns)
              ? s.columns
              : typeof s.column === 'string'
                ? [s.column]
                : []
          )
            .slice(0, 20)
            .map((c) => String(c))
          return { name: str(s.name ?? 'Series', 80), columns }
        })
        .filter((s) => s.columns.length > 0)
      if (series.length > 0) {
        chart = {
          type,
          title: raw.chart.title,
          showLegend: raw.chart.showLegend,
          showValueLabels: raw.chart.showValueLabels,
          query: {
            labelColumn: String(queryRaw.labelColumn),
            series,
            groupBy: Boolean(queryRaw.groupBy),
          },
        }
      }
    }
  }

  const body = Array.isArray(raw.body)
    ? raw.body.slice(0, MAX_BODY).map((b) => str(b, MAX_LINE))
    : undefined

  const out: Record<string, unknown> = {
    ...raw,
    title: str(raw.title ?? '', MAX_TITLE),
    layout: reconcileLayout(raw.layout, Boolean(chart), Boolean(body?.length)),
  }
  if (chart) out.chart = chart
  else delete out.chart
  if (body) out.body = body
  if (raw.notes !== undefined) out.notes = str(raw.notes, MAX_NOTES)
  return out
}
