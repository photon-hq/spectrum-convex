# @spectrum-ts/convex

## 0.1.1

### Patch Changes

- [`2940310`](https://github.com/photon-hq/spectrum-convex/commit/29403108cfefcc4f126be93450521a101a99e40b) Thanks [@qwerzl](https://github.com/qwerzl)! - Front Photon rather than Spectrum in the package description and README prose.
  Photon is the company; Spectrum is the framework it builds. Product names
  (`Spectrum Cloud`), the `SPECTRUM_*` environment variables, and every API
  identifier are unchanged.

## 0.1.0

Initial release.

- Durable inbound pipeline: at-least-once dedupe, a debounced batch queue, and
  chain cancellation with carry-forward.
- Outbox with deterministic client guids, pacing, and retry/backoff.
- `Spectrum` client: `registerRoutes` for the webhook, `onBatch` for turns, and
  a pluggable `sender` so the gRPC transport stays in the app's Node runtime.
- `@spectrum-ts/convex/test` exports `register()` for apps testing against the
  component with `convex-test`.
