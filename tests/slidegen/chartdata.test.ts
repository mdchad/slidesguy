import { describe, expect, it } from 'vitest'

import { profileColumns, runChartQuery } from '#/lib/slidegen/chartdata'

import type { DataSlice } from '#/lib/slidegen/chartdata'

const expenses: DataSlice = {
  sheet: 'expenses',
  headers: ['Month', 'Hosting', 'Marketing', 'Domains'],
  rows: [
    ['Jan', 120.5, 300, 12],
    ['Feb', 130.25, 250, 0],
    ['Mar', 99.99, 410, 24],
  ],
}

const categorized: DataSlice = {
  sheet: 'spend',
  headers: ['Category', 'Amount'],
  rows: [
    ['Tools', 50],
    ['Ads', 200],
    ['Tools', 25],
    ['Ads', 100],
  ],
}

describe('runChartQuery', () => {
  it('resolves a single-column series with labels from the label column', () => {
    const { series, violations } = runChartQuery(
      {
        labelColumn: 'Month',
        series: [{ name: 'Hosting', columns: ['Hosting'] }],
        groupBy: false,
      },
      expenses,
    )
    expect(violations).toEqual([])
    expect(series![0].labels).toEqual(['Jan', 'Feb', 'Mar'])
    expect(series![0].values).toEqual([120.5, 130.25, 99.99])
  })

  it('computes derived totals by summing multiple columns per row', () => {
    // The exact "Total Expenses" case that strict verification used to reject.
    const { series, violations } = runChartQuery(
      {
        labelColumn: 'Month',
        series: [
          { name: 'Total expenses', columns: ['Hosting', 'Marketing', 'Domains'] },
        ],
        groupBy: false,
      },
      expenses,
    )
    expect(violations).toEqual([])
    expect(series![0].values).toEqual([432.5, 380.25, 533.99])
  })

  it('aggregates repeated labels when groupBy is set', () => {
    const { series } = runChartQuery(
      {
        labelColumn: 'Category',
        series: [{ name: 'Spend', columns: ['Amount'] }],
        groupBy: true,
      },
      categorized,
    )
    expect(series![0].labels).toEqual(['Tools', 'Ads'])
    expect(series![0].values).toEqual([75, 300])
  })

  it('matches column names case-insensitively with whitespace tolerance', () => {
    const { violations } = runChartQuery(
      {
        labelColumn: ' month ',
        series: [{ name: 'H', columns: ['HOSTING'] }],
        groupBy: false,
      },
      expenses,
    )
    expect(violations).toEqual([])
  })

  it('reports unknown columns with the available headers', () => {
    const { series, violations } = runChartQuery(
      {
        labelColumn: 'Month',
        series: [{ name: 'Revenue', columns: ['Ad Revenue'] }],
        groupBy: false,
      },
      expenses,
    )
    expect(series).toBeUndefined()
    expect(violations[0]).toContain('"Ad Revenue"')
    expect(violations[0]).toContain('Hosting, Marketing, Domains')
  })

  it('flags a no-numeric-data query and names the usable columns', () => {
    const { violations } = runChartQuery(
      {
        labelColumn: 'Month',
        series: [{ name: 'M', columns: ['Month'] }], // text column
        groupBy: false,
      },
      expenses,
    )
    expect(violations[0]).toContain('no numeric data')
    expect(violations[0]).toContain('"Hosting"') // suggested numeric columns
    expect(violations[0]).toContain('"Month"') // suggested label columns
  })

  it('caps series at 50 points', () => {
    const big: DataSlice = {
      sheet: 'big',
      headers: ['id', 'v'],
      rows: Array.from({ length: 80 }, (_, i) => [`r${i}`, i]),
    }
    const { series } = runChartQuery(
      { labelColumn: 'id', series: [{ name: 'v', columns: ['v'] }], groupBy: false },
      big,
    )
    expect(series![0].values).toHaveLength(50)
    expect(series![0].labels).toHaveLength(50)
  })
})

describe('profileColumns', () => {
  it('classifies numeric, text, mixed, and empty columns', () => {
    const slice: DataSlice = {
      sheet: 's',
      headers: ['label', 'num', 'mix', 'blank'],
      rows: [
        ['a', 1, 'x', null],
        ['b', 2, 3, null],
      ],
    }
    expect(profileColumns(slice)).toEqual([
      { name: 'label', kind: 'text', filled: 2 },
      { name: 'num', kind: 'numeric', filled: 2 },
      { name: 'mix', kind: 'mixed', filled: 2 },
      { name: 'blank', kind: 'empty', filled: 0 },
    ])
  })
})
