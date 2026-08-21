# Publishing

Releases are driven by [Changesets](https://github.com/changesets/changesets)
and run in CI. The normal path involves no local publishing.

## Day to day

Add a changeset alongside any change a consumer can observe:

```sh
npm run changeset
```

Pick the bump level and write the line you want in the changelog. Commit the
generated file in `.changeset/` with your PR.

Skip it for things a consumer can't see — CI config, tests, internal refactors.

## How a release happens

1. A PR with a changeset merges to `main`.
2. `.github/workflows/release.yml` runs the full gate (build, biome, typecheck,
   tests), then opens or updates a **"Version Packages"** PR. That PR applies
   every pending changeset: bumps `package.json`, folds the entries into
   `CHANGELOG.md`, and deletes the consumed changeset files.
3. Merging the Version Packages PR re-runs the workflow, which sees no pending
   changesets and instead runs `npm run release` — a fresh build followed by
   `changeset publish`.
4. `changeset publish` publishes any version not already on the registry and
   pushes the git tag.

## One-time setup

The workflow needs an **`NPM_TOKEN`** repository secret.

The account has `auth-and-writes` two-factor enabled, so an ordinary token will
be rejected on publish. Create a **Granular Access Token** (or classic
*Automation* token) at npmjs.com — those are exempt from the OTP prompt — scoped
to write on `@spectrum-ts/*`, and add it under
*Settings → Secrets and variables → Actions*.

Also enable *Settings → Actions → General → Allow GitHub Actions to create and
approve pull requests*, or the Version Packages PR can't be opened.

## Publishing by hand

Only needed for the first publish, or if CI is unavailable:

```sh
npm run build:clean   # regenerates _generated, then rebuilds
npm test && npm run check && npm run typecheck
npm publish --access public
```

With `auth-and-writes` 2FA this prompts for a one-time password — npm prints a
URL to approve in a browser, or pass `--otp=<code>` from an authenticator app.

Sanity-check the tarball first if you like:

```sh
npm pack
```

Install the resulting `.tgz` into a scratch Convex app and confirm all four
entry points resolve — `@spectrum-ts/convex`, `/convex.config`, `/sender`, and
`/test` — then delete it.

## What ships

`files` is `["dist", "src"]`. Both are required; `src` is not just for source
maps:

- `./test` resolves to `src/test.ts`, because its `import.meta.glob` has to be
  transformed by the consumer's bundler.
- The `@convex-dev/component-source` condition points at `src/**` so
  `convex dev --live-component-sources` can build the component from source when
  it is linked into a local checkout.

`src/component/_generated/` is committed and ships as-is. `component.ts` in that
directory is the `ComponentApi` type the client re-exports, so a stale copy
ships a type that no longer matches the component's validators. Regenerate with
`npm run build:codegen` (needs a Convex deployment) and commit it whenever a
component validator changes. CI deliberately does not regenerate it.
