import * as XLSX from 'xlsx'

export interface SummaryFact {
  label: string
  value: number
}

export interface ParsedSheet {
  name: string
  headers: Array<string>
  rows: Array<Array<string | number | boolean | null>>
  totalRows: number // pre-truncation count so the LLM knows what was elided
  // Total/Subtotal/Profit rows found inside the grid: extracted out of the
  // data (they would silently pollute charts as fake data points) and kept as
  // the sheet author's own verified aggregates for prose grounding.
  summaryFacts: Array<SummaryFact>
}

export interface ParsedWorkbook {
  sheets: Array<ParsedSheet>
}

type Cell = string | number | boolean | null
type Row = Array<Cell>

const MAX_ROWS_PER_SHEET = 200
const MAX_COLS = 30
const MAX_CELL_CHARS = 200
const MAX_HEADER_ROWS = 4

const SUMMARY_LABEL = /^(grand\s+)?(sub\s*-?\s*total.*|total.*|profit|loss|revenue|expenses?|sum|balance)$/i

// Normalize an uploaded workbook into plain JSON tables sized for prompt
// inclusion. Real-world sheets are messy — title rows, multi-row grouped
// headers (merged "Revenue"/"Expenses" bands above vendor names), total rows
// inside the data, blank rows/columns — and sloppy normalization here
// surfaces downstream as models reasoning about meaningless "col_N" columns.
export function parseWorkbook(buffer: ArrayBuffer): ParsedWorkbook {
  const wb = XLSX.read(buffer)

  const sheets = wb.SheetNames.map((name) => {
    const grid = XLSX.utils.sheet_to_json<Row>(wb.Sheets[name], {
      header: 1,
      defval: null,
    })
    return normalizeSheet(name, grid)
  }).filter((sheet): sheet is ParsedSheet => sheet !== null)

  if (sheets.length === 0) {
    throw new Error('spreadsheet contains no data rows')
  }

  return { sheets }
}

function normalizeSheet(name: string, grid: Array<Row>): ParsedSheet | null {
  // Skip leading fully-empty rows.
  let start = 0
  while (start < grid.length && isEmptyRow(grid[start])) start++
  const table = grid.slice(start)
  if (table.length === 0) return null

  // Header block: leading rows containing no numeric cells. This captures
  // stacked headers — group bands ("Revenue" / "Expenses"), the row of
  // vendor names, and nested sub-headers — since data rows contain numbers.
  // Rows with a single non-empty cell in the block are titles; discard them.
  let headerDepth = 0
  while (
    headerDepth < Math.min(MAX_HEADER_ROWS, table.length - 1) &&
    !rowHasNumber(table[headerDepth])
  ) {
    headerDepth++
  }
  // Empty rows inside the block are spacing. Leading single-cell rows are
  // sheet titles ("Expenses 2026") — but a single-cell row DEEPER in the
  // block can be a sparse sub-header, so only strip them from the top.
  const headerBlock = table
    .slice(0, headerDepth)
    .filter((row) => !isEmptyRow(row))
  while (
    headerBlock.length > 0 &&
    headerBlock[0].filter(isFilled).length <= 1
  ) {
    headerBlock.shift()
  }
  let dataRows = table.slice(headerDepth).filter((r) => !isEmptyRow(r))
  if (dataRows.length === 0) {
    dataRows = table.filter((r) => !isEmptyRow(r))
  }
  if (dataRows.length === 0) return null

  // Group bands live in merged cells: the label appears only in the anchor
  // column. Forward-fill every header row except the most specific (last)
  // one so each column inherits its band.
  const filledBlock = headerBlock.map((row, i) =>
    i < headerBlock.length - 1 ? forwardFill(row) : row,
  )

  // Keep only columns that carry a header or at least one data value —
  // phantom empty columns otherwise become "col_N" traps for chart queries.
  const width = Math.max(
    ...filledBlock.map((r) => r.length),
    ...dataRows.map((r) => r.length),
  )
  const keep: Array<number> = []
  const nameRow = headerBlock[headerBlock.length - 1] ?? []
  for (let col = 0; col < width && keep.length < MAX_COLS; col++) {
    const hasData = dataRows.some((r) => isFilled(r[col]))
    // A forward-filled band label alone doesn't justify keeping a column —
    // only real data or an explicit (unfilled) name in the most specific row.
    if (hasData || isFilled(nameRow[col])) keep.push(col)
  }
  if (keep.length === 0) return null

  // Vertical merge: "Expenses" + "Wework" => "Expenses / Wework". Dedupe
  // collisions (a band spanning unnamed columns yields repeated names).
  const seen = new Map<string, number>()
  const headers = keep.map((col, i) => {
    const parts = filledBlock
      .map((row) => (isFilled(row[col]) ? String(row[col]).trim() : null))
      .filter((p): p is string => p !== null)
    let header = dedupeParts(parts).join(' / ') || `col_${i + 1}`
    const count = seen.get(header) ?? 0
    seen.set(header, count + 1)
    if (count > 0) header = `${header} (${count + 1})`
    return header
  })

  // Pull Total/Subtotal/Profit rows out of the data.
  const summaryFacts: Array<SummaryFact> = []
  const cleanRows: Array<Row> = []
  for (const row of dataRows) {
    const facts = extractSummaryFacts(row, keep, headers)
    if (facts) summaryFacts.push(...facts)
    else cleanRows.push(row)
  }

  // Second column pass: a column whose only content was a summary-row label
  // (e.g. the cell holding the word "Profit") has nothing left to offer.
  const finalIdx = keep
    .map((col, i) => ({ col, i }))
    .filter(
      ({ col }) =>
        isFilled(nameRow[col]) || cleanRows.some((r) => isFilled(r[col])),
    )
  const finalHeaders = finalIdx.map(({ i }) => headers[i])

  const totalRows = cleanRows.length
  const rows = cleanRows.slice(0, MAX_ROWS_PER_SHEET).map((row) =>
    finalIdx.map(({ col }) => {
      const cell = row[col] ?? null
      if (typeof cell === 'string' && cell.length > MAX_CELL_CHARS) {
        return cell.slice(0, MAX_CELL_CHARS)
      }
      return cell
    }),
  )
  if (rows.length === 0 && summaryFacts.length === 0) return null

  return { name, headers: finalHeaders, rows, totalRows, summaryFacts }
}

