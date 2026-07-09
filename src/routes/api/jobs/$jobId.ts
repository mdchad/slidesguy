import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getJobForUser } from '#/lib/slidegen/db'
import { getUserId } from './index'

export const Route = createFileRoute('/api/jobs/$jobId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const userId = getUserId(request)
        if (!userId) {
          return Response.json({ error: 'missing X-User-Id header' }, { status: 400 })
        }

        const job = await getJobForUser(env.DB, params.jobId, userId)
        if (!job) {
          return Response.json({ error: 'not found' }, { status: 404 })
        }

        return Response.json({
          jobId: job.job_id,
          presentationId: job.presentation_id,
          status: job.status,
          totalSlides: job.total_slides,
          failedStep: job.failed_step,
          errorMsg: job.error_msg,
          createdAt: job.created_at,
          finishedAt: job.finished_at,
        })
      },
    },
  },
})
