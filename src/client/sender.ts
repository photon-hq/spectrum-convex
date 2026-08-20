import type { Content } from "@spectrum-ts/core";
import type {
  IMessageClient,
  RemoteClient,
} from "@spectrum-ts/imessage/remote";
import {
  clientForPhone,
  createCloudClients,
  getRemoteAttachment,
  markRead,
  reactToMessage,
  replyToMessage,
  send as sendRemote,
  startTyping,
} from "@spectrum-ts/imessage/remote";

/**
 * The gRPC transport, for use from an app-owned Node action.
 *
 * This file must only ever be imported from a `"use node"` module. iMessage
 * sends speak gRPC over HTTP/2, which Convex's default V8 runtime cannot do —
 * and because a `"use node"` file may contain only actions, the transport
 * cannot live inside the component at all (the component is queries and
 * mutations). So the app owns a thin action, and the component reaches it
 * through a function handle.
 *
 * Everything below is deliberately behind the `Sender` interface: if Spectrum
 * Cloud grows an HTTPS send endpoint, a fetch-based implementation replaces
 * this file and the pipeline moves wholesale into the V8 runtime with no
 * schema or API change.
 */

/** The payload the component hands to a sender. */
export interface SendJob {
  /** Idempotency key — must reach the provider verbatim. */
  clientGuid: string;
  content?: unknown;
  kind: string;
  phone?: string;
  reaction?: string;
  rowId: string;
  spaceId: string;
  /**
   * The target message's content, supplied by the component. Tapbacks need a
   * `Message`-shaped target (`id` + `content`), not just an id.
   */
  targetContent?: unknown;
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
 * Cached clients, keyed by project id.
 *
 * Convex reuses a Node action's container across invocations, so minting
 * tokens and opening gRPC channels once per container — rather than once per
 * send — is the difference between a warm send and a multi-round-trip cold
 * start on every reply.
 */
const clientCache = new Map<string, Promise<IMessageClient>>();

const resolveClients = (
  projectId: string,
  projectSecret: string
): Promise<IMessageClient> => {
  const cached = clientCache.get(projectId);
  if (cached) {
    return cached;
  }
  const created = createCloudClients(projectId, projectSecret).catch(
    (error: unknown) => {
      // Never cache a failed handshake, or one bad startup poisons the
      // container for its whole lifetime.
      clientCache.delete(projectId);
      throw error;
    }
  );
  clientCache.set(projectId, created);
  return created;
};

const pickClient = (clients: RemoteClient[], phone: string | undefined) => {
  // `clientForPhone` handles shared mode (one line serves everything) and
  // dedicated mode (route by number) identically to the platform's own path.
  const routed = phone ?? clients[0]?.phone;
  if (!routed) {
    throw new Error("no iMessage lines are configured for this project");
  }
  return clientForPhone(clients, routed);
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Build a sender backed by Spectrum Cloud's gRPC endpoints.
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
    async deliver(job: SendJob): Promise<SendOutcome> {
      if (!(projectId && projectSecret)) {
        return {
          ok: false,
          error:
            "SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET must be set for the iMessage sender",
        };
      }

      try {
        const clients = await resolveClients(projectId, projectSecret);
        const remote = pickClient(clients, job.phone);

        switch (job.kind) {
          case "send": {
            const record = await sendRemote(
              remote,
              job.spaceId,
              job.content as Content
            );
            return { ok: true, providerMessageId: record.id };
          }
          case "reply": {
            if (!job.targetMessageId) {
              return { ok: false, error: "reply requires a targetMessageId" };
            }
            const record = await replyToMessage(
              remote,
              job.spaceId,
              job.targetMessageId,
              job.content as Content
            );
            return { ok: true, providerMessageId: record.id };
          }
          case "react": {
            if (!(job.targetMessageId && job.reaction)) {
              return {
                ok: false,
                error: "react requires a targetMessageId and a reaction",
              };
            }
            if (job.targetContent === undefined) {
              // Validated before the call rather than after: the provider
              // rejects a target without content, and failing here gives a
              // usable message instead of a schema error from deep inside.
              return {
                ok: false,
                error: `react target "${job.targetMessageId}" is not a known inbound message`,
              };
            }
            const record = await reactToMessage(
              remote,
              job.spaceId,
              {
                id: job.targetMessageId,
                content: job.targetContent,
              } as Parameters<typeof reactToMessage>[2],
              job.reaction
            );
            return { ok: true, providerMessageId: record.id };
          }
          case "markRead": {
            await markRead(remote, job.spaceId);
            return { ok: true };
          }
          case "typing": {
            await startTyping(remote, job.spaceId);
            return { ok: true };
          }
          default:
            return { ok: false, error: `unsupported send kind "${job.kind}"` };
        }
      } catch (error) {
        // Reported, not thrown: the outbox decides whether to retry, and it
        // re-uses the same clientGuid so a send that actually landed before
        // the error cannot post twice.
        return { ok: false, error: errorText(error) };
      }
    },

    async close(): Promise<void> {
      // Intentionally a no-op for the cached clients: the container may
      // handle another send, and tearing the channels down here would force a
      // fresh token mint and handshake on the very next invocation.
    },
  };
}

/**
 * Download an inbound attachment's bytes.
 *
 * The native webhook delivers attachment *metadata* only, so the bytes have to
 * be pulled over gRPC on demand — another Node-runtime-only operation. The
 * result is returned as a `Blob` so the calling action can hand it straight to
 * `ctx.storage.store()`; Convex documents cap at 1 MiB, so attachment bytes
 * belong in file storage, never in a table.
 *
 * Returns `undefined` when the provider does not recognise the guid.
 */
export async function fetchAttachment(
  attachmentId: string,
  opts: CloudSenderOptions & { phone?: string } = {}
): Promise<{ blob: Blob; name: string; mimeType: string } | undefined> {
  const projectId = opts.projectId ?? process.env.SPECTRUM_PROJECT_ID;
  const projectSecret =
    opts.projectSecret ?? process.env.SPECTRUM_PROJECT_SECRET;
  if (!(projectId && projectSecret)) {
    throw new Error(
      "SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET must be set to fetch attachments"
    );
  }

  const clients = await resolveClients(projectId, projectSecret);
  const remote = pickClient(clients, opts.phone);
  const attachment = await getRemoteAttachment(remote, attachmentId);
  if (!attachment) {
    return;
  }

  const bytes = await attachment.read();
  return {
    blob: new Blob([new Uint8Array(bytes)], { type: attachment.mimeType }),
    name: attachment.name,
    mimeType: attachment.mimeType,
  };
}

export { editMessage } from "@spectrum-ts/imessage/remote";
