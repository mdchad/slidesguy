import path from 'node:path'
import { defineConfig } from 'vitest/config'

// Standalone test config: keeps the Cloudflare/TanStack vite plugins out of
// the unit-test pipeline and stubs the workerd-only `cloudflare:workflows`
// module so slidegen modules load under Node.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: 'cloudflare:workflows',
        replacement: path.resolve(
          import.meta.dirname,
          'tests/stubs/cloudflare-workflows.ts',
        ),
      },
      {
        find: /^#\//,
        replacement: `${path.resolve(import.meta.dirname, 'src')}/`,
      },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
