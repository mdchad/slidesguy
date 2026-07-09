// Single source of truth for R2 key construction. Slide ordering is always
// derived from the zero-padded index in the key, never from delivery order.

const pad = (index: number) => String(index).padStart(2, '0')

export const r2keys = {
  source: (jobId: string) => `jobs/${jobId}/source.xlsx`,
  plan: (jobId: string) => `jobs/${jobId}/plan.json`,
  slidesPrefix: (jobId: string) => `jobs/${jobId}/slides/`,
  slide: (jobId: string, index: number) =>
    `jobs/${jobId}/slides/slide-${pad(index)}.json`,
  final: (jobId: string) => `jobs/${jobId}/final.pptx`,
}
