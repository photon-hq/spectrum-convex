import { v } from "convex/values";
import { internalMutation } from "./_generated/server.js";

/**
 * Sender-facing surface.
 *
 * The component deliberately does NOT contain the gRPC client. iMessage sends
 * speak gRPC over HTTP/2, which only Convex's Node runtime can do, and a
 * `"use node"` file cannot host queries or mutations. So the transport lives in
 * an action the *app* owns (see `createSenderAction` in the client package) and
 * the component reaches it through a function handle.
 *
 * That indirection is also the seam the plan calls for: the component depends
 * on the `Sender` contract below, not on gRPC. If Spectrum Cloud grows an HTTPS
 * send endpoint, a fetch-based sender drops in here and the whole pipeline
 * moves to the V8 runtime with no schema or API change.
 */

/** The payload every sender implementation receives. */
export const senderArgs = {
  rowId: v.string(),
  spaceId: v.string(),
  phone: v.optional(v.string()),
  /**
   * The outbox's dedupe key for this row. Forward it to the provider as an
   * idempotency key *if* your transport accepts one — the Spectrum Cloud sender
   * cannot, which is why a lost acknowledgement can still double-post there.
   */
  clientGuid: v.string(),
  kind: v.string(),
  content: v.optional(v.any()),
  targetMessageId: v.optional(v.string()),
  reaction: v.optional(v.string()),
};

/**
 * A no-op sender used by tests and by installs that have not wired a transport
 * yet. Marks the row sent without touching the network, so the pipeline can be
 * exercised end to end without a live iMessage line.
 */
export const noopSender = internalMutation({
  args: senderArgs,
  returns: v.null(),
  handler: () => null,
});
