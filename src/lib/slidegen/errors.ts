import { NonRetryableError } from 'cloudflare:workflows'

export { NonRetryableError }

// Deterministic failures (bad request, refusal, invalid output after repair)
// must not be retried by Workflows — retrying them burns LLM spend for nothing.
export function nonRetryable(message: string): NonRetryableError {
  return new NonRetryableError(message)
}

export function truncateError(err: unknown, max = 1000): string {
  return String(err instanceof Error ? err.message : err).slice(0, max)
}

export function logEvent(
  evt: string,
  fields: Record<string, string | number | undefined>,
): void {
  console.error(JSON.stringify({ evt, ...fields }))
}
