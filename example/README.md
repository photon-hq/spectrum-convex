# Example app

A complete Convex app wiring up `@spectrum-ts/convex`: webhook route, batch
handler, Node sender, and attachment storage.

## Run it

```sh
npm install
npx convex dev
```

The first `convex dev` run creates a deployment and generates `convex/_generated/`
for both the app and the component. **Until it has run once, these files
reference modules that don't exist yet**, so the example won't typecheck on a
fresh clone — that's expected, not a broken checkout. It's also why the root
`tsconfig.json` excludes this directory.

Then set the environment variables in the Convex dashboard:

```
SPECTRUM_WEBHOOK_SECRET=whsec_...
SPECTRUM_PROJECT_ID=...
SPECTRUM_PROJECT_SECRET=...
```

and point your Spectrum Cloud webhook at:

```
https://<deployment>.convex.site/spectrum/webhook
```

## What each file does

| File | Role |
|---|---|
| `convex.config.ts` | Installs the component |
| `spectrum.ts` | One shared client; wires `onBatch` and `sender` |
| `http.ts` | Mounts the webhook route |
| `agent.ts` | Batch handler — one invocation per conversational turn |
| `sender.ts` | `"use node"` gRPC transport + attachment storage |
| `_workaround.ts` | Forces Convex to install the gRPC peers (see below) |
| `convex.json` | Marks the gRPC chain as `node.externalPackages` |

## Why `_workaround.ts` exists

Convex installs an `externalPackages` entry only if the bundled code imports it.
`nice-grpc`, `nice-grpc-common`, and `@grpc/grpc-js` are optional peers of
`@photon-ai/advanced-imessage`, loaded dynamically from inside that package — so
nothing in the bundle references them and they are silently never installed.
`createGrpcClient` then fails its `import.meta.resolve` check with a
"install the peer dependencies" error even though they are in `package.json`.

Nothing imports `_workaround.ts`; the re-export exists purely to give the
bundler a static reference. Deleting it breaks outbound sends.

Also note `node.externalPackages` is **not** honoured by the anonymous local
backend, so test sends against a cloud deployment.

The echo agent in `agent.ts` is a placeholder for an LLM call. The important
part is the shape around it: re-check `isCancelled` after anything slow, then
`send` and `completeChain`.
