import PptxGenJS from 'pptxgenjs'

import { nonRetryable } from './errors'
import { r2keys } from './r2keys'
import { SlideSpec } from './slides'
import { THEME } from './theme'

import type { ChartSpecT, SlideSpecT } from './slides'

type Box = { x: number; y: number; w: number; h: number }

const MASTER = 'SLIDESGUY_CONTENT'

// 16:9 canvas is 10 x 5.625in. Titles sit in a fixed band with a hairline
// rule under them; content fills the band below. No theming system beyond
// theme.ts — positioning is deliberately hardcoded per layout.
const TITLE_BOX: Box = { x: 0.5, y: 0.32, w: 9, h: 1.0 }
const RULE_Y = 1.38

const LAYOUTS: Record<
  Exclude<SlideSpecT['layout'], 'title'>,
  { body?: Box; body2?: Box; chart?: Box }
> = {
  'title-body': {
    body: { x: 0.5, y: 1.58, w: 9, h: 3.55 },
  },
  'title-chart': {
    chart: { x: 0.5, y: 1.52, w: 9, h: 3.65 },
  },
  // Evidence first, interpretation second: figure left, bullets right.
  'title-body-chart': {
    chart: { x: 0.5, y: 1.52, w: 5.5, h: 3.65 },
    body: { x: 6.2, y: 1.58, w: 3.3, h: 3.55 },
  },
  'two-column': {
    body: { x: 0.5, y: 1.58, w: 4.35, h: 3.55 },
    body2: { x: 5.15, y: 1.58, w: 4.35, h: 3.55 },
  },
}

const CHART_TYPE_MAP: Record<
  ChartSpecT['type'],
  { type: keyof typeof PptxGenJS.ChartType; barDir?: 'bar' | 'col' }
> = {
  bar: { type: 'bar', barDir: 'bar' }, // horizontal bars
  column: { type: 'bar', barDir: 'col' }, // vertical columns
  line: { type: 'line' },
  area: { type: 'area' },
  pie: { type: 'pie' },
  doughnut: { type: 'doughnut' },
  scatter: { type: 'scatter' },
  radar: { type: 'radar' },
}

export async function assembleDeck(
  bucket: R2Bucket,
  jobId: string,
  totalSlides: number,
): Promise<string> {
  const prefix = r2keys.slidesPrefix(jobId)
  const listing = await bucket.list({ prefix, limit: 1000 })
  const keys = listing.objects.map((o) => o.key).sort() // zero-padded => index order

  if (keys.length !== totalSlides) {
    throw nonRetryable(
      `fragment count mismatch: found ${keys.length}, expected ${totalSlides}`,
    )
  }

  const specs: Array<SlideSpecT> = []
  for (const key of keys) {
    const obj = await bucket.get(key)
    if (!obj) throw nonRetryable(`fragment disappeared during assemble: ${key}`)
    const parsed = SlideSpec.safeParse(await obj.json())
    if (!parsed.success) {
      throw nonRetryable(`corrupt fragment ${key}: ${parsed.error.message}`)
    }
    specs.push(parsed.data)
  }

  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'
  pptx.defineSlideMaster({
    title: MASTER,
    background: { color: THEME.colors.bg },
    slideNumber: {
      x: 9.15,
      y: 5.3,
      w: 0.5,
      h: 0.25,
      fontFace: THEME.font,
      fontSize: THEME.sizes.footer,
      color: THEME.colors.muted,
      align: 'right',
    },
  })

  for (const spec of specs) {
    if (spec.layout === 'title') addTitleSlide(pptx, spec)
    else addContentSlide(pptx, spec)
  }

  const buffer = (await pptx.write({
    outputType: 'arraybuffer',
  })) as ArrayBuffer
  const finalKey = r2keys.final(jobId)
  await bucket.put(finalKey, buffer, {
    httpMetadata: {
      contentType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    },
  })
  return finalKey
}

function addTitleSlide(pptx: PptxGenJS, spec: SlideSpecT): void {
  const slide = pptx.addSlide()
  slide.background = { color: THEME.colors.titleBg }

  const titleBox: Box = { x: 0.7, y: 1.55, w: 8.6, h: 1.9 }
  slide.addText(spec.title, {
    ...titleBox,
    fontFace: THEME.font,
    fontSize: fitFontSize(
      [spec.title],
      titleBox,
      THEME.sizes.deckTitle,
      THEME.sizes.deckTitleMin,
    ),
    color: THEME.colors.onDark,
    bold: true,
    align: 'left',
    valign: 'top',
  })

  slide.addShape('rect', {
    x: 0.72,
    y: 3.62,
    w: 1.6,
    h: 0.045,
    fill: { color: THEME.colors.accent },
    line: { type: 'none' },
  })

  if (spec.body?.length) {
    slide.addText(spec.body.join('   ·   '), {
      x: 0.7,
      y: 3.82,
      w: 8.6,
      h: 1.0,
      fontFace: THEME.font,
      fontSize: 14,
      color: THEME.colors.onDarkSoft,
      align: 'left',
      valign: 'top',
    })
  }

  if (spec.notes) slide.addNotes(spec.notes)
}

