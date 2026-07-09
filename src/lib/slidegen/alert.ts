import { logEvent } from './errors'

export interface FailureAlert {
  jobId: string
  userId: string
  failedStep: string
  errorMsg: string
}

// Fire-and-forget failure webhook. Must never throw: an alert failure must
// not mask the original workflow error. No-op when the secret is unset.
export async function sendFailureAlert(
  webhookUrl: string | undefined,
  alert: FailureAlert,
): Promise<void> {
  if (!webhookUrl) return
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...alert, dashboardHint: alert.jobId }),
    })
    if (!res.ok) {
      logEvent('alert_fail', { jobId: alert.jobId, status: res.status })
    }
  } catch (err) {
    logEvent('alert_fail', {
      jobId: alert.jobId,
      err: String(err).slice(0, 500),
    })
  }
}
