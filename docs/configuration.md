# Configuration — environment variables

Every environment variable the server tree reads is listed, by name, in
[`packages/config/src/index.ts`](../packages/config/src/index.ts) (the
`KnownEnvName` union). That file is the inventory; `.env.example` and
`.env.prod.example` are the annotated templates. Read variables through
`@mantle/config` — an ESLint rule refuses `process.env.X` anywhere else in
`server/` and `packages/` (tests and scripts excepted).

```ts
import { env, envInt, envFlag, isProduction } from '@mantle/config';

const url = env('DATABASE_URL'); // string | undefined, read at call time
const workers = envInt('EXTRACT_CONCURRENCY', 2, 1); // default 2, floor 1
const on = envFlag('MANTLE_TURN_STREAMING', true); // 1/true/yes/on
```

Adding a variable: add its name to the union, document it in `.env.example`,
then read it with `env()`. A name that is not in the union is a type error.

Legacy names: the `NEXT_PUBLIC_*` names from the Next.js era are honoured as
fallbacks for their `MANTLE_*` replacements (`ENV_ALIASES` in the same file)
and log one deprecation warning per process. `packages/client-types` still
reads `NEXT_PUBLIC_*` directly because the frontend build inlines those at
compile time; `server/web/server/main.ts` bridges the `MANTLE_*` values into
them at boot.

At start-up both server processes call `assertEnvShape()`, which rejects a
present-but-malformed core value (a non-UUID `ALLOWED_USER_ID`, a
`DATABASE_URL` that is not `postgres://`, a short `SESSION_SECRET`) with every
problem listed. It requires nothing, so DB-less development stays possible.

`server/sandboxd` is a standalone image with no workspace dependencies and
keeps its own config block at the top of `main.ts`.
