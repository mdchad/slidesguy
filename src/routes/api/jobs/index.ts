import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { insertJob, markFailed } from '#/lib/slidegen/db'
import { r2keys } from '#/lib/slidegen/r2keys'

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

// TODO(auth): replace the X-User-Id header stub with real session auth
// (better-auth is already wired at /api/auth) before exposing publicly.
export function getUserId(request: Request): string | null {
  return request.headers.get('X-User-Id')
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export const Route = createFileRoute('/api/jobs/')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const userId = getUserId(request)
        if (!userId) return json({ error: 'missing X-User-Id header' }, 400)

        let form: FormData
        try {
          form = await request.formData()
        } catch {
          return json({ error: 'expected multipart form data' }, 400)
        }

        const file = form.get('file')
        if (!(file instanceof File) || !file.name.toLowerCase().endsWith('.xlsx')) {
          return json({ error: 'file must be an .xlsx upload' }, 400)
        }
        if (file.size === 0 || file.size > MAX_UPLOAD_BYTES) {
          return json({ error: 'file must be non-empty and at most 10 MB' }, 400)
        }

        const presentationIdRaw = form.get('presentation_id')
        const presentationId =
          typeof presentationIdRaw === 'string' && presentationIdRaw
            ? presentationIdRaw
            : crypto.randomUUID()

        // job_id is normally server-generated; accepting an explicit one keeps
        // the duplicate-create path (409) testable end-to-end.
        const jobIdRaw = form.get('job_id')
        const jobId =
          typeof jobIdRaw === 'string' && jobIdRaw
            ? jobIdRaw
            : crypto.randomUUID()

        // Order matters: R2 put -> D1 insert -> workflow create.
        await env.BUCKET.put(r2keys.source(jobId), await file.arrayBuffer())

        try {
          await insertJob(env.DB, {
            job_id: jobId,
            presentation_id: presentationId,
            user_id: userId,
          })
        } catch (err) {
          if (String(err).includes('UNIQUE constraint failed')) {
            return json({ error: `job ${jobId} already exists` }, 409)
          }
          throw err
        }

        try {
          await env.SLIDES_WORKFLOW.create({
            id: jobId,
            params: { jobId, userId, presentationId },
          })
        } catch (err) {
          // Instance id = jobId gives free dedup: duplicate create must 409.
          // Workflows exposes no error code for this, so match on the message.
          if (/already exists|instance.*exists|duplicate/i.test(String(err))) {
            return json({ error: `job ${jobId} already exists` }, 409)
          }
          await markFailed(
            env.DB,
            jobId,
            'create',
            `workflow create failed: ${String(err).slice(0, 500)}`,
          )
          return json({ error: 'failed to start generation' }, 500)
        }

        return json({ jobId }, 202)
      },
    },
  },
})
