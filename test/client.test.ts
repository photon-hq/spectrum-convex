import { describe, expect, it } from "vitest";
import { pickChain } from "../src/client/index.js";

/**
 * Regression guard for a bug that unit tests missed and a live deployment
 * caught: handlers are naturally called as `spectrum.isCancelled(ctx, args)`
 * with the *whole* batch, but Convex validators reject unknown fields. If the
 * client stops narrowing, every real batch handler throws
 * `ArgumentValidationError` at runtime.
 */
describe("pickChain", () => {
  it("drops batch fields the component's validators would reject", () => {
    const batch = {
      spaceId: "chat-1",
      chainId: "chat-1:123:abc",
      messages: [{ messageId: "m1", content: { type: "text", text: "hi" } }],
      carried: [],
    };
    expect(pickChain(batch)).toEqual({
      spaceId: "chat-1",
      chainId: "chat-1:123:abc",
    });
    expect(Object.keys(pickChain(batch))).toHaveLength(2);
  });
});
