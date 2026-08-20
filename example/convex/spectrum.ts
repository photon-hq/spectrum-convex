import { Spectrum } from "@spectrum-ts/convex";
import { components, internal } from "./_generated/api";

/**
 * One shared client for the whole app.
 *
 * `onBatch` runs once per settled burst; `sender` is the Node action that
 * actually talks to iMessage. Both are passed as function references — the
 * component turns them into function handles so it can call back into app code
 * from its own scheduled jobs.
 */
// Annotated explicitly to break a circular inference: this module builds the
// client from `internal.*`, while agent.ts and sender.ts import `spectrum`
// back. Without the annotation TypeScript reports TS7022.
export const spectrum: Spectrum = new Spectrum(components.spectrum, {
  onBatch: internal.agent.respond,
  sender: internal.sender.deliver,
  // Default: every message gets its own reply, immediately. Switch to
  // "collapse" to have a burst become a single turn instead.
  mode: "immediate",
  // Applies only *between* consecutive messages in one turn, never before the
  // first — see outbox.enqueue.
  pacingMs: 600,
});
