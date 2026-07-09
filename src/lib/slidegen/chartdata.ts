import type { ChartQueryT, ChartSpecT } from './slides'

export interface DataSlice {
  sheet: string
  headers: Array<string>
  rows: Array<Array<string | number | boolean | null>>
}

const MAX_POINTS = 50

export interface QueryResult {
  series?: ChartSpecT['series']
  violations: Array<string>
}

// Resolve a chart query against the slide's data slice. Values are computed
// here, from actual cells — the LLM only chose columns. Unknown columns or an
// empty result come back as violations, which feed the repair re-prompt.
export function runChartQuery(
  query: ChartQueryT,
  slice: DataSlice,
): QueryResult {
  const violations: Array<string> = []
  const available = `available columns: ${slice.headers.join(', ')}`

  const findColumn = (name: string) =>
    slice.headers.findIndex(
      (h) => h.trim().toLowerCase() === name.trim().toLowerCase(),
    )

  const labelIdx = findColumn(query.labelColumn)
  if (labelIdx < 0) {
    violations.push(
      `chart query labelColumn "${query.labelColumn}" does not exist; ${available}`,
    )
  }

  const resolvedSeries = query.series.map((s) => ({
    name: s.name,
    indexes: s.columns.map((c) => {
      const i = findColumn(c)
      if (i < 0) {
        violations.push(
          `chart query series "${s.name}" references column "${c}" which does not exist; ${available}`,
        )
      }
      return i
    }),
  }))

  if (violations.length) return { violations }

  const series = resolvedSeries.map(({ name, indexes }) => {
    const labels: Array<string> = []
    const values: Array<number> = []
    const grouped = new Map<string, number>()

    for (const row of slice.rows) {
      const label = String(row[labelIdx] ?? '').trim()
      if (!label) continue

      let sum = 0
      let hasNumber = false
      for (const i of indexes) {
        const n = toNumber(row[i])
        if (Number.isFinite(n)) {
          sum += n
          hasNumber = true
        }
      }
      if (!hasNumber) continue

      if (query.groupBy) {
        grouped.set(label, (grouped.get(label) ?? 0) + sum)
      } else {
        labels.push(label)
        values.push(sum)
      }
    }

    if (query.groupBy) {
      for (const [label, value] of grouped) {
        labels.push(label)
        values.push(value)
      }
    }

    return {
      name,
      labels: labels.slice(0, MAX_POINTS),
      values: values.slice(0, MAX_POINTS).map((v) => round2(v)),
    }
  })

  if (series.every((s) => s.values.length === 0)) {
    const profiles = profileColumns(slice)
    const numeric = profiles
      .filter((p) => p.kind === 'numeric' || p.kind === 'mixed')
      .map((p) => `"${p.name}"`)
    const textual = profiles
      .filter((p) => p.kind === 'text' || p.kind === 'mixed')
      .map((p) => `"${p.name}"`)
    return {
      violations: [
        `chart query produced no numeric data (labelColumn "${query.labelColumn}"). Use a text column for labels (${textual.join(', ') || 'none available'}) and numeric columns for series (${numeric.join(', ') || 'none available'})`,
      ],
    }
  }

  return { series, violations: [] }
}

export interface ColumnProfile {
  name: string
  kind: 'numeric' | 'text' | 'mixed' | 'empty'
  filled: number
}

// What each column actually holds, computed from the data — fed into prompts
// so the model picks label/series columns from facts instead of guessing.
export function profileColumns(slice: DataSlice): Array<ColumnProfile> {
  return slice.headers.map((name, i) => {
    let numeric = 0
    let text = 0
    for (const row of slice.rows) {
      const cell = row[i]
      if (cell === null || cell === undefined || String(cell).trim() === '') {
        continue
      }
      if (Number.isFinite(toNumber(cell))) numeric++
      else text++
    }
    const kind =
      numeric > 0 && text > 0
        ? 'mixed'
        : numeric > 0
          ? 'numeric'
          : text > 0
            ? 'text'
            : 'empty'
    return { name, kind, filled: numeric + text }
  })
}

export function describeColumns(slice: DataSlice): string {
  return profileColumns(slice)
    .map((p) => `"${p.name}": ${p.kind} (${p.filled} values)`)
    .join('; ')
}

function toNumber(cell: string | number | boolean | null | undefined): number {
  if (typeof cell === 'number') return cell
  if (typeof cell === 'string') return Number(cell.replace(/[,\s]/g, ''))
  return NaN
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
