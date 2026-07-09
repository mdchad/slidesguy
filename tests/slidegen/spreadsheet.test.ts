import * as XLSX from 'xlsx'
import { describe, expect, it } from 'vitest'

import { parseWorkbook } from '#/lib/slidegen/spreadsheet'

function xlsxBuffer(aoa: Array<Array<string | number | null>>): ArrayBuffer {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'data')
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return buf
}

describe('parseWorkbook', () => {
  it('parses a clean sheet with headers in row 1', () => {
    const { sheets } = parseWorkbook(
      xlsxBuffer([
        ['Month', 'Cost'],
        ['Jan', 100],
        ['Feb', 200],
      ]),
    )
    expect(sheets[0].headers).toEqual(['Month', 'Cost'])
    expect(sheets[0].rows).toEqual([
      ['Jan', 100],
      ['Feb', 200],
    ])
  })

  it('skips a title row and blank rows above the real header row', () => {
    const { sheets } = parseWorkbook(
      xlsxBuffer([
        [null, null, null],
        ['Website Expenses 2026', null, null],
        [null, null, null],
        ['Month', 'Hosting', 'Marketing'],
        ['Jan', 120, 300],
        ['Feb', 130, 250],
      ]),
    )
    expect(sheets[0].headers).toEqual(['Month', 'Hosting', 'Marketing'])
    expect(sheets[0].rows).toHaveLength(2)
    expect(sheets[0].rows[0]).toEqual(['Jan', 120, 300])
  })

  it('drops fully-empty columns instead of naming them col_N', () => {
    const { sheets } = parseWorkbook(
      xlsxBuffer([
        ['Month', null, 'Cost', null],
        ['Jan', null, 100, null],
        ['Feb', null, 200, null],
      ]),
    )
    expect(sheets[0].headers).toEqual(['Month', 'Cost'])
    expect(sheets[0].rows[0]).toEqual(['Jan', 100])
  })

  it('names data-bearing headerless columns with placeholders', () => {
    const { sheets } = parseWorkbook(
      xlsxBuffer([
        ['Month', 'Cost', null],
        ['Jan', 100, 'note'],
        ['Feb', 200, null],
      ]),
    )
    expect(sheets[0].headers).toEqual(['Month', 'Cost', 'col_3'])
  })

  it('drops interior blank rows from the data', () => {
    const { sheets } = parseWorkbook(
      xlsxBuffer([
        ['Month', 'Cost'],
        ['Jan', 100],
        [null, null],
        ['Feb', 200],
      ]),
    )
    expect(sheets[0].rows).toHaveLength(2)
  })

  it('throws on a workbook with no data', () => {
    expect(() => parseWorkbook(xlsxBuffer([[null, null]]))).toThrow(
      'no data rows',
    )
  })
})