// A summary row comes in two shapes:
//   ["Total", 44718, 2645.27, ...]        -> label in the first cell, values per column
//   [null, ..., "Sub Total Revenue", 3218.86, ...] -> inline label/value pairs
// Returns the extracted facts, or null when the row is ordinary data.
function extractSummaryFacts(
  row: Row,
  keep: Array<number>,
  headers: Array<string>,
): Array<SummaryFact> | null {
  const firstFilled = row.find(isFilled)
  const rowLabel =
    typeof firstFilled === 'string' && SUMMARY_LABEL.test(firstFilled.trim())
      ? firstFilled.trim()
      : null

  if (rowLabel) {
    const facts: Array<SummaryFact> = []
    keep.forEach((col, i) => {
      const n = toNumber(row[col])
      if (Number.isFinite(n)) {
        facts.push({ label: `${rowLabel} — ${headers[i]}`, value: n })
      }
    })
    // A single number next to "Profit"/"Subtotal" is just that figure — the
    // column it happens to sit under is positional noise.
    if (facts.length === 1) facts[0].label = rowLabel
    return facts // even if empty: still a summary row, keep it out of data
  }

  // Inline pairs: a string matching the summary pattern followed by a number
  // within the next two cells, on a row whose first cell is NOT a data label.
  const pairs: Array<SummaryFact> = []
  for (let col = 0; col < row.length; col++) {
    const cell = row[col]
    if (typeof cell !== 'string' || !SUMMARY_LABEL.test(cell.trim())) continue
    for (let j = col + 1; j <= col + 2 && j < row.length; j++) {
      const n = toNumber(row[j])
      if (Number.isFinite(n)) {
        pairs.push({ label: cell.trim(), value: n })
        break
      }
    }
  }
  if (pairs.length > 0 && typeof row[0] !== 'string') return pairs

  return null
}

function forwardFill(row: Row): Row {
  const out: Row = []
  let current: Cell = null
  for (let i = 0; i < row.length; i++) {
    if (isFilled(row[i])) current = row[i]
    out.push(current)
  }
  return out
}

function dedupeParts(parts: Array<string>): Array<string> {
  return parts.filter((p, i) => i === 0 || p !== parts[i - 1])
}

function rowHasNumber(row: Row): boolean {
  return row.some((c) => typeof c === 'number')
}

function isEmptyRow(row: Row | undefined): boolean {
  return !row || row.every((c) => !isFilled(c))
}

function isFilled(cell: Cell | undefined): boolean {
  return cell !== null && cell !== undefined && String(cell).trim() !== ''
}

function toNumber(cell: Cell | undefined): number {
  if (typeof cell === 'number') return cell
  if (typeof cell === 'string') return Number(cell.replace(/[,\s]/g, ''))
  return NaN
}
