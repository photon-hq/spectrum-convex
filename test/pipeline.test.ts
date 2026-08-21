import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/component/_generated/api.js";
import schema from "../src/component/schema.js";

/**
 * Pipeline behavior tests, run against the component's own schema in
 * `convex-test`'s in-memory backend.
 *
 * These target the rules that are easy to get subtly wrong and expensive to
 * discover in production: at-least-once dedupe, the debounce reset, the
 * carry-forward rule, and the per-chain (not per-space) cancellation check.
 */

// `import.meta.glob` is how convex-test discovers the function modules. The
// component's files live outside a conventional `convex/` dir, so the glob is
// pointed at them explicitly.
const modules = import.meta.glob("../src/component/**/*.ts");

const setup = () => convexTest(schema, modules);

// The pipeline is scheduler-driven: the debounce window is a real
// `runAfter`. Fake timers let a test jump the window instead of sleeping, and
// `finishAllScheduledFunctions` needs the timer-advancing callback to actually
// fire the jobs it is waiting on.
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Run every scheduled job, advancing the debounce timers to fire them. */
const settle = async (t: ReturnType<typeof setup>): Promise<void> => {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
};

/**
 * A message in `collapse` mode. The suites below exercise supersession,
 * carry-forward and batching, which only exist in that mode — the component
 * default is `immediate` (one message, one turn), covered separately at the
 * bottom of this file.
 */
const message = (overrides: Record<string, unknown> = {}) => ({
  spaceId: "chat-1",
  messageId: "m1",
  platform: "imessage",
  senderId: "u1",
  content: { type: "text", text: "hey" },
  mode: "collapse" as const,
  ...overrides,
});

describe("inbound.enqueue", () => {
  it("stores a verified message and registers the space", async () => {
    const t = setup();
    const result = await t.mutation(api.inbound.enqueue, message());
    expect(result.deduped).toBe(false);

    const space = await t.query(api.inbound.getSpace, { spaceId: "chat-1" });
    expect(space?.platform).toBe("imessage");

    const stored = await t.query(api.inbound.listMessages, {
      spaceId: "chat-1",
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.messageId).toBe("m1");
    expect(stored[0]?.status).toBe("queued");
  });

  it("dedupes a redelivered message id without a second row", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, message());
    const second = await t.mutation(api.inbound.enqueue, message());

    expect(second.deduped).toBe(true);
    const stored = await t.query(api.inbound.listMessages, {
      spaceId: "chat-1",
    });
    expect(stored).toHaveLength(1);
  });

  it("keeps a learned phone when a later delivery omits it", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, message({ phone: "+15551234567" }));
    await t.mutation(api.inbound.enqueue, message({ messageId: "m2" }));

    const space = await t.query(api.inbound.getSpace, { spaceId: "chat-1" });
    expect(space?.phone).toBe("+15551234567");
  });
});

describe("debounce and flush", () => {
  it("handles a burst as one batch after the window settles", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, message({ messageId: "m1" }));
    await t.mutation(api.inbound.enqueue, message({ messageId: "m2" }));
    await t.mutation(
      api.inbound.enqueue,
      message({ messageId: "m3", debounceMs: 5000 })
    );

    // Nothing has been drained yet — the timer is still running.
    let stored = await t.query(api.inbound.listMessages, {
      spaceId: "chat-1",
    });
    expect(stored.every((m) => m.status === "queued")).toBe(true);

    await settle(t);

    stored = await t.query(api.inbound.listMessages, { spaceId: "chat-1" });
    expect(stored).toHaveLength(3);
    // One flush drained the whole burst into a single chain.
    expect(stored.every((m) => m.status === "drained")).toBe(true);
  });
});

