import { describe, expect, it } from 'vitest'

import { ChartSpec, DeckPlan, SlideSpec } from '#/lib/slidegen/slides'

const validChart = {
  type: 'column',
  series: [{ name: 'Revenue', labels: ['Q1', 'Q2'], values: [100, 200] }],
}

const validSlide = {
  index: 0,
  layout: 'title-chart',
  title: 'Revenue by Quarter',
  chart: validChart,
  notes: 'Revenue grew 100% quarter over quarter.',
}

describe('SlideSpec', () => {
  it('accepts a valid chart slide', () => {
    const parsed = SlideSpec.parse(validSlide)
    expect(parsed.chart?.showLegend).toBe(true) // default applied
    expect(parsed.chart?.showValueLabels).toBe(false)
  })

  it('accepts a body-only slide without chart', () => {
    expect(
      SlideSpec.safeParse({
        index: 3,
        layout: 'title-body',
        title: 'Takeaways',
        body: ['First point', 'Second point'],
      }).success,
    ).toBe(true)
  })

  it('rejects chart types outside the closed vocabulary', () => {
    const result = SlideSpec.safeParse({
      ...validSlide,
      chart: { ...validChart, type: 'treemap' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects unknown layouts', () => {
    expect(
      SlideSpec.safeParse({ ...validSlide, layout: 'hero-image' }).success,
    ).toBe(false)
  })

  it('rejects too many bullet lines', () => {
    expect(
      SlideSpec.safeParse({
        index: 0,
        layout: 'title-body',
        title: 'Overloaded',
        body: Array.from({ length: 9 }, (_, i) => `bullet ${i}`),
      }).success,
    ).toBe(false)
  })

  it('rejects oversized series and label lists', () => {
    expect(
      ChartSpec.safeParse({
        type: 'line',
        series: Array.from({ length: 9 }, (_, i) => ({
          name: `s${i}`,
          labels: ['a'],
          values: [1],
        })),
      }).success,
    ).toBe(false)
    expect(
      ChartSpec.safeParse({
        type: 'line',
        series: [
          {
            name: 's',
            labels: Array.from({ length: 51 }, (_, i) => `l${i}`),
            values: Array.from({ length: 51 }, () => 1),
          },
        ],
      }).success,
    ).toBe(false)
  })
})

describe('DeckPlan', () => {
  it('accepts a minimal plan', () => {
    expect(
      DeckPlan.safeParse({
        deckTitle: 'Q4 Review',
        slides: [{ index: 0, intent: 'Opening title', layout: 'title' }],
      }).success,
    ).toBe(true)
  })

  it('rejects an empty slide list', () => {
    expect(
      DeckPlan.safeParse({ deckTitle: 'Empty', slides: [] }).success,
    ).toBe(false)
  })
})
