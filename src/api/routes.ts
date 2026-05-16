/**
 * Thin re-export of the per-feature router composition.
 *
 * Kept so the `server.ts` import path stays stable after the per-feature
 * split. New code should import from `./routes/index.js` directly.
 */
export { createRouter } from './routes/index.js';
export type { AppPaths } from './routes/index.js';
