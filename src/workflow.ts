import { WorkflowEntrypoint } from 'cloudflare:workers'

import { sendFailureAlert } from '#/lib/slidegen/alert'
import { assembleDeck } from '#/lib/slidegen/assemble'
import {
  markDone,
  markFailed,
  markProcessing,
  setTotalSlides,
} from '#/lib/slidegen/db'
import { logEvent, nonRetryable, truncateError } from '#/lib/slidegen/errors'
import { auditDeck, generatePlan, generateSlide } from '#/lib/slidegen/generate'
import { r2keys } from '#/lib/slidegen/r2keys'
import { DeckPlan, SlideSpec } from '#/lib/slidegen/slides'
import { parseWorkbook } from '#/lib/slidegen/spreadsheet'

import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers'
import type { LLMConfig } from '#/lib/slidegen/llm'
import type { DeckPlanT } from '#/lib/slidegen/slides'

export type SlidesWorkflowParams = {
  jobId: string
  userId: string
  presentationId: string
}

const BATCH_SIZE = 10

const LLM_RETRIES = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
} as const

export class SlidesWorkflow extends WorkflowEntrypoint<
  Env,
  SlidesWorkflowParams
> {
  async run(event: WorkflowEvent<SlidesWorkflowParams>, step: WorkflowStep) {
    const { jobId, userId } = event.payload
    const env = this.env
    const llm: LLMConfig = {
      provider: env.LLM_PROVIDER,
      apiKey: env.LLM_API_KEY,
      model: env.LLM_MODEL,
      baseUrl: env.LLM_BASE_URL,
    }
    const slideConcurrency = Math.max(
      1,
      Number((env as { LLM_CONCURRENCY?: string }).LLM_CONCURRENCY) || 2,
    )

    // Tracks which named step a thrown error escaped from, for D1 failed_step.
    let currentStep = 'mark-processing'

    try {
      await step.do('mark-processing', async () => {
        await markProcessing(env.DB, jobId)
      })

      currentStep = 'plan'
      const { totalSlides } = await step.do(
        'plan',
        { ...LLM_RETRIES, timeout: '2 minutes' },
        async () => {
          const source = await env.BUCKET.get(r2keys.source(jobId))
          if (!source) throw new Error(`source spreadsheet missing: ${jobId}`)
          const workbook = parseWorkbook(await source.arrayBuffer())

          const plan = await generatePlan(llm, jobId, workbook)

          const planKey = r2keys.plan(jobId)
          await env.BUCKET.put(planKey, JSON.stringify(plan))
          await setTotalSlides(env.DB, jobId, plan.slides.length)

          // Keys/counts only — step results are persisted and must stay tiny.
          return { planKey, totalSlides: plan.slides.length }
        },
      )

      for (let start = 0; start < totalSlides; start += BATCH_SIZE) {
        const end = Math.min(start + BATCH_SIZE, totalSlides) - 1
        const stepName = `slides-${pad(start)}-${pad(end)}`
        currentStep = stepName

        await step.do(
          stepName,
          { ...LLM_RETRIES, timeout: '4 minutes' },
          async () => {
            // Re-read inputs inside the step: only R2 keys may cross steps.
            const [planObj, sourceObj] = await Promise.all([
              env.BUCKET.get(r2keys.plan(jobId)),
              env.BUCKET.get(r2keys.source(jobId)),
            ])
            if (!planObj || !sourceObj) {
              throw new Error(`plan or source missing for job ${jobId}`)
            }
            const plan: DeckPlanT = DeckPlan.parse(await planObj.json())
            const workbook = parseWorkbook(await sourceObj.arrayBuffer())

            const indices = Array.from(
              { length: end - start + 1 },
              (_, i) => start + i,
            )
            const keys = await mapWithConcurrency(
              indices,
              slideConcurrency,
              async (index) => {
                try {
                  const spec = await generateSlide(
                    llm,
                    jobId,
                    plan.deckTitle,
                    plan.slides[index],
                    workbook,
                    (env as { SLIDEGEN_FAULT?: string }).SLIDEGEN_FAULT,
                  )
                  const key = r2keys.slide(jobId, index)
                  await env.BUCKET.put(key, JSON.stringify(spec))
                  return key
                } catch (err) {
                  // generate.ts logs per-LLM-attempt detail; this catches the
                  // rest (R2 errors, injected faults) so EVERY failed slide
                  // attempt is visible in logs, one line per step retry.
                  logEvent('slide_fail', {
                    jobId,
                    slideIndex: index,
                    err: truncateError(err, 500),
                  })
                  throw err
                }
              },
            )
            return keys
          },
        )
      }

      // Deck-level grounding audit: one extra LLM call reviewing all prose
      // against the source data; flagged slides get ONE repair regeneration
      // and the deck is re-audited. A deck that still fails ships nothing —
      // a failed job beats a confident hallucination.
      currentStep = 'audit'
      await step.do(
        'audit',
        { ...LLM_RETRIES, timeout: '4 minutes' },
        async () => {
          const [planObj, sourceObj] = await Promise.all([
            env.BUCKET.get(r2keys.plan(jobId)),
            env.BUCKET.get(r2keys.source(jobId)),
          ])
          if (!planObj || !sourceObj) {
            throw new Error(`plan or source missing for job ${jobId}`)
          }
          const plan = DeckPlan.parse(await planObj.json())
          const workbook = parseWorkbook(await sourceObj.arrayBuffer())

          const loadSpecs = async () => {
            const specs = []
            for (let i = 0; i < totalSlides; i++) {
              const obj = await env.BUCKET.get(r2keys.slide(jobId, i))
              if (!obj) throw new Error(`fragment missing for audit: ${i}`)
              specs.push(SlideSpec.parse(await obj.json()))
            }
            return specs
          }

          const report = await auditDeck(llm, jobId, workbook, await loadSpecs())
          if (report.violations.length === 0) return { flagged: 0 }

          const byIndex = new Map<number, Array<string>>()
          for (const v of report.violations) {
            logEvent('audit_flag', {
              jobId,
              slideIndex: v.index,
              claim: v.claim.slice(0, 200),
              reason: v.reason.slice(0, 200),
            })
            if (v.index < plan.slides.length) {
              const list = byIndex.get(v.index) ?? []
              list.push(`"${v.claim}" — ${v.reason}`)
              byIndex.set(v.index, list)
            }
          }

          for (const [index, feedback] of byIndex) {
            const spec = await generateSlide(
              llm,
              jobId,
              plan.deckTitle,
              plan.slides[index],
              workbook,
              undefined,
              feedback,
            )
            await env.BUCKET.put(
              r2keys.slide(jobId, index),
              JSON.stringify(spec),
            )
          }

          const recheck = await auditDeck(llm, jobId, workbook, await loadSpecs())
          if (recheck.violations.length > 0) {
            throw nonRetryable(
              `deck failed grounding audit after repair: ${recheck.violations
                .map((v) => `slide ${v.index}: ${v.claim}`)
                .join('; ')
                .slice(0, 600)}`,
            )
          }
          return { flagged: report.violations.length, repaired: byIndex.size }
        },
      )

      currentStep = 'assemble'
      await step.do(
        'assemble',
        { retries: { limit: 2, delay: '5 seconds', backoff: 'constant' } },
        async () => {
          try {
            return await assembleDeck(env.BUCKET, jobId, totalSlides)
          } catch (err) {
            logEvent('assemble_fail', { jobId, err: truncateError(err, 500) })
            throw err
          }
        },
      )

      currentStep = 'mark-done'
      await step.do('mark-done', async () => {
        await markDone(env.DB, jobId)
      })
    } catch (err) {
      const failedStep = currentStep
      const errorMsg = truncateError(err)
      logEvent('job_failed', { jobId, failedStep, err: errorMsg.slice(0, 500) })

      await step.do('mark-failed', async () => {
        await markFailed(env.DB, jobId, failedStep, errorMsg)
      })
      await step.do('alert', async () => {
        // sendFailureAlert never throws — an alert failure must not mask err.
        await sendFailureAlert(env.ALERT_WEBHOOK_URL, {
          jobId,
          userId,
          failedStep,
          errorMsg,
        })
      })

      // Rethrow so the workflow instance shows as errored in the dashboard.
      throw err
    }
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

// Tiny p-limit: run fn over items with at most `limit` in flight. Rejects on
// first failure (after in-flight settle), matching the all-or-nothing policy.
async function mapWithConcurrency<T, R>(
  items: Array<T>,
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<R>> {
  const results: Array<R> = new Array(items.length)
  let next = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await fn(items[i])
      }
    },
  )
  await Promise.all(workers)
  return results
}
