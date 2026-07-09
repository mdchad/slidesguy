import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'

export const Route = createFileRoute('/')({ component: Home })

const USER_KEY = 'slidesguy-user-id'

// v0 auth stub: a per-browser random id sent as X-User-Id on every request so
// status/download resolve to the same owner. Replace with real auth later.
function getUserId(): string {
  let id = localStorage.getItem(USER_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(USER_KEY, id)
  }
  return id
}

type Phase = 'idle' | 'uploading' | 'processing' | 'done' | 'failed' | 'error'

interface JobStatus {
  status: string
  totalSlides: number | null
  failedStep: string | null
  errorMsg: string | null
}

const POLL_MS = 1500

function Home() {
  const [file, setFile] = useState<File | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<JobStatus | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [userId, setUserId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setUserId(getUserId())
  }, [])

  // Poll while the job is processing; stop on a terminal status.
  useEffect(() => {
    if (!jobId || phase !== 'processing') return
    let active = true
    let timer: ReturnType<typeof setTimeout>

    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, {
          headers: { 'X-User-Id': getUserId() },
        })
        if (!res.ok) throw new Error(`status check failed (${res.status})`)
        const data = (await res.json()) as JobStatus
        if (!active) return
        setJob(data)
        if (data.status === 'done') return setPhase('done')
        if (data.status === 'failed') return setPhase('failed')
        timer = setTimeout(tick, POLL_MS)
      } catch (err) {
        if (!active) return
        setPhase('error')
        setMessage(err instanceof Error ? err.message : String(err))
      }
    }

    timer = setTimeout(tick, 300)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [jobId, phase])

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!file) return
      setPhase('uploading')
      setMessage(null)
      setJob(null)
      setJobId(null)
      try {
        const form = new FormData()
        form.append('file', file)
        const res = await fetch('/api/jobs', {
          method: 'POST',
          headers: { 'X-User-Id': getUserId() },
          body: form,
        })
        const data = (await res.json()) as { jobId?: string; error?: string }
        if (!res.ok || !data.jobId) {
          throw new Error(data.error ?? `upload failed (${res.status})`)
        }
        setJobId(data.jobId)
        setPhase('processing')
      } catch (err) {
        setPhase('error')
        setMessage(err instanceof Error ? err.message : String(err))
      }
    },
    [file],
  )

  // The download route needs the X-User-Id header, so a plain <a> can't do it —
  // fetch the blob with auth, then trigger a download from the object URL.
  const download = useCallback(async () => {
    if (!jobId) return
    setDownloading(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/download`, {
        headers: { 'X-User-Id': getUserId() },
      })
      if (!res.ok) throw new Error(`download failed (${res.status})`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `presentation-${jobId}.pptx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setDownloading(false)
    }
  }, [jobId])

  const reset = () => {
    setFile(null)
    setPhase('idle')
    setJobId(null)
    setJob(null)
    setMessage(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const busy = phase === 'uploading' || phase === 'processing'

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col justify-center px-4 py-12">
      <section className="island-shell relative overflow-hidden rounded-[2rem] px-6 py-10 sm:px-10 sm:py-12">
        <div className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(79,184,178,0.32),transparent_66%)]" />
        <div className="pointer-events-none absolute -bottom-24 -right-20 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(47,106,74,0.18),transparent_66%)]" />

        <p className="island-kicker mb-3">SlidesGuy</p>
        <h1 className="mb-3 max-w-xl text-3xl font-bold leading-tight tracking-tight text-[var(--sea-ink)] sm:text-4xl">
          Turn a spreadsheet into a slide deck.
        </h1>
        <p className="mb-8 max-w-lg text-sm text-[var(--sea-ink-soft)] sm:text-base">
          Upload an <code>.xlsx</code> and an AI drafts a deck with native,
          editable charts. Generation runs in the background — you'll get a
          download when it's ready.
        </p>

        <form onSubmit={onSubmit} className="relative flex flex-col gap-4">
          <label
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition ${
              file
                ? 'border-[rgba(50,143,151,0.5)] bg-[rgba(79,184,178,0.1)]'
                : 'border-[rgba(23,58,64,0.2)] hover:border-[rgba(50,143,151,0.5)] hover:bg-[rgba(79,184,178,0.06)]'
            } ${busy ? 'pointer-events-none opacity-60' : ''}`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                // Selecting a new file clears any prior run but keeps the pick.
                setPhase('idle')
                setJob(null)
                setJobId(null)
                setMessage(null)
                setFile(e.target.files?.[0] ?? null)
              }}
            />
            <span className="text-sm font-semibold text-[var(--sea-ink)]">
              {file ? file.name : 'Choose a spreadsheet (.xlsx)'}
            </span>
            <span className="text-xs text-[var(--sea-ink-soft)]">
              {file
                ? `${(file.size / 1024).toFixed(0)} KB — click to replace`
                : 'Up to 10 MB'}
            </span>
          </label>

          <button
            type="submit"
            disabled={!file || busy}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--lagoon-deep)] px-6 py-3 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-[var(--sea-ink)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
          >
            {busy && <Spinner />}
            {phase === 'uploading'
              ? 'Uploading…'
              : phase === 'processing'
                ? 'Generating…'
                : 'Generate deck'}
          </button>
        </form>

        {(phase === 'processing' ||
          phase === 'done' ||
          phase === 'failed' ||
          phase === 'error') && (
          <div className="island-shell mt-6 rounded-2xl p-5 text-sm">
            {phase === 'processing' && (
              <p className="m-0 flex items-center gap-2 text-[var(--sea-ink-soft)]">
                <Spinner />
                {job?.status === 'processing'
                  ? `Building ${job.totalSlides ?? ''} slides…`.replace('  ', ' ')
                  : 'Queued…'}
              </p>
            )}

            {phase === 'done' && (
              <div className="flex flex-col gap-3">
                <p className="m-0 font-semibold text-[var(--palm)]">
                  ✓ Your deck is ready ({job?.totalSlides} slides).
                </p>
                <div className="flex flex-wrap gap-3">
                  <button
                    onClick={download}
                    disabled={downloading}
                    className="inline-flex items-center gap-2 rounded-full bg-[var(--palm)] px-5 py-2.5 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:opacity-50"
                  >
                    {downloading ? <Spinner /> : null}
                    Download .pptx
                  </button>
                  <button
                    onClick={reset}
                    className="rounded-full border border-[rgba(23,58,64,0.2)] bg-white/50 px-5 py-2.5 text-sm font-semibold text-[var(--sea-ink)] transition hover:-translate-y-0.5"
                  >
                    New deck
                  </button>
                </div>
              </div>
            )}

            {phase === 'failed' && (
              <div className="flex flex-col gap-3">
                <p className="m-0 font-semibold text-red-600">
                  Generation failed{job?.failedStep ? ` at “${job.failedStep}”` : ''}.
                </p>
                {job?.errorMsg && (
                  <p className="m-0 break-words font-mono text-xs text-[var(--sea-ink-soft)]">
                    {job.errorMsg}
                  </p>
                )}
                <button
                  onClick={reset}
                  className="w-fit rounded-full border border-[rgba(23,58,64,0.2)] bg-white/50 px-5 py-2.5 text-sm font-semibold text-[var(--sea-ink)] transition hover:-translate-y-0.5"
                >
                  Try again
                </button>
              </div>
            )}

            {phase === 'error' && (
              <div className="flex flex-col gap-3">
                <p className="m-0 font-semibold text-red-600">
                  {message ?? 'Something went wrong.'}
                </p>
                <button
                  onClick={reset}
                  className="w-fit rounded-full border border-[rgba(23,58,64,0.2)] bg-white/50 px-5 py-2.5 text-sm font-semibold text-[var(--sea-ink)] transition hover:-translate-y-0.5"
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        )}

        {userId && (
          <p className="mt-6 text-xs text-[var(--sea-ink-soft)]">
            session: <code>{userId.slice(0, 8)}</code>
          </p>
        )}
      </section>
    </main>
  )
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  )
}
