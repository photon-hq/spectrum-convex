/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    inbound: {
      enqueue: FunctionReference<
        "mutation",
        "internal",
        {
          content: any;
          debounceMs?: number;
          messageId: string;
          mode?: "immediate" | "collapse";
          onBatch?: string;
          phone?: string;
          platform: string;
          raw?: any;
          senderId?: string;
          spaceId: string;
          spaceType?: "dm" | "group";
          timestamp?: string;
          triggersTurn?: boolean;
        },
        { cancelledChain?: string; deduped: boolean },
        Name
      >;
      getSpace: FunctionReference<
        "query",
        "internal",
        { spaceId: string },
        null | {
          lastInboundAt: number;
          phone?: string;
          platform: string;
          spaceId: string;
          type?: "dm" | "group";
        },
        Name
      >;
      listMessages: FunctionReference<
        "query",
        "internal",
        { limit?: number; spaceId: string },
        Array<{
          content: any;
          messageId: string;
          receivedAt: number;
          senderId?: string;
          status: string;
          timestamp?: string;
        }>,
        Name
      >;
    };
    outbox: {
      enqueue: FunctionReference<
        "mutation",
        "internal",
        {
          chainId?: string;
          content?: any;
          kind: "send" | "reply" | "react" | "markRead" | "typing";
          pacingMs?: number;
          reaction?: string;
          sender?: string;
          spaceId: string;
          targetMessageId?: string;
        },
        { clientGuid?: string; queued: boolean; reason?: string },
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { limit?: number; spaceId: string },
        Array<{
          attempts: number;
          clientGuid: string;
          kind: string;
          lastError?: string;
          providerMessageId?: string;
          queuedAt: number;
          sentAt?: number;
          status: string;
        }>,
        Name
      >;
      settle: FunctionReference<
        "mutation",
        "internal",
        {
          error?: string;
          ok: boolean;
          providerMessageId?: string;
          rowId: string;
          sender?: string;
        },
        null,
        Name
      >;
    };
    pipeline: {
      cancel: FunctionReference<
        "mutation",
        "internal",
        { spaceId: string },
        null | string,
        Name
      >;
      completeChain: FunctionReference<
        "mutation",
        "internal",
        { chainId: string; spaceId: string },
        null,
        Name
      >;
      isCancelled: FunctionReference<
        "query",
        "internal",
        { chainId: string; spaceId: string },
        boolean,
        Name
      >;
    };
  };
