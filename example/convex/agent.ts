import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { spectrum } from "./spectrum";

/**
 * Echo bot — one invocation per settled burst, not per message.
 *
 * `carried` holds messages an earlier, cancelled turn had already drained.
 * They are older than `messages`, so they are labelled as prior context rather
 * than folded into the current turn.
 */
export const respond = internalAction({
  args: {
    spaceId: v.string(),
    chainId: v.string(),
    messages: v.array(v.any()),
    carried: v.array(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const render = (m: { content?: unknown }): string => {
      const c = m.content as { type?: string; text?: string } | undefined;
      return c?.type === "text" ? (c.text ?? "") : `[${c?.type ?? "unknown"}]`;
    };

    const lines = [
      ...args.carried.map((m) => `[Earlier] ${render(m)}`),
      ...args.messages.map(render),
    ];
    const count = args.messages.length + args.carried.length;
    const reply =
      count > 1
        ? `echo (${count} messages):\n${lines.join("\n")}`
        : `echo: ${lines[0] ?? ""}`;

    // Let the sender know we've seen it before the reply lands.
    await spectrum.markRead(ctx, args);

    // A real agent calls an LLM here. Anything slow means a newer message may
    // have arrived meanwhile — the scheduler cannot interrupt a running action,
    // so re-check before speaking.
    if (await spectrum.isCancelled(ctx, args)) {
      return null;
    }

    await spectrum.send(ctx, {
      spaceId: args.spaceId,
      chainId: args.chainId,
      content: { type: "text", text: reply },
    });
    await spectrum.completeChain(ctx, args);
    return null;
  },
});
