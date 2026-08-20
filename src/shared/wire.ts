import {
  type SlimEnvelope,
  slimEnvelopeSchema,
  verifySpectrumSignature,
} from "@spectrum-ts/core/webhook";

/**
 * The wire boundary, shared by the HTTP entry point and the tests.
 *
 * Everything here is runtime-agnostic — it runs in Convex's V8 isolate, which
 * has Web Crypto but no Node builtins. `@spectrum-ts/core/webhook` is the
 * portable slice of the SDK for exactly this reason; importing the main
 * `@spectrum-ts/core` entry here would pull `node:fs`/`node:crypto` through the
 * content builders and fail to evaluate.
 */

/** Normalized inbound message, flattened for storage. */
export interface InboundMessage {
  content: unknown;
  messageId: string;
  /**
   * Which line serves this conversation. iMessage sends route by it in
   * dedicated multi-line mode, and it is only ever learned from inbound —
   * there is no other source for it.
   */
  phone?: string;
  platform: string;
  raw: unknown;
  senderId?: string;
  spaceId: string;
  spaceType?: "dm" | "group";
  timestamp?: string;
  /**
   * Whether this delivery should start a conversational turn.
   *
   * False for signals — read receipts, typing indicators — which describe the
   * conversation rather than being input to it. They are stored, but must not
   * arm the debounce or feed a batch: a bot that replies to the read receipt
   * for its own last message generates the next read receipt, and echoes
   * forever.
   */
  triggersTurn: boolean;
}

export type ParseOutcome =
  | { ok: true; message: InboundMessage }
  | { ok: false; status: number; reason: string }
  // A well-formed delivery we deliberately acknowledge without storing (an
  // unknown event type, or a message we can't route). Retrying won't help, so
  // it must be a 200 or Spectrum Cloud will redeliver forever.
  | { ok: false; status: 200; reason: string; acknowledged: true };

const SIGNATURE_MISSING_STATUS = 400;
const SIGNATURE_INVALID_STATUS = 401;
const MALFORMED_STATUS = 400;
const OK_STATUS = 200;

/**
 * A native Spectrum webhook body is JSON; the fusor transport wraps a protobuf
 * envelope instead. The component only speaks the native format, so anything
 * that isn't a JSON object is rejected rather than silently mis-parsed.
 * Detection is by payload shape, not headers — both formats carry
 * `x-spectrum-signature`.
 */
const looksLikeNativePayload = (bodyBytes: Uint8Array): boolean => {
  for (const byte of bodyBytes) {
    // Skip leading ASCII whitespace (space, tab, LF, CR).
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      continue;
    }
    return byte === 0x7b; // "{"
  }
  return false;
};

/**
 * Describe an unparseable body by its structure alone — top-level keys, and the
 * `event`/`type` discriminator if present. Never includes values, which would
 * mean logging message content.
 */
const describeShape = (bodyBytes: Uint8Array): string => {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bodyBytes));
    if (typeof parsed !== "object" || parsed === null) {
      return `non-object body: ${typeof parsed}`;
    }
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).slice(0, 12).join(", ");
    const discriminator =
      typeof record.event === "string"
        ? ` event=${record.event}`
        : typeof record.type === "string"
          ? ` type=${record.type}`
          : "";
    return `top-level keys: ${keys}${discriminator}`;
  } catch {
    return "body is not valid JSON";
  }
};

/**
 * Content types that describe the conversation instead of contributing to it.
 * Kept as a denylist rather than an allowlist of "real" messages so that a
 * content arm this SDK predates still reaches the handler.
 */
const SIGNAL_CONTENT_TYPES: ReadonlySet<string> = new Set(["read", "typing"]);

const flatten = (envelope: SlimEnvelope): InboundMessage | undefined => {
  const { message } = envelope;
  const spaceId = message.space?.id ?? envelope.space?.id;
  if (!spaceId) {
    return;
  }
  const platform = message.platform ?? message.space?.platform;
  if (!platform) {
    return;
  }
  // The slim wire schemas are loose objects, so platform-specific space fields
  // (iMessage's `phone`, the chat `type`) survive parsing and can be picked off
  // here without the schema having to know about them.
  const space = (message.space ?? {}) as { phone?: unknown; type?: unknown };
  const phone = typeof space.phone === "string" ? space.phone : undefined;
  const spaceType =
    space.type === "dm" || space.type === "group" ? space.type : undefined;

  return {
    spaceId,
    messageId: message.id,
    platform,
    senderId: message.sender?.id,
    content: message.content,
    timestamp: message.timestamp,
    ...(phone === undefined ? {} : { phone }),
    ...(spaceType === undefined ? {} : { spaceType }),
    triggersTurn: !SIGNAL_CONTENT_TYPES.has(message.content.type),
    raw: envelope,
  };
};

/**
 * Verify and parse one native webhook delivery.
 *
 * Verification runs over the exact bytes received and BEFORE any parse, so a
 * forged body is rejected without its contents ever being interpreted. The
 * caller is responsible for reading the body as bytes exactly once — a
 * re-encoded (parsed-then-restringified) body changes the bytes and breaks the
 * HMAC.
 */
export async function parseWebhook(input: {
  bodyBytes: Uint8Array;
  headers: Record<string, string>;
  secret: string;
  now?: number;
}): Promise<ParseOutcome> {
  const { bodyBytes, headers, secret, now } = input;

  if (!looksLikeNativePayload(bodyBytes)) {
    return {
      ok: false,
      status: MALFORMED_STATUS,
      reason:
        "expected a native Spectrum webhook (JSON); the fusor protobuf transport is not supported by the Convex component",
    };
  }

  const verification = await verifySpectrumSignature({
    rawBody: bodyBytes,
    headers,
    secret,
    ...(now === undefined ? {} : { now }),
  });
  if (!verification.ok) {
    return {
      ok: false,
      status:
        verification.reason === "missing-headers"
          ? SIGNATURE_MISSING_STATUS
          : SIGNATURE_INVALID_STATUS,
      reason: verification.reason,
    };
  }

  let envelope: SlimEnvelope;
  try {
    envelope = slimEnvelopeSchema.parse(
      JSON.parse(new TextDecoder().decode(bodyBytes))
    );
  } catch (error) {
    // Name the shape we actually received. A bare "malformed payload" is
    // unactionable during bring-up — the usual cause is a wire schema this SDK
    // predates, and the top-level keys identify that immediately. Keys only,
    // never values: the body carries message text.
    return {
      ok: false,
      status: MALFORMED_STATUS,
      reason: `malformed payload (${describeShape(bodyBytes)}): ${
        error instanceof Error ? error.message.slice(0, 200) : "parse failed"
      }`,
    };
  }

  const message = flatten(envelope);
  if (!message) {
    return {
      ok: false,
      status: OK_STATUS,
      reason: "unroutable message (no space or platform)",
      acknowledged: true,
    };
  }

  return { ok: true, message };
}

/** Lowercase a Web `Headers` into the plain record the verifier expects. */
export const headerRecord = (headers: Headers): Record<string, string> => {
  const record: Record<string, string> = {};
  for (const [key, value] of headers) {
    record[key.toLowerCase()] = value;
  }
  return record;
};
