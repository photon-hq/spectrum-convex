# Changesets

This directory holds [changesets](https://github.com/changesets/changesets) —
one markdown file per user-visible change, describing what changed and how it
bumps the version.

Add one alongside the change it describes:

```sh
npm run changeset
```

Pick a bump level (`patch` / `minor` / `major`) and write the line you'd want a
consumer to read in the changelog. The file that produces is committed with your
PR; it is consumed and deleted when a release goes out.

Releases are automated. On merge to `main`, the release workflow opens (or
updates) a "Version Packages" PR that applies every pending changeset — bumping
`package.json` and folding the entries into `CHANGELOG.md`. Merging that PR
publishes to npm.

No changeset is needed for changes a consumer can't observe: CI config, tests,
internal refactors, docs that aren't the README.
