import { describe, expect, it } from "vitest";
import { headerRecord, parseWebhook } from "../src/shared/wire.js";

/**
 * Webhook boundary tests.
 *
 * This is the security-critical path — everything downstream trusts that a
 * delivery which reaches `enqueue` was really signed by Spectrum Cloud. The
 * signatures here are computed independently with Web Crypto (the same
 * algorithm the docs specify) rather than by calling the verifier, so these
 * are known-answer checks rather than the implementation agreeing with itself.
 */

const SECRET = "whsec_convex_component_test";
const NOW_SECONDS = 1_700_000_000;
const NOW_MS = NOW_SECONDS * 1000;

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const sign = async (
  body: Uint8Array,
  timestamp: number,
  secret = SECRET
): Promise<string> => {
  const prefix = encoder.encode(`v0:${timestamp}:`);
  const base = new Uint8Array(prefix.length + body.length);
  base.set(prefix, 0);
  base.set(body, prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return `v0=${hex(await crypto.subtle.sign("HMAC", key, base))}`;
};

const envelope = (overrides: Record<string, unknown> = {}) => ({
  event: "messages",
  space: { id: "chat-1", platform: "imessage" },
  message: {
    id: "m-1",
    platform: "imessage",
    direction: "inbound",
    timestamp: "2026-06-12T10:00:00.000Z",
    sender: { id: "u1", platform: "imessage" },
    space: { id: "chat-1", platform: "imessage" },
    content: { type: "text", text: "hello there" },
    ...overrides,
  },
});

const delivery = async (
  payload: unknown,
  opts: { secret?: string; timestamp?: number } = {}
) => {
  const body = encoder.encode(JSON.stringify(payload));
  const timestamp = opts.timestamp ?? NOW_SECONDS;
  return {
    bodyBytes: body,
    headers: {
      "x-spectrum-signature": await sign(body, timestamp, opts.secret),
      "x-spectrum-timestamp": String(timestamp),
      "content-type": "application/json",
    },
  };
};

describe("parseWebhook", () => {
  it("accepts a correctly signed delivery and flattens it", async () => {
    const signed = await delivery(envelope());
    const outcome = await parseWebhook({
      ...signed,
      secret: SECRET,
      now: NOW_MS,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.message).toMatchObject({
      spaceId: "chat-1",
      messageId: "m-1",
      platform: "imessage",
      senderId: "u1",
      content: { type: "text", text: "hello there" },
    });
  });

  it("rejects a body signed with the wrong secret", async () => {
    const signed = await delivery(envelope(), { secret: "not-the-secret" });
    const outcome = await parseWebhook({
      ...signed,
      secret: SECRET,
      now: NOW_MS,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.status).toBe(401);
  });

  it("rejects a tampered body whose signature no longer covers it", async () => {
    const signed = await delivery(envelope());
    const tampered = encoder.encode(
      JSON.stringify(envelope({ content: { type: "text", text: "evil" } }))
    );
    const outcome = await parseWebhook({
      bodyBytes: tampered,
      headers: signed.headers,
      secret: SECRET,
      now: NOW_MS,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.status).toBe(401);
  });

  it("rejects a replayed delivery outside the tolerance window", async () => {
    const stale = NOW_SECONDS - 301;
    const signed = await delivery(envelope(), { timestamp: stale });
    const outcome = await parseWebhook({
      ...signed,
      secret: SECRET,
      now: NOW_MS,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.status).toBe(401);
    expect(outcome.reason).toBe("expired");
  });

  it("rejects a delivery with no signature header as malformed", async () => {
    const body = encoder.encode(JSON.stringify(envelope()));
    const outcome = await parseWebhook({
      bodyBytes: body,
      headers: { "x-spectrum-timestamp": String(NOW_SECONDS) },
      secret: SECRET,
      now: NOW_MS,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.status).toBe(400);
  });

  it("rejects a fusor protobuf envelope with a clear message", async () => {
    // A protobuf body never starts with "{", which is how the two Spectrum
    // webhook formats are told apart (both carry the same signature header).
    const outcome = await parseWebhook({
      bodyBytes: new Uint8Array([0x0a, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]),
      headers: {},
      secret: SECRET,
      now: NOW_MS,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.status).toBe(400);
    expect(outcome.reason).toContain("fusor");
  });

  it("acknowledges an unroutable message instead of forcing a retry", async () => {
    // Well-formed per the wire schema, but carries no platform on either the
    // message or its space, so there is no provider to route it to. Retrying
    // will never fix that, so it must be acknowledged (200) rather than
    // redelivered forever.
    const signed = await delivery({
      event: "messages",
      message: {
        id: "m-2",
        content: { type: "text", text: "orphan" },
        space: { id: "chat-9" },
      },
    });
    const outcome = await parseWebhook({
      ...signed,
      secret: SECRET,
      now: NOW_MS,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.status).toBe(200);
  });

  it("treats a message with no space id as malformed", async () => {
    // `space.id` is required by the wire schema, so this never reaches the
    // routing stage — it is poison, and 400 marks it non-retryable.
    const signed = await delivery({
      event: "messages",
      message: {
        id: "m-3",
        platform: "imessage",
        content: { type: "text", text: "orphan" },
        space: {},
      },
    });
    const outcome = await parseWebhook({
      ...signed,
      secret: SECRET,
      now: NOW_MS,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.status).toBe(400);
    // The reason names the shape received, so a wire-format mismatch is
    // diagnosable from the response alone rather than being an opaque 400.
    expect(outcome.reason).toContain("malformed payload");
    expect(outcome.reason).toContain("event=messages");
  });

  it("preserves unknown content types rather than rejecting them", async () => {
    // The wire format is additive: a content arm this SDK has never seen must
    // still be delivered, not dropped at the boundary.
    const signed = await delivery(
      envelope({ content: { type: "some-future-thing", payload: 1 } })
    );
    const outcome = await parseWebhook({
      ...signed,
      secret: SECRET,
      now: NOW_MS,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.message.content).toEqual({
      type: "some-future-thing",
      payload: 1,
    });
  });
});

describe("headerRecord", () => {
  it("lowercases header names so signature lookup is case-insensitive", () => {
    const headers = new Headers({
      "X-Spectrum-Signature": "v0=abc",
      "X-Spectrum-Timestamp": "123",
    });
    expect(headerRecord(headers)).toEqual({
      "x-spectrum-signature": "v0=abc",
      "x-spectrum-timestamp": "123",
    });
  });
});

describe("routing metadata", () => {
  it("carries the line and chat type through to the space registry", async () => {
    // iMessage sends route by `phone` in dedicated multi-line mode, and inbound
    // is the only place it is ever learned.
    const signed = await delivery({
      event: "messages",
      space: { id: "chat-1", platform: "imessage" },
      message: {
        id: "m-routed",
        platform: "imessage",
        sender: { id: "u1" },
        space: {
          id: "chat-1",
          platform: "imessage",
          phone: "+15551234567",
          type: "group",
        },
        content: { type: "text", text: "hi" },
      },
    });
    const outcome = await parseWebhook({
      ...signed,
      secret: SECRET,
      now: NOW_MS,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.message.phone).toBe("+15551234567");
    expect(outcome.message.spaceType).toBe("group");
  });

  it("omits routing metadata when the platform does not send it", async () => {
    const outcome = await parseWebhook({
      ...(await delivery(envelope())),
      secret: SECRET,
      now: NOW_MS,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.message.phone).toBeUndefined();
    expect(outcome.message.spaceType).toBeUndefined();
  });
});
