import { defineComponent } from "convex/server";

/**
 * The Spectrum component.
 *
 * Owns the durable inbound pipeline (dedupe → batch queue → debounced flush →
 * cancellation/carry-forward) and the outbox that drives idempotent, paced
 * sends. Install it from the app's `convex/convex.config.ts`:
 *
 * ```ts
 * import { defineApp } from "convex/server";
 * import spectrum from "@spectrum-ts/convex/convex.config";
 *
 * const app = defineApp();
 * app.use(spectrum);
 * export default app;
 * ```
 *
 * Spectrum Cloud credentials are read from the component's own environment
 * (`SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET`) rather than passed as
 * function arguments, so a secret never lands in a scheduled-function payload
 * or a log line.
 */
const component = defineComponent("spectrum");

export default component;
