import { nonRetryable } from './errors'

export type LLMProvider = 'openai' | 'anthropic'

export interface LLMConfig {
  provider: LLMProvider
  apiKey: string
  model: string
  baseUrl: string // host root, e.g. https://api.openai.com — path is added per provider
}

export interface CallLLMOptions {
  schemaHint?: string
  maxTokens?: number
  timeoutMs?: number
}

interface ProviderRequest {
  url: string
  headers: Record<string, string>
  body: string
}

// Error taxonomy (drives retry cost — see spec §8):
// - 429 / 5xx / network / timeout -> normal Error (Workflows retries the step)
// - 400 / content refusal -> NonRetryableError (deterministic; retry burns money)
// One nuance for 429: when the provider says exactly how long to wait
// (Retry-After header or "try again in Xs" body) and it's short, wait that
// long and retry in place ONCE. The workflow's 10s+ exponential ladder is too
// coarse for TPM windows that clear in seconds, and each of its retries
// re-runs the whole step.
export async function callLLM(
  config: LLMConfig,
  prompt: string,
  options: CallLLMOptions = {},
): Promise<string> {
  const { schemaHint, maxTokens = 4096, timeoutMs = 90_000 } = options

  const fullPrompt = schemaHint
    ? `${prompt}\n\nRespond with ONLY a JSON object matching this JSON Schema (no prose, no markdown fences):\n${schemaHint}`
    : prompt

  const req =
    config.provider === 'anthropic'
      ? anthropicRequest(config, fullPrompt, maxTokens)
      : openaiRequest(config, fullPrompt, maxTokens, Boolean(schemaHint))

  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: req.body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      // Network failure or timeout: transient, let Workflows retry.
      throw new Error(`llm network error: ${String(err).slice(0, 300)}`)
    }

    if (res.ok) {
      const data = await res.json()
      return config.provider === 'anthropic'
        ? parseAnthropic(data)
        : parseOpenAI(data)
    }

    const body = (await res.text().catch(() => '')).slice(0, 500)
    if (res.status === 400) {
      throw nonRetryable(`llm rejected request (400): ${body}`)
    }
    if (res.status === 429 && attempt === 0) {
      const waitSeconds = parseRetryAfter(res, body)
      if (waitSeconds !== null && waitSeconds <= 20) {
        await sleep((waitSeconds + 0.5) * 1000)
        continue
      }
    }
    throw new Error(`llm http ${res.status}: ${body}`)
  }
}

function parseRetryAfter(res: Response, body: string): number | null {
  const header = Number(res.headers.get('retry-after'))
  if (Number.isFinite(header) && header >= 0) return header
  const match = /try again in ([\d.]+)\s*s/i.exec(body)
  if (match) return Number(match[1])
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function openaiRequest(
  config: LLMConfig,
  prompt: string,
  maxTokens: number,
  jsonMode: boolean,
): ProviderRequest {
  return {
    url: `${config.baseUrl}/v1/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      max_completion_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
      // json_object mode guarantees syntactically valid JSON (prompt already
      // says "JSON", which the mode requires). zod still validates the shape.
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  }
}

function parseOpenAI(data: unknown): string {
  const d = data as {
    choices?: Array<{
      message?: { content?: string | null; refusal?: string | null }
      finish_reason?: string
    }>
  }
  const choice = d.choices?.[0]
  if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') {
    throw nonRetryable('llm refused to generate content')
  }
  const text = choice?.message?.content
  if (!text) {
    throw nonRetryable('llm returned no text content')
  }
  return text
}

function anthropicRequest(
  config: LLMConfig,
  prompt: string,
  maxTokens: number,
): ProviderRequest {
  return {
    url: `${config.baseUrl}/v1/messages`,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  }
}

function parseAnthropic(data: unknown): string {
  const d = data as {
    content?: Array<{ type: string; text?: string }>
    stop_reason?: string
  }
  if (d.stop_reason === 'refusal') {
    throw nonRetryable('llm refused to generate content')
  }
  const text = (d.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
  if (!text) {
    throw nonRetryable('llm returned no text content')
  }
  return text
}

// LLMs wrap JSON in ```json fences despite instructions; strip before parsing.
export function extractJson(raw: string): string {
  const trimmed = raw.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  return fenced ? fenced[1] : trimmed
}
