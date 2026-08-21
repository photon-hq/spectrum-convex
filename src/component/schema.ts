import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Slim inbound content, stored exactly as the native Spectrum webhook
 * delivered it. Kept as an opaque `v.any()` rather than a discriminated union
 * on purpose: the webhook wire format is additive (new content arms ship
 * without an SDK bump), and a strict validator here would reject a delivery
 * the SDK itself is happy to parse. Narrowing happens in app code, where the
 * `Content` types from `@spectrum-ts/core` apply.
 */
const slimContent = v.any();

export const inboundStatus = v.union(
  // Waiting for a flush to pick it up.
  v.literal("queued"),
  // Handed to a batch; still owned by a live chain.
  v.literal("drained"),
  // The chain that drained it completed.
  v.literal("handled")
);

export const outboxStatus = v.union(
  v.literal("pending"),
  v.literal("sending"),
  v.literal("sent"),
  v.literal("failed"),
  // The chain that queued this send was superseded before it went out.
  v.literal("cancelled")
);

export default defineSchema({
  /**
   * Every verified inbound message, and the batch queue itself. Messages stay
   * here until a flush drains them — the "drain in the handler, not the
   * enqueuer" rule — so a cancelled flush loses nothing.
   */
  inbound: defineTable({
    spaceId: v.string(),
    // Provider message id. Native webhooks are at-least-once, so this is the
    // dedupe key.
    messageId: v.string(),
    platform: v.string(),
    senderId: v.optional(v.string()),
    content: slimContent,
    // Wire timestamp (ISO 8601) as delivered; `receivedAt` is our clock.
    timestamp: v.optional(v.string()),
    receivedAt: v.number(),
    status: inboundStatus,
    // Set when a chain drains this row, so cancellation can find its messages.
    chainId: v.optional(v.string()),
    raw: v.optional(v.any()),
  })
    .index("by_message", ["messageId"])
    .index("by_space_status", ["spaceId", "status"])
    .index("by_chain", ["chainId"]),

  /**
   * Routing registry. iMessage sends need the `phone` (which line serves this
   * conversation) and the chat type, neither of which is derivable from the
   * space id alone in multi-line mode.
   */
  spaces: defineTable({
    spaceId: v.string(),
    platform: v.string(),
    phone: v.optional(v.string()),
    type: v.optional(v.union(v.literal("dm"), v.literal("group"))),
    lastInboundAt: v.number(),
  }).index("by_space", ["spaceId"]),

  /**
   * Per-space record of the chain that currently owns the pipeline. A "chain"
   * is one conversational turn: flush → handler → sends.
   *
   * `ctx.scheduler.cancel` cannot stop an action that has already started, so
   * cancellation is cooperative: a running handler polls `isCancelled`.
   *
   * Liveness is decided by chain *identity* (`chainId` / `cancelledChainId`),
   * never by comparing timestamps. Two pipeline events can land in the same
   * millisecond — a message arriving as its own flush runs — and a
   * `cancelledAt > chainStartedAt` test would then read a cancelled chain as
   * live. `cancelledAt` is kept for audit only.
   */
  inflight: defineTable({
    spaceId: v.string(),
    chainId: v.optional(v.string()),
    chainStartedAt: v.optional(v.number()),
    /** The chain `cancel` last killed. Compared by identity, not by time. */
    cancelledChainId: v.optional(v.string()),
    /** Audit only — never used to decide whether a chain is live. */
    cancelledAt: v.optional(v.number()),
    flushJobId: v.optional(v.id("_scheduled_functions")),
    handlerJobId: v.optional(v.id("_scheduled_functions")),
  }).index("by_space", ["spaceId"]),

  /**
   * One row per turn, and the authority on whether that turn is still live.
   *
   * `inflight` tracks only the *current* turn for a space, which is enough for
   * collapse mode but wrong for immediate mode, where several turns are open at
   * once and are independent. Deriving liveness from "is this the current
   * chain?" would let each new message silently invalidate its predecessors.
   */
  chains: defineTable({
    chainId: v.string(),
    spaceId: v.string(),
    status: v.union(v.literal("live"), v.literal("cancelled")),
    startedAt: v.number(),
  }).index("by_chain", ["chainId"]),

  /**
   * Messages a cancelled chain had already drained. The next flush prepends
   * them so the model still sees them — as history, not as fresh input.
   *
   * A flush *claims* these rows (stamps `chainId`) rather than deleting them,
   * and they are removed only once that chain completes. Deleting at read time
   * loses them if the claiming chain is itself superseded — the same
   * "drain in the handler, not the enqueuer" rule that governs `inbound`.
   */
  carried: defineTable({
    spaceId: v.string(),
    messageId: v.string(),
    content: slimContent,
    senderId: v.optional(v.string()),
    timestamp: v.optional(v.string()),
    carriedAt: v.number(),
    chainId: v.optional(v.string()),
  })
    .index("by_space", ["spaceId"])
    .index("by_chain", ["chainId"]),

  /**
   * Outbound sends. `clientGuid` is derived deterministically from
   * `(chainId, seq)`, so a re-queued send lands on the row that already exists
   * rather than a second one. It dedupes rows here only — it is not forwarded
   * to the provider (see the note in `outbox.ts`).
   */
  outbox: defineTable({
    spaceId: v.string(),
    chainId: v.optional(v.string()),
    seq: v.number(),
    clientGuid: v.string(),
    kind: v.union(
      v.literal("send"),
      v.literal("reply"),
      v.literal("react"),
      v.literal("markRead"),
      v.literal("typing")
    ),
    content: v.optional(slimContent),
    targetMessageId: v.optional(v.string()),
    reaction: v.optional(v.string()),
    status: outboxStatus,
    attempts: v.number(),
    queuedAt: v.number(),
    sentAt: v.optional(v.number()),
    providerMessageId: v.optional(v.string()),
    lastError: v.optional(v.string()),
    jobId: v.optional(v.id("_scheduled_functions")),
  })
    .index("by_guid", ["clientGuid"])
    .index("by_space_status", ["spaceId", "status"])
    .index("by_chain", ["chainId"]),
});
