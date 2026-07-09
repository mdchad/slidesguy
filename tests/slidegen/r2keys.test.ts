import { describe, expect, it } from 'vitest'

import { r2keys } from '#/lib/slidegen/r2keys'

describe('r2keys', () => {
  it('builds the documented key scheme', () => {
    expect(r2keys.source('j1')).toBe('jobs/j1/source.xlsx')
    expect(r2keys.plan('j1')).toBe('jobs/j1/plan.json')
    expect(r2keys.slide('j1', 0)).toBe('jobs/j1/slides/slide-00.json')
    expect(r2keys.final('j1')).toBe('jobs/j1/final.pptx')
    expect(r2keys.slidesPrefix('j1')).toBe('jobs/j1/slides/')
  })

  it('zero-pads indices so lexicographic sort equals index order', () => {
    const keys = [12, 3, 0, 45].map((i) => r2keys.slide('j', i))
    expect([...keys].sort()).toEqual([
      'jobs/j/slides/slide-00.json',
      'jobs/j/slides/slide-03.json',
      'jobs/j/slides/slide-12.json',
      'jobs/j/slides/slide-45.json',
    ])
  })
})
