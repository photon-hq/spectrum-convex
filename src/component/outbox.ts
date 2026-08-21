import type { FunctionHandle } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import {
  internalMutation,
  type MutationCtx,
  mutation,
  query,
} from "./_generated/server.js";

/**
 * The outbound half: a durable outbox keyed by deterministic client guids.
 *
 * Every row carries a `clientGuid` derived from `(chainId, seq)`, so re-queuing
 * the same logical send — whether ours or the scheduler's — collapses onto the
 * existing row instead of creating a second one.
 *
 * That dedupe stops at the component boundary. The guid is NOT forwarded to the
 * provider: Spectrum's send path accepts no caller-supplied `clientMessageId`,
 * and the SDK's `autoIdempotency` mints a fresh key per call. So the failure
 * mode that actually bites in production — the send succeeded but the
 * acknowledgement was lost — can still post twice. Closing that needs an SDK
 * change to thread the key through; until then the guid is an internal dedupe
 * key, not an end-to-end idempotency key.
 */

/**
 * An app-owned sender action, addressed by function handle. Typed loosely on
 * purpose: the component is transport-agnostic, so it only promises the
 * payload shape, not which runtime fulfils it.
 */
type SenderHandle = FunctionHandle<
  "action" | "mutation",
  {
    rowId: string;
    spaceId: string;
    phone?: string;
    clientGuid: string;
    kind: string;
    content?: unknown;
    targetMessageId?: string;
    reaction?: string;
  },
  unknown
>;

const MAX_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 1000;
const RETRY_BACKOFF_FACTOR = 4;

export const sendKind = v.union(
  v.literal("send"),
  v.literal("reply"),
  v.literal("react"),
  v.literal("markRead"),
  v.literal("typing")
);

const chainIsLive = async (
  ctx: MutationCtx,
  chainId: string | undefined
): Promise<boolean> => {
  if (!chainId) {
    // A send with no chain (e.g. a proactive outbound message) is never
    // subject to conversational cancellation.
    return true;
  }
  const record = await ctx.db
    .query("chains")
    .withIndex("by_chain", (q) => q.eq("chainId", chainId))
    .unique();
  if (!record) {
    return false;
  }
  return record.status === "live";
};

/**
 * Queue one outbound action.
 *
 * Rejects (without writing) when the queueing chain has already been
 * superseded — the guard that stops a cancelled turn from talking over the
 * turn that replaced it. `pacingMs` staggers a multi-message reply so it reads
 * like typing rather than a wall of text arriving at once.
 */
export const enqueue = mutation({
  args: {
    spaceId: v.string(),
    chainId: v.optional(v.string()),
    kind: sendKind,
    content: v.optional(v.any()),
    targetMessageId: v.optional(v.string()),
    reaction: v.optional(v.string()),
    pacingMs: v.optional(v.number()),
    sender: v.optional(v.string()),
  },
  returns: v.object({
    queued: v.boolean(),
    clientGuid: v.optional(v.string()),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    if (!(await chainIsLive(ctx, args.chainId))) {
      return { queued: false, reason: "chain-cancelled" };
    }

    const priorForChain = args.chainId
      ? await ctx.db
          .query("outbox")
          .withIndex("by_chain", (q) => q.eq("chainId", args.chainId))
          .collect()
      : [];
    const seq = priorForChain.length;
    const now = Date.now();
    // Deterministic: the same (chain, seq) always yields the same guid, which
    // is what makes a replayed send collapse instead of duplicating.
    const clientGuid = `${args.chainId ?? `${args.spaceId}:${now}`}#${seq}`;

    const existing = await ctx.db
      .query("outbox")
      .withIndex("by_guid", (q) => q.eq("clientGuid", clientGuid))
      .unique();
    if (existing) {
      return { queued: false, clientGuid, reason: "duplicate" };
    }

    // Read receipts and reactions address an existing message. iMessage marks
    // read at chat level, but the universal API still identifies the chat
    // through one of its messages, so fall back to the newest inbound message
    // of this turn when the caller did not name one.
    let targetMessageId = args.targetMessageId;
    if (!targetMessageId && args.kind === "markRead" && args.chainId) {
      const newest = await ctx.db
        .query("inbound")
        .withIndex("by_chain", (q) => q.eq("chainId", args.chainId))
        .collect();
      targetMessageId = newest.at(-1)?.messageId;
    }

    const rowId = await ctx.db.insert("outbox", {
      spaceId: args.spaceId,
      ...(args.chainId === undefined ? {} : { chainId: args.chainId }),
      seq,
      clientGuid,
      kind: args.kind,
      ...(args.content === undefined ? {} : { content: args.content }),
      ...(targetMessageId === undefined ? {} : { targetMessageId }),
      ...(args.reaction === undefined ? {} : { reaction: args.reaction }),
      status: "pending" as const,
      attempts: 0,
      queuedAt: now,
    });

    if (args.sender) {
      // Pacing separates consecutive *messages* so a multi-part reply doesn't
      // land as a wall of text. It must never delay the first one: that is
      // pure latency before the user sees anything.
      //
      // Deliberately counted over message-bearing rows only, not `seq`. Control
      // actions (markRead, typing) occupy sequence numbers too, so keying off
      // `seq === 0` would let an auto-markRead push the actual reply into a
      // paced slot and reintroduce the delay this avoids.
      const isControlAction =
        args.kind === "markRead" || args.kind === "typing";
      const priorMessages = priorForChain.filter(
        (row) => row.kind !== "markRead" && row.kind !== "typing"
      ).length;
      const paces = !isControlAction && priorMessages > 0;
      const delay = paces ? (args.pacingMs ?? 0) : 0;

      const jobId = await ctx.scheduler.runAfter(
        delay,
        internal.outbox.deliver,
        {
          rowId,
          sender: args.sender,
        }
      );
      await ctx.db.patch(rowId, { jobId });
    }

    return { queued: true, clientGuid };
  },
});

/**
 * Hand one outbox row to the app-provided sender.
 *
 * The sender is a function handle for an action the app owns, because the
 * iMessage transport is gRPC and only Convex's Node runtime can speak it. The
 * component stays transport-agnostic: swap in a fetch-based sender and nothing
 * here changes.
 */
export const deliver = internalMutation({
  args: { rowId: v.id("outbox"), sender: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.rowId);
    if (row?.status !== "pending") {
      return null;
    }
    if (!(await chainIsLive(ctx, row.chainId))) {
      await ctx.db.patch(row._id, { status: "cancelled" as const });
      return null;
    }

    await ctx.db.patch(row._id, {
      status: "sending" as const,
      attempts: row.attempts + 1,
    });

    const space = await ctx.db
      .query("spaces")
      .withIndex("by_space", (q) => q.eq("spaceId", row.spaceId))
      .unique();

    await ctx.scheduler.runAfter(0, args.sender as SenderHandle, {
      rowId: row._id,
      spaceId: row.spaceId,
      phone: space?.phone,
      clientGuid: row.clientGuid,
      kind: row.kind,
      content: row.content,
      targetMessageId: row.targetMessageId,
      reaction: row.reaction,
    });
    return null;
  },
});

