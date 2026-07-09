// SlidesGuy deck theme — single source of truth for deck visuals. Mirrors the
// web app's "sea" palette (src/styles.css). All colors are pptx hex (no #).

export const THEME = {
  font: 'Arial', // single face; hierarchy comes from size/weight only

  colors: {
    bg: 'F7FAF8', // soft off-white content background
    titleBg: '173A40', // deep teal title-slide background
    ink: '173A40', // titles, strong text
    inkSoft: '3F5F64', // body text
    muted: '6B8A85', // footers, page numbers
    accent: '4FB8B2', // lagoon — rules, highlights
    accentDeep: '328F97',
    rule: 'D8E5DE', // hairline dividers
    onDark: 'FFFFFF',
    onDarkSoft: 'BFE0DA',
  },

  // Series colors for charts, in order of assignment.
  chartColors: [
    '328F97', // lagoon deep
    '2F6A4A', // palm
    '4FB8B2', // lagoon
    '173A40', // sea ink
    '7DA8E6', // sky
    'C98A2D', // amber
    '8A5FA8', // plum
    '6B8A85', // muted
  ],

  sizes: {
    deckTitle: 34,
    deckTitleMin: 24,
    title: 24,
    titleMin: 16,
    body: 15,
    bodyMin: 10,
    chartLabel: 10,
    footer: 9,
  },

  margin: 0.5, // inches from slide edge
} as const
