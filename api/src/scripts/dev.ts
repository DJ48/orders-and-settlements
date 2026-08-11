/**
 * Dev-only entry point.
 *
 * `tsx --env-file=.env.local watch src/index.ts` looks like it should work — Node itself
 * supports `--env-file` — but tsx's own CLI parser doesn't recognise it, and choking on it
 * corrupts tsx's subcommand detection badly enough that `watch` gets misread as the script to
 * run rather than as a subcommand. Confirmed empirically, not assumed.
 *
 * Loading the file via Node's native API here sidesteps tsx's argv parsing entirely: this
 * script has no other top-level imports, so `loadEnvFile` runs to completion before the dynamic
 * import below ever starts loading `index.ts` — which is what matters, since `config/env.ts`
 * validates `process.env` the moment anything imports it.
 *
 * Production (Render) never runs this file — `npm start` executes the built `index.js`
 * directly, relying purely on ambient environment variables the platform injects. This wrapper
 * exists only so local `npm run dev` doesn't require exporting env vars into the shell by hand.
 */
try {
  process.loadEnvFile('.env.local');
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    console.error('Missing api/.env.local — copy .env.example to .env.local and fill it in.');
    process.exit(1);
  }
  throw err;
}

import('../index');