/** Record the sender's verdict for one row; retries with backoff on failure. */
export const settle = mutation({
  args: {
    rowId: v.id("outbox"),
    ok: v.boolean(),
    providerMessageId: v.optional(v.string()),
    error: v.optional(v.string()),
    sender: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.rowId);
    if (!row) {
      return null;
    }
    if (args.ok) {
      await ctx.db.patch(row._id, {
        status: "sent" as const,
        sentAt: Date.now(),
        ...(args.providerMessageId === undefined
          ? {}
          : { providerMessageId: args.providerMessageId }),
      });

      // A reply reached the user, so this turn's inherited messages are finally
      // spent. Doing it here rather than when the handler finishes is what
      // makes the pipeline lossless: until something actually ships, every
      // message stays recoverable by the next turn.
      const isReply = row.kind === "send" || row.kind === "reply";
      if (isReply && row.chainId) {
        const inherited = await ctx.db
          .query("carried")
          .withIndex("by_chain", (q) => q.eq("chainId", row.chainId))
          .collect();
        for (const spent of inherited) {
          await ctx.db.delete(spent._id);
        }
      }
      return null;
    }

    const exhausted = row.attempts >= MAX_ATTEMPTS;
    if (exhausted || !args.sender) {
      await ctx.db.patch(row._id, {
        status: "failed" as const,
        ...(args.error === undefined ? {} : { lastError: args.error }),
      });
      return null;
    }

    // Same clientGuid on the retry, so a send that actually landed before the
    // error is deduped provider-side instead of posting twice.
    const delay = BASE_RETRY_DELAY_MS * RETRY_BACKOFF_FACTOR ** row.attempts;
    const jobId = await ctx.scheduler.runAfter(delay, internal.outbox.deliver, {
      rowId: row._id,
      sender: args.sender,
    });
    await ctx.db.patch(row._id, {
      status: "pending" as const,
      jobId,
      ...(args.error === undefined ? {} : { lastError: args.error }),
    });
    return null;
  },
});

const outboxRow = v.object({
  clientGuid: v.string(),
  kind: v.string(),
  status: v.string(),
  attempts: v.number(),
  queuedAt: v.number(),
  sentAt: v.optional(v.number()),
  providerMessageId: v.optional(v.string()),
  lastError: v.optional(v.string()),
});

const toOutboxRow = (row: Doc<"outbox">) => ({
  clientGuid: row.clientGuid,
  kind: row.kind,
  status: row.status,
  attempts: row.attempts,
  queuedAt: row.queuedAt,
  ...(row.sentAt === undefined ? {} : { sentAt: row.sentAt }),
  ...(row.providerMessageId === undefined
    ? {}
    : { providerMessageId: row.providerMessageId }),
  ...(row.lastError === undefined ? {} : { lastError: row.lastError }),
});

/** Outbox rows for a space — delivery status and the failure audit trail. */
export const list = query({
  args: { spaceId: v.string(), limit: v.optional(v.number()) },
  returns: v.array(outboxRow),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("outbox")
      .withIndex("by_space_status", (q) => q.eq("spaceId", args.spaceId))
      .order("desc")
      .take(args.limit ?? 50);
    return rows.reverse().map(toOutboxRow);
  },
});