describe("cancellation and carry-forward", () => {
  it("carries drained messages forward when a chain is superseded", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, message({ messageId: "m1" }));
    await settle(t);

    // A new message lands mid-turn: the chain is cancelled and its drained
    // rows must not be lost.
    await t.mutation(api.inbound.enqueue, message({ messageId: "m2" }));

    const carried = await t.run(
      async (ctx) => await ctx.db.query("carried").collect()
    );
    expect(carried).toHaveLength(1);
    expect(carried[0]?.messageId).toBe("m1");
  });

  it("claims carried messages on flush rather than deleting them", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, message({ messageId: "m1" }));
    await settle(t);
    await t.mutation(api.inbound.enqueue, message({ messageId: "m2" }));
    await settle(t);

    // The consuming chain claims the row; it survives until that chain answers,
    // so a second supersession can still hand it on.
    const carried = await t.run(
      async (ctx) => await ctx.db.query("carried").collect()
    );
    expect(carried).toHaveLength(1);
    expect(carried[0]?.chainId).toBeDefined();
  });

  it("keeps carried messages until a reply actually ships", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, message({ messageId: "m1" }));
    await settle(t);
    await t.mutation(api.inbound.enqueue, message({ messageId: "m2" }));
    await settle(t);

    const chainId = (await t.run(async (ctx) => {
      const row = await ctx.db.query("inflight").first();
      return row?.chainId;
    })) as string;

    // Handler finished — but its reply is only queued, and a supersession can
    // still cancel it, so the inherited message must survive.
    await t.mutation(api.pipeline.completeChain, {
      spaceId: "chat-1",
      chainId,
    });
    let carried = await t.run(
      async (ctx) => await ctx.db.query("carried").collect()
    );
    expect(carried).toHaveLength(1);

    const queued = await t.mutation(api.outbox.enqueue, {
      spaceId: "chat-1",
      chainId,
      kind: "send" as const,
      content: { type: "text", text: "reply" },
      sender: "noop-handle",
    });
    const rowId = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("outbox")
        .withIndex("by_guid", (q) =>
          q.eq("clientGuid", queued.clientGuid as string)
        )
        .unique();
      return row?._id;
    });
    expect(rowId).toBeDefined();
    await t.mutation(api.outbox.settle, {
      rowId: rowId as NonNullable<typeof rowId>,
      ok: true,
    });

    // The reply reached the user, so the turn's messages are finally spent.
    carried = await t.run(
      async (ctx) => await ctx.db.query("carried").collect()
    );
    expect(carried).toHaveLength(0);
  });

  it("keeps every message across back-to-back supersessions", async () => {
    // The regression this replaced: a chain that inherited a carried message
    // and was then itself superseded dropped that message, because the flush
    // had already deleted it from the carry table. A user typing three
    // messages quickly lost the first one.
    const t = setup();
    await t.mutation(api.inbound.enqueue, message({ messageId: "m1" }));
    await settle(t);
    await t.mutation(api.inbound.enqueue, message({ messageId: "m2" }));
    await settle(t);
    await t.mutation(api.inbound.enqueue, message({ messageId: "m3" }));
    await settle(t);

    const seen = await t.run(async (ctx) => {
      const carried = await ctx.db.query("carried").collect();
      const inbound = await ctx.db.query("inbound").collect();
      const live = (await ctx.db.query("inflight").first())?.chainId;
      return [
        ...carried.map((c) => c.messageId),
        ...inbound
          .filter((row) => row.chainId === live && row.status === "drained")
          .map((row) => row.messageId),
      ];
    });

    expect(new Set(seen)).toEqual(new Set(["m1", "m2", "m3"]));
  });

  it("reports a superseded chain as cancelled, and a live one as not", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, message({ messageId: "m1" }));
    await settle(t);

    const chainId = await t.run(async (ctx) => {
      const inflight = await ctx.db.query("inflight").first();
      return inflight?.chainId;
    });
    expect(chainId).toBeDefined();

    expect(
      await t.query(api.pipeline.isCancelled, {
        spaceId: "chat-1",
        chainId: chainId as string,
      })
    ).toBe(false);

    await t.mutation(api.pipeline.cancel, { spaceId: "chat-1" });

    expect(
      await t.query(api.pipeline.isCancelled, {
        spaceId: "chat-1",
        chainId: chainId as string,
      })
    ).toBe(true);
  });

  it("treats an unknown chain as cancelled", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, message());
    expect(
      await t.query(api.pipeline.isCancelled, {
        spaceId: "chat-1",
        chainId: "some-chain-that-never-existed",
      })
    ).toBe(true);
  });
});

