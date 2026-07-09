import * as XLSX from 'xlsx'

export interface ParsedSheet {
  name: string
  headers: Array<string>
  rows: Array<Array<string | number | boolean | null>>
  totalRows: number // pre-truncation count so the LLM knows what was elided
}

export interface ParsedWorkbook {
  sheets: Array<ParsedSheet>
}

type Cell = string | number | boolean | null
type Row = Array<Cell>

const MAX_ROWS_PER_SHEET = 200
const MAX_COLS = 30
const MAX_CELL_CHARS = 200
const HEADER_SCAN_ROWS = 5

// Normalize an uploaded workbook into plain JSON tables sized for prompt
// inclusion. Real-world sheets are messy — title rows above the table, blank
// leading rows, fully-empty columns — and sloppy normalization here surfaces
// downstream as the LLM querying meaningless "col_N" columns.
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

  // Header detection: among the first few rows, take the earliest one with
  // the most non-empty STRING cells (a title row like ["Expenses 2026", null,
  // null] scores 1; the real header row scores near its column count).
  let headerIdx = 0
  let bestScore = -1
  for (let i = 0; i < Math.min(HEADER_SCAN_ROWS, table.length); i++) {
    const score = table[i].filter(
      (c) => typeof c === 'string' && c.trim() !== '',
    ).length
    if (score > bestScore) {
      bestScore = score
      headerIdx = i
    }
  }

  let headerRow = table[headerIdx]
  let dataRows = table.slice(headerIdx + 1).filter((r) => !isEmptyRow(r))
  if (dataRows.length === 0) {
    // Single-row or headerless sheet: treat everything as data.
    headerRow = []
    dataRows = table.filter((r) => !isEmptyRow(r))
  }

  // Keep only columns that carry a header or at least one data value —
  // phantom empty columns otherwise become "col_N" traps for chart queries.
  const width = Math.max(headerRow.length, ...dataRows.map((r) => r.length))
  const keep: Array<number> = []
  for (let col = 0; col < width && keep.length < MAX_COLS; col++) {
    const hasHeader = isFilled(headerRow[col])
    const hasData = dataRows.some((r) => isFilled(r[col]))
    if (hasHeader || hasData) keep.push(col)
  }
  if (keep.length === 0) return null

  const headers = keep.map((col, i) =>
    isFilled(headerRow[col]) ? String(headerRow[col]).trim() : `col_${i + 1}`,
  )

  const totalRows = dataRows.length
  const rows = dataRows.slice(0, MAX_ROWS_PER_SHEET).map((row) =>
    keep.map((col) => {
      const cell = row[col] ?? null
      if (typeof cell === 'string' && cell.length > MAX_CELL_CHARS) {
        return cell.slice(0, MAX_CELL_CHARS)
      }
      return cell
    }),
  )

  return { name, headers, rows, totalRows }
}

function isEmptyRow(row: Row | undefined): boolean {
  return !row || row.every((c) => !isFilled(c))
}

function isFilled(cell: Cell | undefined): boolean {
  return cell !== null && cell !== undefined && String(cell).trim() !== ''
}
