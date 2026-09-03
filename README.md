# Rasat demo

Public cassette at [demo.rasat.dev](https://demo.rasat.dev): the Rasat UI with synthetic shop data. Not ingest. No ClickHouse.

Product: [odurgut/rasat](https://github.com/odurgut/rasat). Run your own: [getting started](https://rasat.dev/docs/getting-started).

## Local

Needs Node 22. The UI is cloned (or linked) into `./rasat` from `odurgut/rasat` — that directory is not in git.

```bash
npm ci
npm run fetch    # latest vX.Y.Z, or RASAT_TAG=v0.1.0; sibling ../rasat is linked if present
npm run dev      # http://localhost:5175/
```

## Release

Same tags as Docker Hub: `vMAJOR.MINOR.PATCH` on `odurgut/rasat`. Rasat’s release workflow dispatches this repo (`rasat-release`, payload `tag`). `deploy` checks out that tag into `./rasat`, builds, and `wrangler deploy`s over `demo.rasat.dev`. Not from `main`. Manual run: Actions → deploy → the same tag.