describe("outbox", () => {
  it("numbers each send in a chain deterministically", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, message());
    await settle(t);
    const chainId = (await t.run(async (ctx) => {
      const inflight = await ctx.db.query("inflight").first();
      return inflight?.chainId;
    })) as string;

    const first = await t.mutation(api.outbox.enqueue, {
      spaceId: "chat-1",
      chainId,
      kind: "send" as const,
      content: { type: "text", text: "one" },
    });
    const second = await t.mutation(api.outbox.enqueue, {
      spaceId: "chat-1",
      chainId,
      kind: "send" as const,
      content: { type: "text", text: "two" },
    });

    expect(first.clientGuid).toBe(`${chainId}#0`);
    expect(second.clientGuid).toBe(`${chainId}#1`);
  });

  it("refuses to queue a send from a superseded chain", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, message());
    await settle(t);
    const chainId = (await t.run(async (ctx) => {
      const inflight = await ctx.db.query("inflight").first();
      return inflight?.chainId;
    })) as string;

    await t.mutation(api.pipeline.cancel, { spaceId: "chat-1" });

    const result = await t.mutation(api.outbox.enqueue, {
      spaceId: "chat-1",
      chainId,
      kind: "send" as const,
      content: { type: "text", text: "too late" },
    });
    expect(result.queued).toBe(false);
    expect(result.reason).toBe("chain-cancelled");
  });

  it("cancels pending sends belonging to a superseded chain", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, message());
    await settle(t);
    const chainId = (await t.run(async (ctx) => {
      const inflight = await ctx.db.query("inflight").first();
      return inflight?.chainId;
    })) as string;

    await t.mutation(api.outbox.enqueue, {
      spaceId: "chat-1",
      chainId,
      kind: "send" as const,
      content: { type: "text", text: "queued" },
    });
    await t.mutation(api.pipeline.cancel, { spaceId: "chat-1" });

    const rows = await t.query(api.outbox.list, { spaceId: "chat-1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("cancelled");
  });

  it("allows a chainless send regardless of conversational state", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, message());
    await settle(t);
    await t.mutation(api.pipeline.cancel, { spaceId: "chat-1" });

    const result = await t.mutation(api.outbox.enqueue, {
      spaceId: "chat-1",
      kind: "send" as const,
      content: { type: "text", text: "proactive" },
    });
    expect(result.queued).toBe(true);
  });
});

describe("signals do not drive turns", () => {
  const readReceipt = (id: string) =>
    message({
      messageId: id,
      triggersTurn: false,
      content: {
        type: "read",
        target: {
          id: "outbound-1",
          content: { type: "text", text: "echo: 1" },
        },
      },
    });

  it("never feeds a read receipt into a batch", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, readReceipt("r1"));
    await settle(t);

    // Stored for visibility, but already handled — no flush can drain it.
    const rows = await t.query(api.inbound.listMessages, {
      spaceId: "chat-1",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("handled");
  });

  it("does not arm the debounce, so a receipt alone starts no turn", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, readReceipt("r1"));
    await settle(t);

    const inflight = await t.run(
      async (ctx) => await ctx.db.query("inflight").first()
    );
    // No chain was ever created. This is what stops the echo feedback loop:
    // reply → read receipt → reply → … forever.
    expect(inflight?.chainId).toBeUndefined();
  });

  it("does not cancel the turn it is acknowledging", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, message({ messageId: "m1" }));
    await settle(t);
    const chainId = (await t.run(async (ctx) => {
      const row = await ctx.db.query("inflight").first();
      return row?.chainId;
    })) as string;

    // A receipt for the bot's own reply lands while the turn is still open.
    await t.mutation(api.inbound.enqueue, readReceipt("r1"));

    expect(
      await t.query(api.pipeline.isCancelled, { spaceId: "chat-1", chainId })
    ).toBe(false);
  });
});

describe("pacing", () => {
  const chainFor = async (t: ReturnType<typeof setup>) => {
    await t.mutation(api.inbound.enqueue, message());
    await settle(t);
    return (await t.run(async (ctx) => {
      const row = await ctx.db.query("inflight").first();
      return row?.chainId;
    })) as string;
  };

  it("does not delay the first reply of a turn", async () => {
    const t = setup();
    const chainId = await chainFor(t);

    await t.mutation(api.outbox.enqueue, {
      spaceId: "chat-1",
      chainId,
      kind: "send" as const,
      content: { type: "text", text: "first" },
      pacingMs: 800,
      sender: "noop-handle",
    });

    // Pacing separates consecutive messages; delaying the first is pure
    // latency before the user sees anything.
    const scheduled = await t.run(
      async (ctx) => await ctx.db.system.query("_scheduled_functions").collect()
    );
    const delivery = scheduled.find((j) => j.name.includes("deliver"));
    expect(delivery?.scheduledTime).toBeLessThanOrEqual(
      (delivery?._creationTime ?? 0) + 1
    );
  });
});

describe("pacing counts messages, not control actions", () => {
  it("does not let an auto-markRead push the reply into a paced slot", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, message());
    await settle(t);
    const chainId = (await t.run(async (ctx) => {
      const row = await ctx.db.query("inflight").first();
      return row?.chainId;
    })) as string;

    // The shape a real handler produces: acknowledge, then reply.
    await t.mutation(api.outbox.enqueue, {
      spaceId: "chat-1",
      chainId,
      kind: "markRead" as const,
      pacingMs: 600,
      sender: "noop-handle",
    });
    await t.mutation(api.outbox.enqueue, {
      spaceId: "chat-1",
      chainId,
      kind: "send" as const,
      content: { type: "text", text: "first reply" },
      pacingMs: 600,
      sender: "noop-handle",
    });

    // markRead occupies seq 0, but the reply is still the first *message* of
    // the turn and must not be delayed.
    const jobs = await t.run(
      async (ctx) => await ctx.db.system.query("_scheduled_functions").collect()
    );
    const deliveries = jobs.filter((j) => j.name.includes("deliver"));
    for (const job of deliveries) {
      expect(job.scheduledTime - job._creationTime).toBeLessThanOrEqual(1);
    }
  });
});

