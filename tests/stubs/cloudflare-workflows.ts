// Node-side stand-in for the workerd-only `cloudflare:workflows` module.
// Mirrors the runtime class closely enough for unit tests: a distinguishable
// Error subclass.
export class NonRetryableError extends Error {
  constructor(message: string, name = 'NonRetryableError') {
    super(message)
    this.name = name
  }
}
