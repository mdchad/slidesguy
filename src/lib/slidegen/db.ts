export type JobStatus = 'queued' | 'processing' | 'done' | 'failed'

export interface JobRow {
  job_id: string
  presentation_id: string
  user_id: string
  total_slides: number | null
  status: JobStatus
  failed_step: string | null
  error_msg: string | null
  created_at: number
  finished_at: number | null
}

export async function insertJob(
  db: D1Database,
  job: Pick<JobRow, 'job_id' | 'presentation_id' | 'user_id'>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO jobs (job_id, presentation_id, user_id, status, created_at)
       VALUES (?, ?, ?, 'queued', ?)`,
    )
    .bind(job.job_id, job.presentation_id, job.user_id, Date.now())
    .run()
}

export async function markProcessing(
  db: D1Database,
  jobId: string,
): Promise<void> {
  await db
    .prepare(`UPDATE jobs SET status = 'processing' WHERE job_id = ?`)
    .bind(jobId)
    .run()
}

export async function setTotalSlides(
  db: D1Database,
  jobId: string,
  totalSlides: number,
): Promise<void> {
  await db
    .prepare(`UPDATE jobs SET total_slides = ? WHERE job_id = ?`)
    .bind(totalSlides, jobId)
    .run()
}

export async function markDone(db: D1Database, jobId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE jobs SET status = 'done', finished_at = ? WHERE job_id = ?`,
    )
    .bind(Date.now(), jobId)
    .run()
}

export async function markFailed(
  db: D1Database,
  jobId: string,
  failedStep: string,
  errorMsg: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE jobs
       SET status = 'failed', failed_step = ?, error_msg = ?, finished_at = ?
       WHERE job_id = ?`,
    )
    .bind(failedStep, errorMsg.slice(0, 1000), Date.now(), jobId)
    .run()
}

export async function getJobForUser(
  db: D1Database,
  jobId: string,
  userId: string,
): Promise<JobRow | null> {
  return db
    .prepare(`SELECT * FROM jobs WHERE job_id = ? AND user_id = ?`)
    .bind(jobId, userId)
    .first<JobRow>()
}
