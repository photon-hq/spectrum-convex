"use node";

import { createCloudSender, fetchAttachment } from "@spectrum-ts/convex/sender";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { spectrum } from "./spectrum";

/**
 * The gRPC transport, in the app's Node runtime.
 *
 * It has to live here rather than inside the component for two reasons: only
 * the Node runtime can speak gRPC over HTTP/2, and a `"use node"` file may
 * contain actions only — while the component is queries and mutations. The
 * component reaches this action through a function handle.
 *
 * Built once per container, not per send, so warm invocations skip the token
 * mint and channel handshake.
 */
const sender = createCloudSender();

export const deliver = internalAction({
  args: {
    rowId: v.string(),
    spaceId: v.string(),
    phone: v.optional(v.string()),
    clientGuid: v.string(),
    kind: v.string(),
    content: v.optional(v.any()),
    targetMessageId: v.optional(v.string()),
    targetContent: v.optional(v.any()),
    reaction: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const outcome = await sender.deliver(args);
    // Always report back: the outbox owns retry/backoff, and it re-uses the
    // same clientGuid so a send that landed before an error cannot double-post.
    await spectrum.settle(ctx, {
      rowId: args.rowId,
      ok: outcome.ok,
      ...(outcome.providerMessageId === undefined
        ? {}
        : { providerMessageId: outcome.providerMessageId }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    });
    return null;
  },
});

/**
 * Pull an inbound attachment into Convex file storage.
 *
 * The webhook carries attachment metadata only; the bytes come over gRPC on
 * demand. They go to file storage rather than a table because Convex documents
 * cap at 1 MiB.
 */
export const saveAttachment = internalAction({
  args: {
    attachmentId: v.string(),
    phone: v.optional(v.string()),
  },
  returns: v.union(v.null(), v.id("_storage")),
  handler: async (ctx, args) => {
    const found = await fetchAttachment(args.attachmentId, {
      ...(args.phone === undefined ? {} : { phone: args.phone }),
    });
    if (!found) {
      return null;
    }
    return await ctx.storage.store(found.blob);
  },
});
