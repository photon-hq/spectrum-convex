import type { DefaultFunctionArgs, FunctionReference } from "convex/server";

/**
 * The component's public function surface, as seen from the installing app.
 *
 * Hand-written rather than re-exported from the component's `_generated/api`
 * because the app addresses these through `components.spectrum.*`, whose type
 * is produced by the *app's* codegen. Declaring the shape here lets the client
 * class stay fully typed without the app having to thread generated types back
 * into the package.
 */

type Mutation<Args extends DefaultFunctionArgs, Return> = FunctionReference<
  "mutation",
  "internal",
  Args,
  Return
>;
type Query<Args extends DefaultFunctionArgs, Return> = FunctionReference<
  "query",
  "internal",
  Args,
  Return
>;

export interface EnqueueResult {
  clientGuid?: string;
  queued: boolean;
  reason?: string;
}

export interface SpaceRecord {
  lastInboundAt: number;
  phone?: string;
  platform: string;
  spaceId: string;
  type?: "dm" | "group";
}

export interface StoredMessage {
  content: unknown;
  messageId: string;
  receivedAt: number;
  senderId?: string;
  status: string;
  timestamp?: string;
}

export interface OutboxRecord {
  attempts: number;
  clientGuid: string;
  kind: string;
  lastError?: string;
  providerMessageId?: string;
  queuedAt: number;
  sentAt?: number;
  status: string;
}

export interface ComponentApi {
  inbound: {
    enqueue: Mutation<
      {
        spaceId: string;
        messageId: string;
        platform: string;
        senderId?: string;
        content: unknown;
        timestamp?: string;
        raw?: unknown;
        triggersTurn?: boolean;
        phone?: string;
        spaceType?: "dm" | "group";
        debounceMs?: number;
        mode?: "immediate" | "collapse";
        onBatch?: string;
      },
      { deduped: boolean; cancelledChain?: string }
    >;
    getSpace: Query<{ spaceId: string }, SpaceRecord | null>;
    listMessages: Query<{ spaceId: string; limit?: number }, StoredMessage[]>;
  };
  outbox: {
    enqueue: Mutation<
      {
        spaceId: string;
        chainId?: string;
        kind: "send" | "reply" | "react" | "markRead" | "typing";
        content?: unknown;
        targetMessageId?: string;
        reaction?: string;
        pacingMs?: number;
        sender?: string;
      },
      EnqueueResult
    >;
    settle: Mutation<
      {
        rowId: string;
        ok: boolean;
        providerMessageId?: string;
        error?: string;
        sender?: string;
      },
      null
    >;
    list: Query<{ spaceId: string; limit?: number }, OutboxRecord[]>;
  };
  pipeline: {
    isCancelled: Query<{ spaceId: string; chainId: string }, boolean>;
    completeChain: Mutation<{ spaceId: string; chainId: string }, null>;
    cancel: Mutation<{ spaceId: string }, string | null>;
  };
}
