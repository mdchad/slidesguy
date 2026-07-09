import { afterEach, describe, expect, it, vi } from 'vitest'
import { NonRetryableError } from 'cloudflare:workflows'

import { callLLM, extractJson } from '#/lib/slidegen/llm'

import type { LLMConfig } from '#/lib/slidegen/llm'

const config: LLMConfig = {
  provider: 'openai',
  apiKey: 'test-key',
  model: 'test-model',
  baseUrl: 'https://api.example.com',
}

const anthropicConfig: LLMConfig = { ...config, provider: 'anthropic' }

const openaiOk = (text: string) => ({
  choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
})

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('callLLM error taxonomy', () => {
  it('throws a plain (retryable) Error on 429 without retry guidance', async () => {
    mockFetch(429, { error: 'rate limited' })
    const err = await callLLM(config, 'hi').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(NonRetryableError)
  })

  it('waits out a short Retry-After on 429 and retries once in place', async () => {
    const responses = [
      new Response(JSON.stringify({ error: 'rate limited' }), {
        status: 429,
        headers: { 'retry-after': '0' },
      }),
      new Response(JSON.stringify(openaiOk('{"ok":true}')), { status: 200 }),
    ]
    const fetchMock = vi.fn(async () => responses.shift()!)
    vi.stubGlobal('fetch', fetchMock)

    await expect(callLLM(config, 'hi')).resolves.toBe('{"ok":true}')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('parses the wait from the OpenAI error body when no header is present', async () => {
    const responses = [
      new Response(
        JSON.stringify({ error: { message: 'Please try again in 0.1s.' } }),
        { status: 429 },
      ),
      new Response(JSON.stringify(openaiOk('{"ok":1}')), { status: 200 }),
    ]
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!))
    await expect(callLLM(config, 'hi')).resolves.toBe('{"ok":1}')
  })

  it('gives up after one in-place retry if 429 persists', async () => {
    const make429 = () =>
      new Response(JSON.stringify({ error: 'rate limited' }), {
        status: 429,
        headers: { 'retry-after': '0' },
      })
    const fetchMock = vi.fn(async () => make429())
    vi.stubGlobal('fetch', fetchMock)

    const err = await callLLM(config, 'hi').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(NonRetryableError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws a plain (retryable) Error on 500', async () => {
    mockFetch(500, { error: 'server error' })
    const err = await callLLM(config, 'hi').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(NonRetryableError)
  })

  it('throws a plain (retryable) Error on network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    const err = await callLLM(config, 'hi').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(NonRetryableError)
  })

  it('throws NonRetryableError on 400', async () => {
    mockFetch(400, { error: 'malformed' })
    const err = await callLLM(config, 'hi').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NonRetryableError)
  })

  it('throws NonRetryableError on an openai refusal', async () => {
    mockFetch(200, {
      choices: [{ message: { refusal: 'I cannot help with that' }, finish_reason: 'stop' }],
    })
    const err = await callLLM(config, 'hi').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NonRetryableError)
  })

  it('throws NonRetryableError on an openai content_filter finish', async () => {
    mockFetch(200, {
      choices: [{ message: { content: null }, finish_reason: 'content_filter' }],
    })
    const err = await callLLM(config, 'hi').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NonRetryableError)
  })

  it('returns openai message content on success', async () => {
    mockFetch(200, openaiOk('{"a":1}'))
    await expect(callLLM(config, 'hi')).resolves.toBe('{"a":1}')
  })
})

describe('callLLM anthropic provider', () => {
  it('joins text blocks on success', async () => {
    mockFetch(200, {
      content: [
        { type: 'text', text: '{"a":' },
        { type: 'text', text: '1}' },
      ],
      stop_reason: 'end_turn',
    })
    await expect(callLLM(anthropicConfig, 'hi')).resolves.toBe('{"a":1}')
  })

  it('throws NonRetryableError on a refusal stop_reason', async () => {
    mockFetch(200, { content: [], stop_reason: 'refusal' })
    const err = await callLLM(anthropicConfig, 'hi').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NonRetryableError)
  })
})

describe('extractJson', () => {
  it('strips ```json fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('strips bare ``` fences', () => {
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('passes through unfenced JSON', () => {
    expect(extractJson('  {"a":1}  ')).toBe('{"a":1}')
  })
})
