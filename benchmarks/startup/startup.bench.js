/** User path: CLI startup — full process spawn cost (bundler + Context + DB open). */
"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { suite, now, stats, freshWorkspace } = require("../support/helpers");

module.exports = async function runStartup(root, bin) {
  await suite("startup", async () => {
    const ws = freshWorkspace(root, "startup");
    const args = ["--no-color", "--home", ws, "db", "init"];
    spawnSync(process.execPath, [bin, ...args], { stdio: "ignore" }); // warmup
    const samples = [];
    for (let i = 0; i < 10; i++) {
      const t0 = now();
      spawnSync(process.execPath, [bin, "--no-color", "--home", ws, "db", "stats"], { stdio: "ignore" });
      samples.push(now() - t0);
    }
    const st = stats(samples);
    return { unit: "per-op", ...st, note: `n=${st.n} full CLI process` };
  });
};
