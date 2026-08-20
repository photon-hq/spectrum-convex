import { v } from "convex/values";
import { type MutationCtx, mutation, query } from "./_generated/server.js";
import {
  cancelCurrentChain,
  DEFAULT_DEBOUNCE_MS,
  scheduleFlush,
} from "./pipeline.js";

/**
 * The inbound half of the pipeline: durable dedupe, the batch queue, and the
 * space registry.
 *
 * The HTTP entry point verifies a delivery and calls `enqueue` before it
 * answers 200, so a message is durable the moment Spectrum Cloud is told the
 * delivery succeeded. That's the whole reason the component exists rather than
 * an `app.webhook()` adapter: core's webhook handler is fire-and-forget *after*
 * the response, and on a serverless runtime the isolate is frozen the instant
 * the response is returned.
 */

const messageArgs = {
  spaceId: v.string(),
  messageId: v.string(),
  platform: v.string(),
  senderId: v.optional(v.string()),
  content: v.any(),
  timestamp: v.optional(v.string()),
  raw: v.optional(v.any()),
  triggersTurn: v.optional(v.boolean()),
  phone: v.optional(v.string()),
  spaceType: v.optional(v.union(v.literal("dm"), v.literal("group"))),
};

const upsertSpace = async (
  ctx: MutationCtx,
  args: {
    spaceId: string;
    platform: string;
    phone?: string;
    spaceType?: "dm" | "group";
    now: number;
  }
): Promise<void> => {
  const existing = await ctx.db
    .query("spaces")
    .withIndex("by_space", (q) => q.eq("spaceId", args.spaceId))
    .unique();
  const patch = {
    platform: args.platform,
    lastInboundAt: args.now,
    // Routing facts are sticky: a later delivery that omits `phone` must not
    // erase the line we already learned, or sends to this space start failing
    // in multi-line mode.
    ...(args.phone === undefined ? {} : { phone: args.phone }),
    ...(args.spaceType === undefined ? {} : { type: args.spaceType }),
  };
  if (existing) {
    await ctx.db.patch(existing._id, patch);
    return;
  }
  await ctx.db.insert("spaces", {
    spaceId: args.spaceId,
    ...patch,
  });
};

/**
 * Record one verified inbound message and (re)arm the debounce window.
 *
 * Returns `{ deduped: true }` when the message id has been seen before —
 * native webhooks are at-least-once, so a redelivery must not create a second
 * queue row or restart the debounce timer.
 */
export const enqueue = mutation({
  args: {
    ...messageArgs,
    debounceMs: v.optional(v.number()),
    /**
     * `"immediate"` (default): every message is its own turn — no supersession,
     * no carry-forward, no batching. `"collapse"`: a new message supersedes the
     * in-flight turn and its messages are carried into the next one.
     */
    mode: v.optional(v.union(v.literal("immediate"), v.literal("collapse"))),
    // Function handle (`createFunctionHandle(internal.foo.bar)`) for the app's
    // batch handler. Threaded through per-call rather than stored at install
    // time so the app can change or version its handler without a migration.
    onBatch: v.optional(v.string()),
  },
  returns: v.object({
    deduped: v.boolean(),
    cancelledChain: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const duplicate = await ctx.db
      .query("inbound")
      .withIndex("by_message", (q) => q.eq("messageId", args.messageId))
      .unique();
    if (duplicate) {
      return { deduped: true };
    }

    const now = Date.now();
    await upsertSpace(ctx, {
      spaceId: args.spaceId,
      platform: args.platform,
      ...(args.phone === undefined ? {} : { phone: args.phone }),
      ...(args.spaceType === undefined ? {} : { spaceType: args.spaceType }),
      now,
    });

    // Signals (read receipts, typing) are recorded for visibility but never
    // become batch input — stored already-handled so no flush can drain them.
    const triggersTurn = args.triggersTurn ?? true;

    const rowId = await ctx.db.insert("inbound", {
      spaceId: args.spaceId,
      messageId: args.messageId,
      platform: args.platform,
      ...(args.senderId === undefined ? {} : { senderId: args.senderId }),
      content: args.content,
      ...(args.timestamp === undefined ? {} : { timestamp: args.timestamp }),
      receivedAt: now,
      status: triggersTurn ? ("queued" as const) : ("handled" as const),
      ...(args.raw === undefined ? {} : { raw: args.raw }),
    });

    if (!triggersTurn) {
      // Critically, do NOT cancel the in-flight turn or re-arm the debounce.
      // A read receipt arriving mid-generation must not cancel the reply it is
      // acknowledging, and must not extend the window that reply is waiting on.
      return { deduped: false };
    }

    if ((args.mode ?? "immediate") === "immediate") {
      // Every message is its own turn. Nothing is superseded, so a reply
      // already in flight is left alone and no message waits on another.
      await scheduleFlush(ctx, {
        spaceId: args.spaceId,
        debounceMs: args.debounceMs ?? DEFAULT_DEBOUNCE_MS,
        ...(args.onBatch === undefined ? {} : { onBatch: args.onBatch }),
        only: rowId,
        now,
      });
      return { deduped: false };
    }

    // Collapse mode: a new message supersedes whatever turn is in flight —
    // cancel it, carry its messages forward, then restart the window.
    const cancelledChain = await cancelCurrentChain(ctx, args.spaceId, now);
    await scheduleFlush(ctx, {
      spaceId: args.spaceId,
      debounceMs: args.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      ...(args.onBatch === undefined ? {} : { onBatch: args.onBatch }),
      now,
    });

    return {
      deduped: false,
      ...(cancelledChain === undefined ? {} : { cancelledChain }),
    };
  },
});

/** Look up a space's routing record (phone/type) for the send path. */
export const getSpace = query({
  args: { spaceId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      spaceId: v.string(),
      platform: v.string(),
      phone: v.optional(v.string()),
      type: v.optional(v.union(v.literal("dm"), v.literal("group"))),
      lastInboundAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const space = await ctx.db
      .query("spaces")
      .withIndex("by_space", (q) => q.eq("spaceId", args.spaceId))
      .unique();
    if (!space) {
      return null;
    }
    return {
      spaceId: space.spaceId,
      platform: space.platform,
      ...(space.phone === undefined ? {} : { phone: space.phone }),
      ...(space.type === undefined ? {} : { type: space.type }),
      lastInboundAt: space.lastInboundAt,
    };
  },
});

/** Recent messages for a space, newest last. Intended for dashboards. */
export const listMessages = query({
  args: {
    spaceId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      messageId: v.string(),
      senderId: v.optional(v.string()),
      content: v.any(),
      timestamp: v.optional(v.string()),
      receivedAt: v.number(),
      status: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("inbound")
      .withIndex("by_space_status", (q) => q.eq("spaceId", args.spaceId))
      .order("desc")
      .take(args.limit ?? 50);
    return rows.reverse().map((row) => ({
      messageId: row.messageId,
      ...(row.senderId === undefined ? {} : { senderId: row.senderId }),
      content: row.content,
      ...(row.timestamp === undefined ? {} : { timestamp: row.timestamp }),
      receivedAt: row.receivedAt,
      status: row.status,
    }));
  },
});
