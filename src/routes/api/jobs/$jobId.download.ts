import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getJobForUser } from '#/lib/slidegen/db'
import { r2keys } from '#/lib/slidegen/r2keys'
import { getUserId } from './index'

export const Route = createFileRoute('/api/jobs/$jobId/download')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const userId = getUserId(request)
        if (!userId) {
          return Response.json({ error: 'missing X-User-Id header' }, { status: 400 })
        }

        const job = await getJobForUser(env.DB, params.jobId, userId)
        if (!job || job.status !== 'done') {
          return Response.json({ error: 'not found' }, { status: 404 })
        }

        const object = await env.BUCKET.get(r2keys.final(job.job_id))
        if (!object) {
          return Response.json({ error: 'not found' }, { status: 404 })
        }

        // Stream through the Worker; presigned URLs are deliberately not used.
        return new Response(object.body, {
          headers: {
            'Content-Type':
              'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'Content-Disposition': `attachment; filename="presentation-${job.presentation_id}.pptx"`,
            'Content-Length': String(object.size),
          },
        })
      },
    },
  },
})
