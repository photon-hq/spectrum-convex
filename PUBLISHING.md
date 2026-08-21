# Publishing

`@spectrum-ts/convex` is published to npm. You need an npmjs account with
permission to publish under the `@spectrum-ts` scope.

## First publish

1. `npm login`
2. `npm run build:clean` — wipes `dist/`, regenerates the component's
   `_generated/` tree, and rebuilds.
3. `npm ci` — install exactly what `package-lock.json` pins.
4. `npm test && npm run check && npm run typecheck`
5. `npm pack` — produces a `.tgz`. Install it into a scratch Convex app
   (`npm install ./spectrum-ts-convex-0.1.0.tgz`) and confirm the four entry
   points resolve:
   - `@spectrum-ts/convex` (the `Spectrum` client)
   - `@spectrum-ts/convex/convex.config` (`app.use(spectrum)`)
   - `@spectrum-ts/convex/sender` (the Node transport)
   - `@spectrum-ts/convex/test` (`register()` for `convex-test`)

   Delete the `.tgz` afterwards.
6. `npm publish --access public`
7. `git tag v0.1.0 && git push --follow-tags`

After the first publish, use the release scripts below — they cover steps 2–7.

## Release scripts

- `preversion` runs `npm ci`, a clean build, the tests, biome, and typecheck
  before a version is cut. A failure here aborts the release.
- `prepare` rebuilds on install and before publish.

### Alpha

```sh
npm run alpha
```

Cuts a prerelease (`0.1.1-alpha.0`), publishes under the `alpha` dist-tag, and
pushes the commit and tag. Consumers install it with
`npm install @spectrum-ts/convex@alpha`.

### Patch

```sh
npm run release
```

Cuts a patch version, publishes as `latest`, and pushes the commit and tag.

### Minor or major

```sh
npm version minor   # or major
npm publish
git push --follow-tags
```

## What ships

`files` is `["dist", "src"]`. Both are required — `src` is not just for source
maps:

- `./test` resolves to `src/test.ts` because its `import.meta.glob` has to be
  transformed by the consumer's bundler.
- The `@convex-dev/component-source` export condition points at `src/**` so that
  `convex dev --live-component-sources` can build the component from source when
  it is linked into a local checkout.

Regenerate `src/component/_generated/` (`npm run build:codegen`) and commit it
before releasing. `component.ts` in that directory is the `ComponentApi` type
the client re-exports, so a stale copy ships a type that no longer matches the
component's validators.

## Changelog

Add a section to `CHANGELOG.md` under the new version number before running a
release script.