describe("no debounce: cancellation collapses bursts instead of waiting", () => {
  it("cancels a reply that has not gone out when a follow-up arrives", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, message({ messageId: "m1" }));
    await settle(t);
    const firstChain = (await t.run(async (ctx) => {
      const row = await ctx.db.query("inflight").first();
      return row?.chainId;
    })) as string;

    // The handler queued a reply; the provider has not delivered it yet
    // (a real iMessage send takes ~1s server-side).
    await t.mutation(api.outbox.enqueue, {
      spaceId: "chat-1",
      chainId: firstChain,
      kind: "send" as const,
      content: { type: "text", text: "reply to m1 only" },
      sender: "noop-handle",
    });

    // The follow-up lands inside that window.
    await t.mutation(api.inbound.enqueue, message({ messageId: "m2" }));

    const rows = await t.query(api.outbox.list, { spaceId: "chat-1" });
    // The stale reply never ships — this is what replaces the debounce.
    expect(rows.at(-1)?.status).toBe("cancelled");
  });

  it("hands the superseded message to the next turn as context", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, message({ messageId: "m1" }));
    await settle(t);
    await t.mutation(api.inbound.enqueue, message({ messageId: "m2" }));

    // m1 was already drained by the cancelled turn, so it moves to `carried`
    // and the next flush sees both — no message is answered twice or lost.
    const carried = await t.run(
      async (ctx) => await ctx.db.query("carried").collect()
    );
    expect(carried.map((c) => c.messageId)).toEqual(["m1"]);
  });

  it("flushes immediately by default", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, message());

    const jobs = await t.run(
      async (ctx) => await ctx.db.system.query("_scheduled_functions").collect()
    );
    const flush = jobs.find((j) => j.name.includes("flush"));
    expect(flush).toBeDefined();
    // `_creationTime` carries sub-millisecond precision, so compare with a
    // tolerance rather than to exactly 0.
    expect(
      Math.abs((flush?.scheduledTime ?? 0) - (flush?._creationTime ?? 0))
    ).toBeLessThan(1);
  });
});

describe("a message is answered only when its reply actually ships", () => {
  const queueReply = async (
    t: ReturnType<typeof setup>,
    chainId: string,
    text: string
  ) =>
    await t.mutation(api.outbox.enqueue, {
      spaceId: "chat-1",
      chainId,
      kind: "send" as const,
      content: { type: "text", text },
      sender: "noop-handle",
    });

  const liveChain = async (t: ReturnType<typeof setup>) =>
    (await t.run(async (ctx) => {
      const row = await ctx.db.query("inflight").first();
      return row?.chainId;
    })) as string;

  it("carries a message forward when its queued reply gets cancelled", async () => {
    // `completeChain` runs when the handler finishes, but the reply is only
    // *queued* then. A supersession moments later cancels it — so the message
    // must not stay marked as answered.
    const t = setup();
    await t.mutation(api.inbound.enqueue, message({ messageId: "m1" }));
    await settle(t);
    const chainId = await liveChain(t);

    await queueReply(t, chainId, "echo: m1");
    await t.mutation(api.pipeline.completeChain, {
      spaceId: "chat-1",
      chainId,
    });

    await t.mutation(api.inbound.enqueue, message({ messageId: "m2" }));

    const carried = await t.run(
      async (ctx) => await ctx.db.query("carried").collect()
    );
    expect(carried.map((c) => c.messageId)).toEqual(["m1"]);
  });

  it("does not re-answer a message whose reply already went out", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, message({ messageId: "m1" }));
    await settle(t);
    const chainId = await liveChain(t);

    const queued = await queueReply(t, chainId, "echo: m1");
    // The reply reached the user.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("outbox")
        .withIndex("by_guid", (q) =>
          q.eq("clientGuid", queued.clientGuid as string)
        )
        .unique();
      if (row) {
        await ctx.db.patch(row._id, { status: "sent", sentAt: Date.now() });
      }
    });
    await t.mutation(api.pipeline.completeChain, {
      spaceId: "chat-1",
      chainId,
    });

    await t.mutation(api.inbound.enqueue, message({ messageId: "m2" }));

    // Genuinely answered, so it must not reappear as context.
    const carried = await t.run(
      async (ctx) => await ctx.db.query("carried").collect()
    );
    expect(carried).toHaveLength(0);
  });
});

