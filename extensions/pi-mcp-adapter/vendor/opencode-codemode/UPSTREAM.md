# Upstream provenance

This directory contains the OpenAPI-free interpreter and standard-library source from
[anomalyco/opencode](https://github.com/anomalyco/opencode), pinned at commit
`da4730e4a41dcbb2cb2d907dd2b06ac481b8f962` (MIT license).

Pi-specific integration is intentionally outside this directory. The source was copied
from `packages/codemode/src` and imports were changed from `.js` to `.ts` so the adapter
can load TypeScript directly. OpenAPI support and its HTTP client are excluded.

The upstream package currently targets a newer Effect beta. The adapter pins the
interpreter to Effect `4.0.0-beta.98`. Compatibility patches currently applied here:

- use Effect v4 beta.98's `Effect.catch` name where upstream uses `catchAll`;
- use explicit `"error" in result` narrowing for the beta.98 Schema union;
- add conservative casts for `parseInt` radix and RegExp flags accepted by beta.98's
  TypeScript declarations.

Keep future patches isolated and record them here so the vendor can be refreshed from
upstream.
