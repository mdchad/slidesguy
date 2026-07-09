/**
 * Generates .xlsx fixtures for acceptance testing (run: bun scripts/make-fixtures.ts).
 * The sheet name (e.g. "slides25") tells the mock LLM how many slides to plan.
 */
import * as XLSX from 'xlsx'
import { mkdirSync, writeFileSync } from 'node:fs'

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

function makeFixture(sheetName: string): XLSX.WorkBook {
  const rows = [
    ['Month', 'Revenue', 'Cost', 'Region'],
    ...MONTHS.map((m, i) => [m, 1000 + i * 137, 400 + i * 61, i % 2 ? 'EU' : 'US']),
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName)
  return wb
}

mkdirSync('tests/fixtures', { recursive: true })
for (const name of ['slides5', 'slides8', 'slides25', 'slides60allchart']) {
  // XLSX.writeFile can't detect fs under Bun; write the buffer ourselves.
  const buf = XLSX.write(makeFixture(name), {
    type: 'buffer',
    bookType: 'xlsx',
  }) as Buffer
  writeFileSync(`tests/fixtures/${name}.xlsx`, buf)
  console.log(`wrote tests/fixtures/${name}.xlsx`)
}
