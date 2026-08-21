# @spectrum-ts/convex

A [Convex](https://convex.dev) component for [Spectrum](https://photon.codes/spectrum) iMessage.

Convex can't run Spectrum's `for await (… of app.messages)` loop — that needs a long-lived process. And the usual webhook escape hatch doesn't fit either: `app.webhook()` dispatches its handler *after* the HTTP response, but a Convex isolate is frozen the moment the response is returned.

This component inverts that. A delivery is verified and written to a table **before** the 200 goes back, so an acknowledged message is already durable. Everything after that runs on Convex's scheduler.

It also ships the production pipeline from Photon's [architecture guide](https://photon.codes/docs/best-practices/architecture) — burst debouncing, in-flight cancellation, carry-forward, and paced sends — rather than leaving you to rebuild it.

## Install

```sh
npm i @spectrum-ts/convex
```

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import spectrum from "@spectrum-ts/convex/convex.config";

const app = defineApp();
app.use(spectrum);
export default app;
```

Set these in the Convex dashboard:

| Variable | Where | Purpose |
|---|---|---|
| `SPECTRUM_WEBHOOK_SECRET` | app | Verifies the native webhook's HMAC |
| `SPECTRUM_PROJECT_ID` | app | Spectrum Cloud project |
| `SPECTRUM_PROJECT_SECRET` | app | Spectrum Cloud secret |

## Use

```ts
// convex/spectrum.ts
import { Spectrum } from "@spectrum-ts/convex";
import { components, internal } from "./_generated/api";

export const spectrum = new Spectrum(components.spectrum, {
  onBatch: internal.agent.respond,
  sender: internal.sender.deliver,
  debounceMs: 5000,
  pacingMs: 800,
});
```

```ts
// convex/http.ts — POST https://<deployment>.convex.site/spectrum/webhook
import { httpRouter } from "convex/server";
import { spectrum } from "./spectrum";

const http = httpRouter();
spectrum.registerRoutes(http);
export default http;
```

```ts
// convex/agent.ts — one invocation per settled burst
export const respond = internalAction({
  args: { spaceId: v.string(), chainId: v.string(), messages: v.array(v.any()), carried: v.array(v.any()) },
  handler: async (ctx, args) => {
    const reply = await generate(args.messages, args.carried);

    // The scheduler can't interrupt a running action, so re-check after
    // anything slow.
    if (await spectrum.isCancelled(ctx, args)) return null;

    await spectrum.send(ctx, { spaceId: args.spaceId, chainId: args.chainId, content: { type: "text", text: reply } });
    await spectrum.completeChain(ctx, args);
    return null;
  },
});
```

See [`example/`](./example) for a complete app, including the sender.

## How the pipeline behaves

```
webhook ──▶ verify + enqueue (durable) ──▶ 200
                     │
                     ├─ dedupe on message id (deliveries are at-least-once)
                     └─ start a turn
                                │
                                ▶ your onBatch handler
                                        │
                                        ▶ outbox ─▶ sender ─▶ iMessage
```

### Choosing a turn policy

The component does not impose a conversation model. Pick one with `mode`:

| `mode` | Behaviour | Use when |
|---|---|---|
| `"immediate"` *(default)* | Every message is handled on its own. N messages → N handler calls. `messages` always has one entry, `carried` is always empty. | Replies are cheap and answering each message is correct — echo bots, commands, notifications. |
| `"collapse"` | A burst becomes one turn. A new message supersedes the in-flight turn, cancels any reply that hasn't shipped, and carries its messages forward as prior context. | Replies are expensive (an LLM call), or answering each message separately would read as the agent talking over itself. |

```ts
new Spectrum(components.spectrum, {
  onBatch: internal.agent.respond,
  sender: internal.sender.deliver,
  mode: "collapse",   // default is "immediate"
  debounceMs: 0,      // optional extra settling window, collapse mode only
});
```

`debounceMs` is a latency cost on every reply, so it defaults to 0 — in
collapse mode, cancellation already absorbs most bursts on its own, because a
follow-up usually arrives while the previous reply is still in flight.

### Guarantees in both modes

- **At-least-once deliveries are deduped** on the provider message id.
- **Read receipts and typing indicators never start a turn.** Otherwise a bot
  replies to the read receipt for its own last message and echoes forever.
- **Sends are deduped at the outbox.** Each row carries a `clientGuid` derived
  from `(chainId, seq)`, so the same logical send is never queued twice.
  <br>**Caveat:** the guid is *not* forwarded to the provider. Spectrum's send
  path does not accept a caller-supplied `clientMessageId`, and the SDK's
  `autoIdempotency` mints a fresh key per call — so a retry after a lost
  acknowledgement can still post twice. Closing that needs an SDK change to
  thread the key through.
- **Messages are never dropped.** One rule governs the pipeline: *a message is
  spent only when a reply actually reaches the user* — not when it is drained,
  and not when the handler returns. A handler that has finished has only
  *queued* its reply; a follow-up moments later can still cancel it. Until a
  send is confirmed, every message stays recoverable. Verified live across two
  back-to-back supersessions.

## Sending

Sends go through the outbox to a gRPC transport running in a Node action your
app owns. gRPC is the transport for both directions — the SDK's HTTP client has
no `subscribeEvents` / `EventsResource`, so it cannot serve inbound.

Two pieces of setup are required, and **sends fail without them**:

**1. Depend on the provider and the gRPC peers.** `@spectrum-ts/imessage` is an
*optional* peer of this package, so it is not installed for you:

```sh
npm i @spectrum-ts/imessage @photon-ai/advanced-imessage nice-grpc nice-grpc-common @grpc/grpc-js
```

**2. Mark them external, and force-reference the peers.** `createGrpcClient`
requires its peers resolvable at *runtime*, not merely bundled:

```json
// convex.json
{
  "node": {
    "externalPackages": [
      "@photon-ai/advanced-imessage",
      "nice-grpc",
      "nice-grpc-common",
      "@grpc/grpc-js"
    ]
  }
}
```

```ts
// convex/_workaround.ts — nothing imports this; it exists so the packages ship
"use node";
export * as _grpcJs from "@grpc/grpc-js";
export * as _niceGrpc from "nice-grpc";
export * as _niceGrpcCommon from "nice-grpc-common";
```

That second file is not optional. Convex installs an `externalPackages` entry
only if the *bundled code imports it*, and these three are optional peers of
`@photon-ai/advanced-imessage` loaded dynamically from inside that package — so
nothing in the bundle references them and they are silently never installed.
`createGrpcClient` then fails its `import.meta.resolve` check with a misleading
"install the peer dependencies" error even though they are in your
`package.json`. The re-export gives the bundler the static reference it needs.

```ts
// convex/sender.ts
"use node";
import { createCloudSender } from "@spectrum-ts/convex/sender";

const sender = createCloudSender(); // one Spectrum() instance per container
```

The sender drives the ordinary `Spectrum()` runtime. It is built to be
long-lived, which looks wrong for request-scoped execution, but measured it
costs ~35ms more to construct than the low-level alternative, tears down in
~1ms, and leaves no active handles — and caching one instance per container
removes even that on warm invocations.

### Content limitation

`ContentInput` is `string | ContentBuilder`: the runtime is designed for
in-process composition, where you call `text("hi")` and hand the builder to
`send()`. A durable outbox has to serialize content to JSON and replay it
later, and there is **no public way to send a resolved `Content` back**.

So the sender rebuilds what round-trips cleanly — **text and markdown** — and
throws a clear error for anything else rather than silently sending the wrong
thing. Attachments, polls and other rich arms would need either a JSON→builder
mapper here or an SDK change accepting resolved content.

`reply`, `react` and `markRead` address an existing message, which the public
API models as a `Message` rather than an id, so each costs an extra
`space.getMessage()` round trip (~570ms measured).

<sub>Note: `node.externalPackages` is not honoured by the anonymous local backend
(`CONVEX_AGENT_MODE=anonymous`) — the peers are never installed there regardless
of this setup. Use a cloud dev deployment to test sends.</sub>

## Verified behaviour

Tested against a real Convex deployment (`convex dev`, local backend) with
HMAC-signed webhook deliveries:

| Behaviour | Result |
|---|---|
| Forged signature | `401 signature-mismatch`, nothing stored |
| Signed delivery | `200`, durable before the response returns |
| Redelivery of a seen message id | Deduped — 3 rows from 4 deliveries |
| Burst of 3 within the window | One flush, one chain, one handler invocation |
| Batch handler dispatch | Ran via function handle with `messages` + `carried` |
| Outbound send | Queued with deterministic `clientGuid` `<chainId>#0` |
| gRPC transport | Reached Spectrum Cloud from a Convex Node action — server validated the chat guid and applied its target policy |
| Send failure | Captured in `lastError`, retried with backoff |
| Transport | The ordinary `Spectrum()` runtime, one instance cached per container |

The final send returned `[spectrum-imessage] Target not allowed for this
project` for a reserved fictional number — a server-side policy response, which
means the whole chain (token mint, TLS, gRPC, auth, request validation) worked.

## Docs

[`docs/integration.mdx.vel`](./docs/integration.mdx.vel) is the docs.photon.codes
page for this component, staged here rather than in `spectrum-ts/docs` — that
directory is rendered from `main`, so putting it there publishes it. It ships
once this package is on npm and this repo is public; the file header has the
steps.

## Testing against the component

Apps that install the component register it with `convex-test` explicitly —
its schema and function modules are not part of the app's own glob:

```ts
// convex/setup.test.ts
import { convexTest } from "convex-test";
import spectrum from "@spectrum-ts/convex/test";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

export function initConvexTest() {
  const t = convexTest(schema, modules);
  spectrum.register(t);
  return t;
}
```

`register(t, name?)` defaults to `"spectrum"` — pass the name you installed
under if you changed it in `convex.config.ts`.

## Development

This is a single npm package: the root `package.json` owns both the component
and the example app in `example/`, and root `convex.json` points `functions` at
`example/convex`. There is no separate install inside `example/`.

```sh
npm install
npm run dev       # codegen + build in watch, alongside `convex dev`
```

`npm run dev` runs three things the component needs in order — component
codegen, the package build, then `convex dev --typecheck-components` against the
example app. To do a one-off instead:

```sh
npm run build:codegen   # convex codegen + tsc
npm test
npm run typecheck       # package and example/convex
npm run check           # biome
```

`src/component/_generated/` is committed. It holds `component.ts`, the
`ComponentApi` type the client re-exports, so regenerate and commit it whenever
a component validator changes — `npm run build:codegen` does both.

Publishing is documented in [PUBLISHING.md](./PUBLISHING.md).

> **Local development against an SDK checkout.** `tsconfig.json` maps
> `@spectrum-ts/*` types to a sibling `spectrum-ts` checkout's built
> declarations, so TypeScript uses those rather than checking the SDK's source
> under this project's `lib` settings. It is inert without that checkout —
> TypeScript falls back to normal node resolution when a mapping doesn't
> resolve — so a plain `npm install` works unchanged.

## License

MIT © [Photon](https://photon.codes)
