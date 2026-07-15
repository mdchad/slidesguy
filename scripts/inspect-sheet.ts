/**
 * Diagnostic: dump what the pipeline actually sees for a given .xlsx.
 * Usage: bun scripts/inspect-sheet.ts <path-to-xlsx>
 */
import { readFileSync } from 'node:fs'
import * as XLSX from 'xlsx'

import { parseWorkbook } from '../src/lib/slidegen/spreadsheet'
import { describeColumns, profileColumns } from '../src/lib/slidegen/chartdata'

const path = process.argv[2]
if (!path) throw new Error('usage: bun scripts/inspect-sheet.ts <file.xlsx>')

const buf = readFileSync(path)
const arrayBuffer = buf.buffer.slice(
  buf.byteOffset,
  buf.byteOffset + buf.byteLength,
)

// ---- 1. Raw structure ----
const wb = XLSX.read(arrayBuffer)
console.log('=== RAW WORKBOOK ===')
for (const name of wb.SheetNames) {
  const grid = XLSX.utils.sheet_to_json<Array<unknown>>(wb.Sheets[name], {
    header: 1,
    defval: null,
  })
  const width = Math.max(0, ...grid.map((r) => r.length))
  console.log(`\nsheet "${name}": ${grid.length} rows x ${width} cols`)
  console.log('first 8 raw rows:')
  for (const row of grid.slice(0, 8)) {
    console.log(
      '  ' +
        JSON.stringify(row.map((c) => (typeof c === 'string' ? c.slice(0, 24) : c))).slice(0, 300),
    )
  }
}

// ---- 2. What parseWorkbook produces ----
console.log('\n=== PARSED (what the pipeline sees) ===')
const parsed = parseWorkbook(arrayBuffer)
for (const sheet of parsed.sheets) {
  console.log(`\nsheet "${sheet.name}": ${sheet.rows.length} rows kept (totalRows=${sheet.totalRows})`)
  console.log(`headers (${sheet.headers.length}): ${JSON.stringify(sheet.headers)}`)
  console.log('profiles:', describeColumns({ sheet: sheet.name, headers: sheet.headers, rows: sheet.rows }))
  console.log('first 5 parsed rows:')
  for (const row of sheet.rows.slice(0, 5)) {
    console.log('  ' + JSON.stringify(row).slice(0, 300))
  }
  console.log('last 3 parsed rows:')
  for (const row of sheet.rows.slice(-3)) {
    console.log('  ' + JSON.stringify(row).slice(0, 300))
  }
  // sparsity: % empty cells per sheet
  let filled = 0
  let total = 0
  for (const row of sheet.rows) {
    for (const cell of row) {
      total++
      if (cell !== null && String(cell).trim() !== '') filled++
    }
  }
  console.log(`fill rate: ${((filled / total) * 100).toFixed(0)}% of cells non-empty`)
}

// ---- 3. Token estimates for each prompt type ----
console.log('\n=== TOKEN ESTIMATES (chars/4) ===')
const est = (s: string) => Math.round(s.length / 4)
const trunc = (maxRows: number) => ({
  sheets: parsed.sheets.map((s) => ({ ...s, rows: s.rows.slice(0, maxRows) })),
})
console.log('plan prompt data (80 rows/sheet):', est(JSON.stringify(trunc(80))), 'tokens')
console.log('audit prompt data (40 rows/sheet):', est(JSON.stringify(trunc(40))), 'tokens')
console.log('full workbook as JSON:', est(JSON.stringify(parsed)), 'tokens')
const firstSheet = parsed.sheets[0]
console.log(
  'slide slice (60 rows, sheet 1):',
  est(
    JSON.stringify({
      sheet: firstSheet.name,
      headers: firstSheet.headers,
      rows: firstSheet.rows.slice(0, 60),
    }),
  ),
  'tokens',
)
// CSV comparison
const toCsv = (rows: Array<Array<unknown>>) =>
  rows.map((r) => r.map((c) => String(c ?? '')).join(',')).join('\n')
console.log(
  'full workbook as CSV:',
  est(parsed.sheets.map((s) => `${s.name}\n${s.headers.join(',')}\n${toCsv(s.rows)}`).join('\n\n')),
  'tokens',
)

// column stats sketch
console.log('\n=== COLUMN PROFILE OBJECTS (sheet 1) ===')
console.log(
  profileColumns({
    sheet: firstSheet.name,
    headers: firstSheet.headers,
    rows: firstSheet.rows,
  }),
)

console.log('\n=== SUMMARY FACTS (extracted from Total/Profit rows) ===')
for (const sheet of parsed.sheets) {
  console.log(`sheet "${sheet.name}":`)
  for (const f of sheet.summaryFacts) console.log(`  ${f.label} = ${f.value}`)
}
