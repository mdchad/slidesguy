import { describe, expect, it } from 'vitest'

import { verifiedFacts } from '#/lib/slidegen/facts'

import type { ParsedSheet } from '#/lib/slidegen/spreadsheet'

const sheet: ParsedSheet = {
  name: '2025',
  headers: ['Month', 'Claude'],
  rows: [
    ['Jan', 29.05],
    ['Feb', 29.05],
    ['Mar', null],
    ['Apr', 29.05],
  ],
  totalRows: 4,
  summaryFacts: [{ label: 'Profit', value: 17385.54 }],
}

describe('verifiedFacts', () => {
  it('computes presence, sum, avg, min, max per numeric column', () => {
    const lines = verifiedFacts(sheet)
    const claude = lines.find((l) => l.startsWith('"Claude"'))
    expect(claude).toContain('present in 3 of 4 rows')
    expect(claude).toContain('sum=87.15')
    expect(claude).toContain('avg=29.05')
  })

  it('includes sheet-declared totals', () => {
    expect(verifiedFacts(sheet)).toContain(
      'sheet-declared total: "Profit" = 17385.54',
    )
  })

  it('skips non-numeric columns', () => {
    expect(
      verifiedFacts(sheet).some((l) => l.startsWith('"Month"')),
    ).toBe(false)
  })
})

describe('verifiedFacts attribution', () => {
  it('labels min/max with the row label and lists presence for sparse columns', () => {
    const lines = verifiedFacts({
      name: 's',
      headers: ['Month', 'Revenue', 'Apple'],
      rows: [
        ['Jan', 4400, null],
        ['Feb', 4250, null],
        ['Mar', 5654, 144.98],
      ],
      totalRows: 3,
      summaryFacts: [],
    })
    const revenue = lines.find((l) => l.startsWith('"Revenue"'))
    expect(revenue).toContain('min=4250 (Feb)')
    expect(revenue).toContain('max=5654 (Mar)')
    const apple = lines.find((l) => l.startsWith('"Apple"'))
    expect(apple).toContain('present in 1 of 3 rows (present: Mar)')
  })
})
