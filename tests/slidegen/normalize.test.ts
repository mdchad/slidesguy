import { describe, expect, it } from 'vitest'

import { coerceDeckPlan, coerceSlideSpec } from '#/lib/slidegen/normalize'
import { DeckPlan, SlideSpecLLM } from '#/lib/slidegen/slides'

describe('coerceDeckPlan', () => {
  it('validates after clamping oversized columns and snapping a bad layout', () => {
    // The two exact drifts observed from gpt-4o.
    const raw = {
      deckTitle: 'Sales',
      slides: [
        { intent: 'Intro', layout: 'title' },
        {
          intent: 'Detail',
          layout: 'grid-of-cards', // not in the vocabulary
          columns: Array.from({ length: 40 }, (_, i) => `col${i}`), // > 20 (old cap)
          suggestedChartType: 'donut', // synonym
        },
      ],
    }
    const parsed = DeckPlan.parse(coerceDeckPlan(raw))
    expect(parsed.slides[1].layout).toBe('title-chart') // snapped from invalid (chart hint present)
    expect(parsed.slides[1].columns).toHaveLength(40)
    expect(parsed.slides[1].suggestedChartType).toBe('doughnut')
    expect(parsed.slides.map((s) => s.index)).toEqual([0, 1])
  })

  it('drops an unrecognized suggestedChartType instead of failing', () => {
    const parsed = DeckPlan.parse(
      coerceDeckPlan({
        deckTitle: 'x',
        slides: [{ intent: 'i', layout: 'title-body', suggestedChartType: 'sunburst' }],
      }),
    )
    expect(parsed.slides[0].suggestedChartType).toBeUndefined()
  })

  it('caps the deck at 60 slides', () => {
    const parsed = DeckPlan.parse(
      coerceDeckPlan({
        deckTitle: 'big',
        slides: Array.from({ length: 90 }, () => ({ intent: 'i', layout: 'title-body' })),
      }),
    )
    expect(parsed.slides).toHaveLength(60)
  })
})

describe('coerceSlideSpec', () => {
  it('snaps a bad layout and a chart-type synonym on a query chart', () => {
    const parsed = SlideSpecLLM.parse(
      coerceSlideSpec({
        index: 2,
        layout: 'hero',
        title: 'Revenue',
        chart: {
          type: 'columns', // synonym -> column
          query: {
            labelColumn: 'Month',
            series: [{ name: 'Rev', columns: ['Revenue'] }],
          },
        },
      }),
    )
    expect(parsed.layout).toBe('title-chart')
    expect(parsed.chart?.type).toBe('column')
    expect(parsed.chart?.query.labelColumn).toBe('Month')
  })

  it('lifts a flattened query and a singular "column" field', () => {
    const parsed = SlideSpecLLM.parse(
      coerceSlideSpec({
        index: 0,
        layout: 'title-chart',
        title: 'x',
        chart: {
          type: 'bar',
          // model skipped the "query" wrapper and used "column"
          labelColumn: 'Category',
          series: [{ name: 'Spend', column: 'Amount' }],
          groupBy: true,
        },
      }),
    )
    expect(parsed.chart?.query.labelColumn).toBe('Category')
    expect(parsed.chart?.query.series[0].columns).toEqual(['Amount'])
    expect(parsed.chart?.query.groupBy).toBe(true)
  })

  it('drops a chart whose type cannot be recovered', () => {
    const parsed = SlideSpecLLM.parse(
      coerceSlideSpec({
        index: 1,
        layout: 'title-chart',
        title: 'x',
        body: ['a point'],
        chart: {
          type: 'wordcloud',
          query: { labelColumn: 'a', series: [{ name: 's', columns: ['b'] }] },
        },
      }),
    )
    expect(parsed.chart).toBeUndefined()
    // layout downgraded since the chart was dropped but body remains
    expect(parsed.layout).toBe('title-body')
  })

  it('drops a chart with no usable query', () => {
    const parsed = SlideSpecLLM.parse(
      coerceSlideSpec({
        index: 1,
        layout: 'title-chart',
        title: 'x',
        chart: { type: 'pie' }, // no query at all
      }),
    )
    expect(parsed.chart).toBeUndefined()
  })

  it('truncates over-long body to 8 bullets', () => {
    const parsed = SlideSpecLLM.parse(
      coerceSlideSpec({
        index: 0,
        layout: 'title-body',
        title: 'x',
        body: Array.from({ length: 12 }, (_, i) => `point ${i}`),
      }),
    )
    expect(parsed.body).toHaveLength(8)
  })
})