function addContentSlide(pptx: PptxGenJS, spec: SlideSpecT): void {
  const slide = pptx.addSlide({ masterName: MASTER })
  const layout = LAYOUTS[spec.layout as Exclude<SlideSpecT['layout'], 'title'>]

  slide.addText(spec.title, {
    ...TITLE_BOX,
    fontFace: THEME.font,
    fontSize: fitFontSize(
      [spec.title],
      TITLE_BOX,
      THEME.sizes.title,
      THEME.sizes.titleMin,
    ),
    color: THEME.colors.ink,
    bold: true,
    align: 'left',
    valign: 'top',
  })
  slide.addShape('rect', {
    x: 0.5,
    y: RULE_Y,
    w: 9,
    h: 0.018,
    fill: { color: THEME.colors.rule },
    line: { type: 'none' },
  })

  if (spec.body?.length) {
    if (spec.layout === 'two-column' && layout.body2) {
      const mid = Math.ceil(spec.body.length / 2)
      addBullets(slide, spec.body.slice(0, mid), layout.body!)
      addBullets(slide, spec.body.slice(mid), layout.body2)
    } else if (layout.body) {
      addBullets(slide, spec.body, layout.body)
    }
  }

  if (spec.chart && layout.chart) {
    addChart(pptx, slide, spec.chart, layout.chart)
  }

  if (spec.notes) slide.addNotes(spec.notes)
}

function addBullets(
  slide: PptxGenJS.Slide,
  lines: Array<string>,
  box: Box,
): void {
  const fontSize = fitFontSize(lines, box, THEME.sizes.body, THEME.sizes.bodyMin)
  slide.addText(
    lines.map((line) => ({
      text: line,
      options: {
        bullet: { characterCode: '2022', indent: 12 },
        breakLine: true,
        paraSpaceAfter: Math.round(fontSize * 0.55),
      },
    })),
    {
      ...box,
      fontFace: THEME.font,
      fontSize,
      color: THEME.colors.inkSoft,
      align: 'left',
      valign: 'top',
    },
  )
}

function addChart(
  pptx: PptxGenJS,
  slide: PptxGenJS.Slide,
  chart: ChartSpecT,
  box: Box,
): void {
  const mapped = CHART_TYPE_MAP[chart.type]
  const isPieish = chart.type === 'pie' || chart.type === 'doughnut'

  slide.addChart(
    pptx.ChartType[mapped.type] as PptxGenJS.CHART_NAME,
    chart.series.map((s) => ({
      name: s.name,
      labels: s.labels,
      values: s.values,
    })),
    {
      ...box,
      ...(mapped.barDir ? { barDir: mapped.barDir } : {}),
      chartColors: [...THEME.chartColors],
      showLegend: chart.showLegend,
      legendPos: 'b',
      legendFontSize: THEME.sizes.chartLabel,
      legendColor: THEME.colors.inkSoft,
      legendFontFace: THEME.font,
      showValue: chart.showValueLabels,
      dataLabelFontSize: 9,
      dataLabelColor: THEME.colors.inkSoft,
      dataLabelFontFace: THEME.font,
      ...(chart.title
        ? {
            title: chart.title,
            showTitle: true,
            titleFontSize: 12,
            titleColor: THEME.colors.ink,
            titleFontFace: THEME.font,
          }
        : {}),
      // Axis/gridline options are ignored by pie/doughnut renderers.
      ...(isPieish
        ? {
            dataBorder: { pt: 1.5, color: THEME.colors.bg },
            ...(chart.type === 'doughnut' ? { holeSize: 60 } : {}),
          }
        : {
            catAxisLabelFontSize: THEME.sizes.chartLabel,
            catAxisLabelColor: THEME.colors.inkSoft,
            catAxisLabelFontFace: THEME.font,
            catAxisLineColor: THEME.colors.rule,
            valAxisLabelFontSize: THEME.sizes.chartLabel,
            valAxisLabelColor: THEME.colors.inkSoft,
            valAxisLabelFontFace: THEME.font,
            valAxisLineShow: false,
            valGridLine: { style: 'solid', size: 0.5, color: 'DFEAE4' },
            catGridLine: { style: 'none' },
          }),
    },
  )
}

// Overflow guard: pick the largest font size (stepping down to `min`) at
// which the text plausibly fits its box, using a conservative width estimate.
// Slides render deterministically here, so cut-off text is preventable —
// this is the fix for the classic "AI slide content gets clipped" failure.
const AVG_CHAR_WIDTH = 0.52 // fraction of font size, roomy for Arial
const LINE_HEIGHT = 1.35 // includes paragraph spacing

function fitFontSize(
  lines: Array<string>,
  box: Box,
  base: number,
  min: number,
): number {
  for (let size = base; size > min; size -= 1) {
    const charsPerLine = Math.max(
      6,
      Math.floor((box.w * 72) / (size * AVG_CHAR_WIDTH)),
    )
    const wrapped = lines.reduce(
      (n, text) => n + Math.max(1, Math.ceil(text.length / charsPerLine)),
      0,
    )
    if (wrapped * ((size * LINE_HEIGHT) / 72) <= box.h) return size
  }
  return min
}
