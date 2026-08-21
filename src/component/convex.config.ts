import { defineComponent } from "convex/server";

/**
 * The Spectrum component.
 *
 * Owns the durable inbound pipeline (dedupe → batch queue → debounced flush →
 * cancellation/carry-forward) and the outbox that drives deduped, paced sends.
 * Install it from the app's `convex/convex.config.ts`:
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
 * The component itself declares no environment variables. Every secret is read
 * by app-owned code, from the *app's* deployment environment — set these in the
 * app's Convex dashboard, not the component's:
 *
 * - `SPECTRUM_WEBHOOK_SECRET` — verified in the webhook handler that
 *   `Spectrum.registerRoutes` mounts on the app's `httpRouter`. A component's
 *   HTTP actions cannot read app env vars, which is why the route lives there.
 * - `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET` — read by
 *   `createCloudSender` (`@spectrum-ts/convex/sender`) inside the app's Node
 *   action, since only the Node runtime can speak gRPC.
 *
 * Reading them from the environment rather than accepting them as function
 * arguments keeps a secret out of scheduled-function payloads and log lines.
 */
const component = defineComponent("spectrum");

export default component;
