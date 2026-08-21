import type { ContentInput } from "@spectrum-ts/core";
import { markdown, Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";

/**
 * The iMessage transport, for use from an app-owned Node action.
 *
 * This file must only ever be imported from a `"use node"` module. iMessage
 * speaks gRPC over HTTP/2, which Convex's default V8 runtime cannot do — and
 * because a `"use node"` file may contain only actions, the transport cannot
 * live inside the component at all (the component is queries and mutations).
 * So the app owns a thin action and the component reaches it by function handle.
 *
 * It drives the ordinary `Spectrum()` runtime rather than any lower-level API.
 * `Spectrum()` is built to be long-lived — it opens gRPC channels and rotates
 * tokens in the background — which looks like a poor fit for request-scoped
 * execution. Measured against the low-level alternative, though, it costs about
 * 35ms more to construct, tears down in ~1ms, and leaves no active handles.
 * Caching one instance per container removes even that on warm invocations.
 */

/** The payload the component hands to a sender. */
export interface SendJob {
  /**
   * The outbox's idempotency key. NOT currently forwarded to the provider —
   * see the note on `deliver`.
   */
  clientGuid: string;
  content?: unknown;
  kind: string;
  phone?: string;
  reaction?: string;
  rowId: string;
  spaceId: string;
  targetMessageId?: string;
}

export interface SendOutcome {
  error?: string;
  ok: boolean;
  providerMessageId?: string;
}

/** The transport contract the component depends on. */
export interface Sender {
  close(): Promise<void>;
  deliver(job: SendJob): Promise<SendOutcome>;
}

export interface CloudSenderOptions {
  projectId?: string;
  projectSecret?: string;
}

/**
 * One Spectrum instance per container, keyed by project.
 *
 * Convex reuses a Node action's container across invocations, so building the
 * runtime once rather than per send is the difference between a warm send and a
 * fresh token mint plus gRPC handshake every time.
 */
const startRuntime = (projectId: string, projectSecret: string) =>
  Spectrum({
    projectId,
    projectSecret,
    providers: [imessage.config()],
  });

/**
 * The instance type is inferred from the provider list rather than written as
 * the generic `SpectrumInstance`, so `imessage(app)` can narrow to the iMessage
 * platform instance. Annotating it loosely collapses that narrowing to `never`.
 */
type IMessageApp = Awaited<ReturnType<typeof startRuntime>>;

const instances = new Map<string, Promise<IMessageApp>>();

const runtime = (
  projectId: string,
  projectSecret: string
): Promise<IMessageApp> => {
  const cached = instances.get(projectId);
  if (cached) {
    return cached;
  }
  const created = startRuntime(projectId, projectSecret).catch(
    (error: unknown) => {
      // Never cache a failed startup, or one bad boot poisons the container for
      // its whole lifetime.
      instances.delete(projectId);
      throw error;
    }
  );
  instances.set(projectId, created);
  return created;
};

/**
 * Rehydrate stored content into something the public API accepts.
 *
 * `ContentInput` is `string | ContentBuilder` — the runtime is built for
 * in-process composition, where you call `text("hi")` and pass the builder
 * straight to `send()`. A durable outbox has to serialize content to JSON and
 * replay it later, and there is no public way to send a resolved `Content`
 * back. So the arms that round-trip through JSON are reconstructed here, and
 * anything else fails loudly rather than silently sending the wrong thing.
 */
const toContentInput = (content: unknown): ContentInput => {
  const value = content as { type?: string; text?: string } | undefined;
  if (typeof content === "string") {
    return content;
  }
  if (value?.type === "text" && typeof value.text === "string") {
    // A bare string is itself a valid ContentInput and renders as text.
    return value.text;
  }
  if (value?.type === "markdown" && typeof value.text === "string") {
    return markdown(value.text);
  }
  throw new Error(
    `cannot rebuild content of type "${value?.type ?? typeof content}" from the outbox — ` +
      "Spectrum's send API takes builders, not stored content, so only text and " +
      "markdown survive serialization today"
  );
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const NEEDS_TARGET = "requires a targetMessageId";

const resolveSpace = async (
  projectId: string,
  projectSecret: string,
  spaceId: string,
  phone?: string
) => {
  const app = await runtime(projectId, projectSecret);
  // No server round trip: an iMessage guid already encodes the chat type, and
  // sends route by `phone`.
  return await imessage(app).space.get(spaceId, phone ? { phone } : undefined);
};

type ResolvedSpace = Awaited<ReturnType<typeof resolveSpace>>;

/**
 * Perform a verb that addresses an existing message.
 *
 * Replies, reactions and read receipts all identify their subject as a
 * `Message` rather than a bare id, so each costs a `space.getMessage()` lookup
 * before it can act.
 */
const deliverTargeted = async (
  space: ResolvedSpace,
  job: SendJob
): Promise<SendOutcome> => {
  if (!job.targetMessageId) {
    return { ok: false, error: `${job.kind} ${NEEDS_TARGET}` };
  }
  const target = await space.getMessage(job.targetMessageId);
  if (!target) {
    return {
      ok: false,
      error: `message "${job.targetMessageId}" was not found in this chat`,
    };
  }

  if (job.kind === "reply") {
    const sent = await target.reply(toContentInput(job.content));
    return {
      ok: true,
      ...(sent?.id === undefined ? {} : { providerMessageId: sent.id }),
    };
  }
  if (job.kind === "react") {
    if (!job.reaction) {
      return { ok: false, error: "react requires a reaction" };
    }
    await target.react(job.reaction);
    return { ok: true };
  }
  if (job.kind === "markRead") {
    // iMessage marks read at chat level; the target only says which chat.
    await target.read();
    return { ok: true };
  }
  return { ok: false, error: `unsupported send kind "${job.kind}"` };
};

/**
 * Build a sender backed by Spectrum Cloud.
 *
 * Credentials come from the environment (`SPECTRUM_PROJECT_ID` /
 * `SPECTRUM_PROJECT_SECRET`) so a secret never travels in a scheduled-function
 * argument or shows up in a log line.
 */
export function createCloudSender(options: CloudSenderOptions = {}): Sender {
  const projectId = options.projectId ?? process.env.SPECTRUM_PROJECT_ID;
  const projectSecret =
    options.projectSecret ?? process.env.SPECTRUM_PROJECT_SECRET;

  return {
    /**
     * Perform one outbound action.
     *
     * NOTE: `job.clientGuid` is not forwarded to the provider. Spectrum's send
     * path does not accept a caller-supplied `clientMessageId`, and the SDK's
     * `autoIdempotency` mints a fresh key per call, so a retry after a lost
     * acknowledgement can post twice. The guid still dedupes outbox rows.
     */
    async deliver(job: SendJob): Promise<SendOutcome> {
      if (!(projectId && projectSecret)) {
        return {
          ok: false,
          error:
            "SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET must be set for the iMessage sender",
        };
      }

      try {
        const space = await resolveSpace(
          projectId,
          projectSecret,
          job.spaceId,
          job.phone
        );

        if (job.kind === "send") {
          const sent = await space.send(toContentInput(job.content));
          return {
            ok: true,
            ...(sent?.id === undefined ? {} : { providerMessageId: sent.id }),
          };
        }
        if (job.kind === "typing") {
          await space.startTyping();
          return { ok: true };
        }
        return await deliverTargeted(space, job);
      } catch (error) {
        // Reported, not thrown: the outbox owns retry and backoff.
        return { ok: false, error: errorText(error) };
      }
    },

    async close(): Promise<void> {
      // Intentionally a no-op. The container may serve another send, and
      // stopping the runtime would force a fresh token mint and handshake on
      // the very next invocation.
    },
  };
}

/**
 * Download an inbound attachment's bytes.
 *
 * The native webhook delivers attachment *metadata* only, so the bytes are
 * fetched on demand by re-reading the message through the SDK — its attachment
 * content exposes a lazy `read()`. Returned as a `Blob` so the calling action
 * can hand it straight to `ctx.storage.store()`: Convex documents cap at 1 MiB,
 * so attachment bytes belong in file storage, never in a table.
 */
export async function fetchAttachment(
  args: { spaceId: string; messageId: string; phone?: string },
  opts: CloudSenderOptions = {}
): Promise<{ blob: Blob; name: string; mimeType: string } | undefined> {
  const projectId = opts.projectId ?? process.env.SPECTRUM_PROJECT_ID;
  const projectSecret =
    opts.projectSecret ?? process.env.SPECTRUM_PROJECT_SECRET;
  if (!(projectId && projectSecret)) {
    throw new Error(
      "SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET must be set to fetch attachments"
    );
  }

  const space = await resolveSpace(
    projectId,
    projectSecret,
    args.spaceId,
    args.phone
  );
  const message = await space.getMessage(args.messageId);
  const content = message?.content as
    | {
        type?: string;
        name?: string;
        mimeType?: string;
        read?: () => Promise<Buffer>;
      }
    | undefined;
  if (content?.type !== "attachment" || !content.read) {
    return;
  }

  const bytes = await content.read();
  const mimeType = content.mimeType ?? "application/octet-stream";
  return {
    blob: new Blob([new Uint8Array(bytes)], { type: mimeType }),
    name: content.name ?? "attachment",
    mimeType,
  };
}