describe("immediate mode (the default): one message, one turn", () => {
  // No `mode` — this is what a user gets out of the box.
  const plain = (overrides: Record<string, unknown> = {}) => ({
    spaceId: "chat-1",
    messageId: "m1",
    platform: "imessage",
    senderId: "u1",
    content: { type: "text", text: "hey" },
    ...overrides,
  });

  it("gives each message its own turn", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, plain({ messageId: "m1" }));
    await t.mutation(api.inbound.enqueue, plain({ messageId: "m2" }));
    await t.mutation(api.inbound.enqueue, plain({ messageId: "m3" }));
    await settle(t);

    const rows = await t.query(api.inbound.listMessages, {
      spaceId: "chat-1",
    });
    expect(rows).toHaveLength(3);
    // Three separate chains, not one shared batch.
    const chains = await t.run(async (ctx) => {
      const inbound = await ctx.db.query("inbound").collect();
      // Returned as an array: `t.run` can only hand back Convex values.
      return inbound.map((row) => row.chainId ?? "");
    });
    expect(new Set(chains).size).toBe(3);
  });

  it("never batches or carries messages", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, plain({ messageId: "m1" }));
    await t.mutation(api.inbound.enqueue, plain({ messageId: "m2" }));
    await settle(t);

    const carried = await t.run(
      async (ctx) => await ctx.db.query("carried").collect()
    );
    expect(carried).toHaveLength(0);
  });

  it("leaves an in-flight reply alone when the next message arrives", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, plain({ messageId: "m1" }));
    await settle(t);
    const chainId = (await t.run(async (ctx) => {
      const row = await ctx.db
        .query("inbound")
        .withIndex("by_message", (q) => q.eq("messageId", "m1"))
        .unique();
      return row?.chainId;
    })) as string;

    await t.mutation(api.outbox.enqueue, {
      spaceId: "chat-1",
      chainId,
      kind: "send" as const,
      content: { type: "text", text: "reply to m1" },
      sender: "noop-handle",
    });
    await t.mutation(api.inbound.enqueue, plain({ messageId: "m2" }));

    // Nothing is superseded, so the first reply still ships.
    const rows = await t.query(api.outbox.list, { spaceId: "chat-1" });
    expect(rows.every((r) => r.status !== "cancelled")).toBe(true);
  });

  it("still dedupes redeliveries", async () => {
    const t = setup();
    await t.mutation(api.inbound.enqueue, plain({ messageId: "m1" }));
    const again = await t.mutation(
      api.inbound.enqueue,
      plain({ messageId: "m1" })
    );
    expect(again.deduped).toBe(true);
  });
});

describe("concurrent immediate turns stay independent", () => {
  const plain = (overrides: Record<string, unknown> = {}) => ({
    spaceId: "chat-1",
    messageId: "m1",
    platform: "imessage",
    senderId: "u1",
    content: { type: "text", text: "hey" },
    ...overrides,
  });

  it("does not let a later message invalidate an earlier turn's reply", async () => {
    // Regression: every turn used to share one `inflight` row, so each new
    // message overwrote `chainId` and silently cancelled its predecessors'
    // queued sends. In immediate mode all three replies must survive.
    const t = setup();
    const chainOf = async (messageId: string) =>
      (await t.run(async (ctx) => {
        const row = await ctx.db
          .query("inbound")
          .withIndex("by_message", (q) => q.eq("messageId", messageId))
          .unique();
        return row?.chainId;
      })) as string;

    for (const id of ["m1", "m2", "m3"]) {
      await t.mutation(api.inbound.enqueue, plain({ messageId: id }));
      await settle(t);
    }

    for (const id of ["m1", "m2", "m3"]) {
      const chainId = await chainOf(id);
      expect(
        await t.query(api.pipeline.isCancelled, { spaceId: "chat-1", chainId })
      ).toBe(false);

      const queued = await t.mutation(api.outbox.enqueue, {
        spaceId: "chat-1",
        chainId,
        kind: "send" as const,
        content: { type: "text", text: `echo: ${id}` },
        sender: "noop-handle",
      });
      expect(queued.queued).toBe(true);
    }

    const rows = await t.query(api.outbox.list, { spaceId: "chat-1" });
    expect(rows.filter((r) => r.status === "cancelled")).toHaveLength(0);
  });
});
