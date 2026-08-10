/**
 * config/env.ts validates the environment the moment anything imports it — even transitively,
 * e.g. app.ts -> routes -> auth.controller.ts -> config/env. That happens before any test
 * file's `beforeAll` runs, so without this, importing `createApp` fails immediately with
 * "MONGODB_URI: expected string, received undefined".
 *
 * This value is never actually connected to. Every test's real database access goes through
 * `connectDatabase(uri)` with an explicit MongoMemoryReplSet URI — connectDatabase takes the
 * URI as a parameter and never reads from `env`, specifically so this can be a placeholder.
 */
process.env.MONGODB_URI ??= 'mongodb://placeholder-never-used/ignored';
