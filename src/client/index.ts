import {
  createFunctionHandle,
  type FunctionReference,
  type FunctionReturnType,
  type HttpRouter,
  httpActionGeneric,
  type OptionalRestArgs,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import { headerRecord, parseWebhook } from "../shared/wire.js";

/**
 * App-facing client for the Spectrum component.
 *
 * Wraps the component's functions so app code never addresses them directly,
 * and runs in the app's own environment — which is what gives it access to
 * `process.env.SPECTRUM_WEBHOOK_SECRET` (a component's HTTP actions cannot read
 * the app's env vars).
 */

export const DEFAULT_WEBHOOK_PATH = "/spectrum/webhook";
const DEFAULT_DEBOUNCE_MS = 0;
const OK_STATUS = 200;
const SERVER_ERROR_STATUS = 500;

/** One inbound message as handed to a batch handler. */
export interface BatchMessage {
  content: unknown;
  messageId: string;
  senderId?: string;
  timestamp?: string;
}

/** The batch a handler is invoked with — one conversational turn. */
export interface Batch {
  /**
   * Messages a previous, cancelled turn had already drained. Present them as
   * earlier context rather than fresh input — the user has been waiting on
   * these longer than the ones in `messages`.
   */
  carried: BatchMessage[];
  chainId: string;
  /** Messages from this burst, oldest first. */
  messages: BatchMessage[];
  spaceId: string;
}

/**
 * Narrow a chain reference down to exactly the fields the component's
 * validators accept.
 *
 * Handlers are naturally called as `spectrum.isCancelled(ctx, args)` where
 * `args` is the whole batch — including `messages` and `carried`. Convex
 * rejects extra fields, so passing that through verbatim throws
 * `ArgumentValidationError`. Narrowing here keeps the ergonomic call working
 * instead of pushing the destructuring onto every caller.
 */
export const pickChain = (ref: {
  spaceId: string;
  chainId: string;
}): { spaceId: string; chainId: string } => ({
  spaceId: ref.spaceId,
  chainId: ref.chainId,
});

/**
 * Minimal structural ctx types — only the capability each method actually uses.
 *
 * Deliberately not `GenericQueryCtx<GenericDataModel> | …`. An app's ctx is
 * parameterised by *its* data model (`AnyDataModel` in a generated app), which
 * is not assignable to `GenericDataModel` because the index signatures differ.
 * Nor can these borrow the ctx types' own `runQuery`/`runMutation`: an action's
 * take no options while a mutation's accept `transactionLimits`. Declaring the
 * narrower shape both satisfy — in method syntax, so parameters stay bivariant
 * — accepts a ctx from a query, mutation or action alike.
 */
interface AnyCtx {
  runQuery<Query extends FunctionReference<"query", "public" | "internal">>(
    query: Query,
    ...args: OptionalRestArgs<Query>
  ): Promise<FunctionReturnType<Query>>;
}
interface RunMutationCtx {
  runMutation<
    Mutation extends FunctionReference<"mutation", "public" | "internal">,
  >(
    mutation: Mutation,
    ...args: OptionalRestArgs<Mutation>
  ): Promise<FunctionReturnType<Mutation>>;
}

/**
 * How inbound messages become turns.
 *
 * - `"immediate"` (default) — every message is handled on its own. No batching,
 *   no waiting, no supersession. Simple and predictable: N messages produce N
 *   handler calls. `batch.messages` always has exactly one entry and
 *   `batch.carried` is always empty.
 *
 * - `"collapse"` — a burst becomes one turn. A new message supersedes the
 *   in-flight turn, cancels any reply that has not shipped, and carries its
 *   messages into the next one as prior context. Use when replies are expensive
 *   (an LLM call) or when answering each message separately would read as the
 *   agent talking over itself.
 */
export type TurnMode = "immediate" | "collapse";

export interface SpectrumOptions {
  /**
   * Settling window before a turn is handled. Only meaningful in `"collapse"`
   * mode, where it widens the window in which a follow-up can join the same
   * turn. It is a latency cost on every reply, so leave it at 0 unless you
   * specifically need tighter grouping — cancellation already collapses most
   * bursts on its own.
   *
   * @default 0
   */
  debounceMs?: number;
  /**
   * How inbound messages become turns. See {@link TurnMode}.
   *
   * @default "immediate"
   */
  mode?: TurnMode;
  /**
   * The app function invoked once per settled burst. Usually an
   * `internalAction` so it can call an LLM.
   */
  onBatch?: FunctionReference<"action" | "mutation", "internal" | "public">;
  /** Delay between consecutive sends in one turn, so replies don't land at once. */
  pacingMs?: number;
  /**
   * The app action that actually talks to the provider. Required to deliver
   * sends; without it, outbox rows queue durably but never go out.
   */
  sender?: FunctionReference<"action" | "mutation", "internal" | "public">;
  /** @default "/spectrum/webhook" */
  webhookPath?: string;
  /**
   * Signing secret for native Spectrum webhooks. Falls back to
   * `process.env.SPECTRUM_WEBHOOK_SECRET`.
   */
  webhookSecret?: string;
}

export class Spectrum {
  readonly component: ComponentApi;
  readonly options: SpectrumOptions;

  constructor(component: ComponentApi, options: SpectrumOptions = {}) {
    this.component = component;
    this.options = options;
  }

  private get debounceMs(): number {
    return this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  private secret(): string | undefined {
    return this.options.webhookSecret ?? process.env.SPECTRUM_WEBHOOK_SECRET;
  }

  private async handleRef(): Promise<string | undefined> {
    return this.options.onBatch
      ? await createFunctionHandle(this.options.onBatch)
      : undefined;
  }

  private async senderRef(): Promise<string | undefined> {
    return this.options.sender
      ? await createFunctionHandle(this.options.sender)
      : undefined;
  }

  /**
   * Mount the webhook endpoint.
   *
   * The handler verifies and persists the delivery *before* answering 200, so
   * an acknowledged message is already durable. It deliberately does no work
   * after the response — on Convex the isolate is frozen once the response is
   * returned, which is exactly the trap `app.webhook()`'s fire-and-forget
   * handler falls into on serverless.
   */
  registerRoutes(http: HttpRouter, opts: { path?: string } = {}): void {
    const path = opts.path ?? this.options.webhookPath ?? DEFAULT_WEBHOOK_PATH;

    http.route({
      path,
      method: "POST",
      handler: httpActionGeneric(async (ctx, request) => {
        const secret = this.secret();
        if (!secret) {
          return new Response(
            "webhook secret not configured (set SPECTRUM_WEBHOOK_SECRET)",
            { status: SERVER_ERROR_STATUS }
          );
        }

        // Read the body ONCE, as bytes. The HMAC covers the exact bytes on the
        // wire, so parsing to JSON and re-encoding would break verification.
        const bodyBytes = new Uint8Array(await request.arrayBuffer());
        const outcome = await parseWebhook({
          bodyBytes,
          headers: headerRecord(request.headers),
          secret,
        });

        if (!outcome.ok) {
          return new Response(outcome.reason, { status: outcome.status });
        }

        const { message } = outcome;
        await ctx.runMutation(this.component.inbound.enqueue, {
          spaceId: message.spaceId,
          messageId: message.messageId,
          platform: message.platform,
          ...(message.senderId === undefined
            ? {}
            : { senderId: message.senderId }),
          content: message.content,
          ...(message.timestamp === undefined
            ? {}
            : { timestamp: message.timestamp }),
          ...(message.phone === undefined ? {} : { phone: message.phone }),
          ...(message.spaceType === undefined
            ? {}
            : { spaceType: message.spaceType }),
          triggersTurn: message.triggersTurn,
          mode: this.options.mode ?? "immediate",
          raw: message.raw,
          debounceMs: this.debounceMs,
          ...((await this.handleRef()) === undefined
            ? {}
            : { onBatch: await this.handleRef() }),
        });

        return new Response("ok", { status: OK_STATUS });
      }),
    });
  }

  /**
   * Has this turn been superseded by a newer message?
   *
   * `ctx.scheduler.cancel` can't stop an action that is already running, so a
   * handler doing slow work (generating, sending) should poll this between
   * steps and return early when it flips.
   */
  async isCancelled(
    ctx: AnyCtx,
    args: { spaceId: string; chainId: string }
  ): Promise<boolean> {
    return await ctx.runQuery(
      this.component.pipeline.isCancelled,
      pickChain(args)
    );
  }

  /** Queue an outbound message. Rejected if the chain was superseded. */
  async send(
    ctx: RunMutationCtx,
    args: {
      spaceId: string;
      content: unknown;
      chainId?: string;
      pacingMs?: number;
    }
  ): Promise<{ queued: boolean; clientGuid?: string; reason?: string }> {
    return await ctx.runMutation(this.component.outbox.enqueue, {
      spaceId: args.spaceId,
      kind: "send" as const,
      content: args.content,
      ...(args.chainId === undefined ? {} : { chainId: args.chainId }),
      pacingMs: args.pacingMs ?? this.options.pacingMs ?? 0,
      ...((await this.senderRef()) === undefined
        ? {}
        : { sender: await this.senderRef() }),
    });
  }

  /** Queue a threaded reply to a specific message. */
  async reply(
    ctx: RunMutationCtx,
    args: {
      spaceId: string;
      targetMessageId: string;
      content: unknown;
      chainId?: string;
      pacingMs?: number;
    }
  ): Promise<{ queued: boolean; clientGuid?: string; reason?: string }> {
    return await ctx.runMutation(this.component.outbox.enqueue, {
      spaceId: args.spaceId,
      kind: "reply" as const,
      content: args.content,
      targetMessageId: args.targetMessageId,
      ...(args.chainId === undefined ? {} : { chainId: args.chainId }),
      pacingMs: args.pacingMs ?? this.options.pacingMs ?? 0,
      ...((await this.senderRef()) === undefined
        ? {}
        : { sender: await this.senderRef() }),
    });
  }

  /** Queue a tapback on a message. */
  async react(
    ctx: RunMutationCtx,
    args: {
      spaceId: string;
      targetMessageId: string;
      reaction: string;
      chainId?: string;
    }
  ): Promise<{ queued: boolean; clientGuid?: string; reason?: string }> {
    return await ctx.runMutation(this.component.outbox.enqueue, {
      spaceId: args.spaceId,
      kind: "react" as const,
      targetMessageId: args.targetMessageId,
      reaction: args.reaction,
      ...(args.chainId === undefined ? {} : { chainId: args.chainId }),
      ...((await this.senderRef()) === undefined
        ? {}
        : { sender: await this.senderRef() }),
    });
  }

  /** Mark a conversation read. */
  async markRead(
    ctx: RunMutationCtx,
    args: { spaceId: string; chainId?: string }
  ): Promise<{ queued: boolean; clientGuid?: string; reason?: string }> {
    return await ctx.runMutation(this.component.outbox.enqueue, {
      spaceId: args.spaceId,
      kind: "markRead" as const,
      ...(args.chainId === undefined ? {} : { chainId: args.chainId }),
      ...((await this.senderRef()) === undefined
        ? {}
        : { sender: await this.senderRef() }),
    });
  }

  /** Mark a turn's messages handled. Call when the handler finishes. */
  async completeChain(
    ctx: RunMutationCtx,
    args: { spaceId: string; chainId: string }
  ): Promise<void> {
    await ctx.runMutation(
      this.component.pipeline.completeChain,
      pickChain(args)
    );
  }

  /** Routing record for a space (`phone`, chat type), or `null`. */
  async getSpace(
    ctx: AnyCtx,
    args: { spaceId: string }
  ): Promise<{
    spaceId: string;
    platform: string;
    phone?: string;
    type?: "dm" | "group";
    lastInboundAt: number;
  } | null> {
    return await ctx.runQuery(this.component.inbound.getSpace, args);
  }

  /** Recent inbound messages for a space, oldest first. */
  async listMessages(
    ctx: AnyCtx,
    args: { spaceId: string; limit?: number }
  ): Promise<BatchMessage[]> {
    return await ctx.runQuery(this.component.inbound.listMessages, args);
  }

  /** Outbox rows for a space — delivery status and failure audit trail. */
  async listOutbox(
    ctx: AnyCtx,
    args: { spaceId: string; limit?: number }
  ): Promise<
    {
      clientGuid: string;
      kind: string;
      status: string;
      attempts: number;
      queuedAt: number;
      sentAt?: number;
      providerMessageId?: string;
      lastError?: string;
    }[]
  > {
    return await ctx.runQuery(this.component.outbox.list, args);
  }

  /** Report a send's outcome back to the outbox. Called by the sender action. */
  async settle(
    ctx: RunMutationCtx,
    args: {
      rowId: string;
      ok: boolean;
      providerMessageId?: string;
      error?: string;
    }
  ): Promise<void> {
    await ctx.runMutation(this.component.outbox.settle, {
      ...args,
      ...((await this.senderRef()) === undefined
        ? {}
        : { sender: await this.senderRef() }),
    });
  }
}

export type { ComponentApi } from "../component/_generated/component.js";
export { headerRecord, parseWebhook } from "../shared/wire.js";
