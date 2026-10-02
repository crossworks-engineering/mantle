/**
 * The one app build step lives in @mantle/tools (app-build-stage.ts): the
 * agent's `app_build` and these web routes produce the same artifact. Kept
 * under its old name for the routes that import it.
 */
export { buildAndStageApp as runAppBuild, type AppBuildOutcome } from '@mantle/tools';
