// apps/cli entry surface — the compiled path bin/ygl-trees.js requires
// (dist/apps/cli/index.js) stays stable while source lives in src/ (DSH
// apps/cli convention: bin.ts entry + concern-per-file under src/).
export { main, usage, loadBundle, repoRoot, appVersion, HOME } from "./src/bin";
