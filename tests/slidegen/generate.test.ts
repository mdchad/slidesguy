import { afterEach, describe, expect, it, vi } from 'vitest'

import { generateSlide } from '#/lib/slidegen/generate'

import type { LLMConfig } from '#/lib/slidegen/llm'
import type { PlanSlideT } from '#/lib/slidegen/slides'
import type { ParsedWorkbook } from '#/lib/slidegen/spreadsheet'

const config: LLMConfig = {
  provider: 'openai',
  apiKey: 'k',
  model: 'm',
  baseUrl: 'https://api.example.com',
}

const workbook = {
  sheets: [
    {
      name: 'expenses',
      headers: ['Month', 'Hosting'],
      rows: [
        ['Jan', 120],
        ['Feb', 130],
      ],
      totalRows: 2,
      summaryFacts: [],
    },
  ],
} as unknown as ParsedWorkbook

const planSlide: PlanSlideT = {
  index: 3,
  intent: 'Show hosting costs per month',
  layout: 'title-chart',
  suggestedChartType: 'column',
}

function openaiResponse(payload: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { role: 'assistant', content: JSON.stringify(payload) },
          finish_reason: 'stop',
        },
      ],
    }),
    { status: 200 },
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('generateSlide', () => {
  it('resolves the chart query into values computed from the data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        openaiResponse({
          index: 3,
          layout: 'title-chart',
          title: 'Hosting costs held steady across both months',
          chart: {
            type: 'column',
            query: {
              labelColumn: 'Month',
              series: [{ name: 'Hosting', columns: ['Hosting'] }],
              groupBy: false,
            },
          },
        }),
      ),
    )

    const spec = await generateSlide(config, 'j', 'Deck', planSlide, workbook)
    expect(spec.chart?.series[0].labels).toEqual(['Jan', 'Feb'])
    expect(spec.chart?.series[0].values).toEqual([120, 130])
    expect(spec.index).toBe(3)
  })

  it('drops an unresolvable chart after the repair attempt instead of failing', async () => {
    // Model insists (twice) on a column that does not exist.
    const badSlide = {
      index: 3,
      layout: 'title-chart',
      title: 'Ad revenue grew',
      body: ['some supporting point'],
      chart: {
        type: 'column',
        query: {
          labelColumn: 'Month',
          series: [{ name: 'Ad Revenue', columns: ['Ad Revenue'] }],
          groupBy: false,
        },
      },
    }
    const fetchMock = vi.fn(async () => openaiResponse(badSlide))
    vi.stubGlobal('fetch', fetchMock)

    const spec = await generateSlide(config, 'j', 'Deck', planSlide, workbook)
    expect(fetchMock).toHaveBeenCalledTimes(2) // initial + one repair
    expect(spec.chart).toBeUndefined()
    expect(spec.layout).toBe('title-body') // downgraded from title-chart
    expect(spec.body).toEqual(['some supporting point'])
  })
})
