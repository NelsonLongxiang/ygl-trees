// apps/cli library surface — the compiled path the root package.json "main"
// points at (dist/apps/cli/index.js) stays stable while source lives in src/ (DSH
// apps/cli convention: bin.ts entry + concern-per-file under src/).
export { main, usage, loadBundle, repoRoot, appVersion, HOME } from "./src/bin";
