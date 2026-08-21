# Changelog

## 0.1.0

Initial release.

- Durable inbound pipeline: at-least-once dedupe, a debounced batch queue, and
  chain cancellation with carry-forward.
- Outbox with deterministic client GUIDs, pacing, and retry/backoff.
- `Spectrum` client: `registerRoutes` for the webhook, `onBatch` for turns, and
  a pluggable `sender` so the gRPC transport stays in the app's Node runtime.
- `@spectrum-ts/convex/test` exports `register()` for apps testing against the
  component with `convex-test`.
