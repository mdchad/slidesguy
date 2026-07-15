import type { ParsedSheet } from './spreadsheet'

// Deterministic statistics computed in code from the full sheet. Injected
// into BOTH generation ("cite these verbatim") and audit ("these are
// grounded") prompts: neither model can reliably sum scattered sparse cells,
// so derived numbers must come from here — the prose equivalent of computing
// chart values from queries. Min/max carry their row label and sparse
// columns list which rows they appear in, so claims that pair a value with
// a month ("lowest was November") are mechanically checkable.
export function verifiedFacts(sheet: ParsedSheet): Array<string> {
  const lines: Array<string> = []
  const totalRows = sheet.rows.length
  const labelCol = findLabelColumn(sheet)
  const rowLabel = (i: number) =>
    labelCol >= 0 ? String(sheet.rows[i][labelCol] ?? '').trim() : `row ${i + 1}`

  sheet.headers.forEach((header, col) => {
    if (col === labelCol) return
    const entries: Array<{ value: number; row: number }> = []
    sheet.rows.forEach((row, i) => {
      const n = toNumber(row[col])
      if (Number.isFinite(n)) entries.push({ value: n, row: i })
    })
    if (entries.length === 0) return

    const sum = entries.reduce((a, e) => a + e.value, 0)
    const min = entries.reduce((a, e) => (e.value < a.value ? e : a))
    const max = entries.reduce((a, e) => (e.value > a.value ? e : a))

    let presence = `present in ${entries.length} of ${totalRows} rows`
    if (entries.length < totalRows) {
      const present = entries.map((e) => rowLabel(e.row))
      const absent = sheet.rows
        .map((_, i) => i)
        .filter((i) => !entries.some((e) => e.row === i))
        .map(rowLabel)
      presence +=
        present.length <= absent.length
          ? ` (present: ${present.join(', ')})`
          : ` (absent: ${absent.join(', ')})`
    }

    lines.push(
      `"${header}": ${presence}, sum=${r2(sum)}, avg=${r2(sum / entries.length)}, min=${r2(min.value)} (${rowLabel(min.row)}), max=${r2(max.value)} (${rowLabel(max.row)})`,
    )
  })

  for (const fact of sheet.summaryFacts) {
    lines.push(`sheet-declared total: "${fact.label}" = ${fact.value}`)
  }

  return lines
}

// The row-label column: the column with the most non-numeric filled cells
// (typically months or category names).
function findLabelColumn(sheet: ParsedSheet): number {
  let best = -1
  let bestCount = 0
  sheet.headers.forEach((_, col) => {
    let count = 0
    for (const row of sheet.rows) {
      const cell = row[col]
      if (
        cell !== null &&
        String(cell).trim() !== '' &&
        !Number.isFinite(toNumber(cell))
      ) {
        count++
      }
    }
    if (count > bestCount) {
      bestCount = count
      best = col
    }
  })
  return best
}

export function verifiedFactsBlock(sheets: Array<ParsedSheet>): string {
  return sheets
    .map(
      (sheet) =>
        `sheet "${sheet.name}":\n${verifiedFacts(sheet)
          .map((line) => `  - ${line}`)
          .join('\n')}`,
    )
    .join('\n')
}

function toNumber(cell: string | number | boolean | null | undefined): number {
  if (typeof cell === 'number') return cell
  if (typeof cell === 'string') return Number(cell.replace(/[,\s]/g, ''))
  return NaN
}

function r2(n: number): number {
  return Math.round(n * 100) / 100
}
