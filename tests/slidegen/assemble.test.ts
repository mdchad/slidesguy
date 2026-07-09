import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { NonRetryableError } from 'cloudflare:workflows'

import { assembleDeck } from '#/lib/slidegen/assemble'
import { r2keys } from '#/lib/slidegen/r2keys'

import type { SlideSpecT } from '#/lib/slidegen/slides'

// Minimal in-memory stand-in for the R2Bucket surface assembleDeck touches.
class FakeBucket {
  store = new Map<string, ArrayBuffer | string>()

  async list({ prefix }: { prefix: string }) {
    return {
      objects: [...this.store.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
    }
  }

  async get(key: string) {
    const value = this.store.get(key)
    if (value === undefined) return null
    return {
      json: async () => JSON.parse(value as string),
      arrayBuffer: async () => value as ArrayBuffer,
    }
  }

  async put(key: string, value: ArrayBuffer | string) {
    this.store.set(key, value)
  }
}

function fragment(index: number, withChart: boolean): SlideSpecT {
  return {
    index,
    layout: withChart ? 'title-chart' : 'title-body',
    title: `Slide ${index}`,
    ...(withChart
      ? {
          chart: {
            type: index % 2 === 0 ? 'column' : 'pie',
            series: [
              { name: 'Metric', labels: ['A', 'B', 'C'], values: [1, 2, 3] },
            ],
            showLegend: true,
            showValueLabels: false,
          },
        }
      : { body: ['point one', 'point two'] }),
    notes: `Notes for slide ${index}`,
  }
}

async function seedFragments(
  bucket: FakeBucket,
  jobId: string,
  count: number,
) {
  for (let i = 0; i < count; i++) {
    await bucket.put(
      r2keys.slide(jobId, i),
      JSON.stringify(fragment(i, i % 2 === 1)),
    )
  }
}

describe('assembleDeck', () => {
  it('produces a valid pptx with native chart XML and ordered slides', async () => {
    const bucket = new FakeBucket()
    await seedFragments(bucket, 'job1', 4)

    const finalKey = await assembleDeck(
      bucket as unknown as R2Bucket,
      'job1',
      4,
    )
    expect(finalKey).toBe('jobs/job1/final.pptx')

    const buffer = bucket.store.get(finalKey) as ArrayBuffer
    const zip = await JSZip.loadAsync(buffer)
    const paths = Object.keys(zip.files)

    // 4 slides in index order, native OOXML charts (not images), notes kept.
    expect(paths.filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))).toHaveLength(4)
    const chartXmls = paths.filter((p) => /^ppt\/charts\/chart\d+\.xml$/.test(p))
    expect(chartXmls).toHaveLength(2) // slides 1 and 3 carry charts
    // pptxgenjs always emits an empty ppt/media/ folder entry; what matters
    // is that no media FILES exist (charts are OOXML, not rasterized images).
    expect(
      paths.some((p) => p.startsWith('ppt/media/') && !zip.files[p].dir),
    ).toBe(false)
    expect(
      paths.filter((p) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p)),
    ).toHaveLength(4)

    const chart1 = await zip.files[chartXmls[0]].async('string')
    expect(chart1).toContain('<c:chartSpace')

    const slide1 = await zip.files['ppt/slides/slide1.xml'].async('string')
    expect(slide1).toContain('Slide 0')
    const slide4 = await zip.files['ppt/slides/slide4.xml'].async('string')
    expect(slide4).toContain('Slide 3')
  })

  it('maps bar to horizontal and column to vertical barDir', async () => {
    const bucket = new FakeBucket()
    const withType = (index: number, type: 'bar' | 'column'): SlideSpecT => ({
      ...fragment(index, true),
      chart: { ...fragment(index, true).chart!, type },
    })
    await bucket.put(r2keys.slide('job2', 0), JSON.stringify(withType(0, 'bar')))
    await bucket.put(r2keys.slide('job2', 1), JSON.stringify(withType(1, 'column')))

    await assembleDeck(bucket as unknown as R2Bucket, 'job2', 2)
    const zip = await JSZip.loadAsync(
      bucket.store.get(r2keys.final('job2')) as ArrayBuffer,
    )
    // Chart file numbering uses a pptxgenjs-global counter, so discover the
    // paths instead of hardcoding chart1/chart2.
    const chartPaths = Object.keys(zip.files)
      .filter((p) => /^ppt\/charts\/chart\d+\.xml$/.test(p))
      .sort()
    expect(chartPaths).toHaveLength(2)
    const chart1 = await zip.files[chartPaths[0]].async('string')
    const chart2 = await zip.files[chartPaths[1]].async('string')
    expect(chart1).toContain('<c:barDir val="bar"')
    expect(chart2).toContain('<c:barDir val="col"')
  })

  it('fails non-retryably on fragment count mismatch', async () => {
    const bucket = new FakeBucket()
    await seedFragments(bucket, 'job3', 3)

    const err = await assembleDeck(
      bucket as unknown as R2Bucket,
      'job3',
      5,
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NonRetryableError)
    expect(String(err)).toContain('found 3, expected 5')
  })

  it('fails non-retryably on a corrupt fragment', async () => {
    const bucket = new FakeBucket()
    await seedFragments(bucket, 'job4', 2)
    await bucket.put(
      r2keys.slide('job4', 1),
      JSON.stringify({ nonsense: true }),
    )

    const err = await assembleDeck(
      bucket as unknown as R2Bucket,
      'job4',
      2,
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NonRetryableError)
    expect(String(err)).toContain('corrupt fragment')
  })
})
