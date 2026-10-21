/**
 * GitHub #7 remaining case (verification seat triage): a PLAIN shell (no
 * YGL_SESSION / DSH_SESSION_ID) selects a project via `project use`, which
 * writes `current_project@default`. The job worker used to parent itself under
 * the audit-actor fallback "cli", so the child climbed `current_project@cli`
 * (nobody writes it) and a bare-command job still died "ambiguous project" in a
 * multi-project workspace.
 *
 * This exercises `job tick` — not `job run` — because tick is the cron path that
 * actually runs in a plain shell.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
let HOME = "";

function shellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, YGL_HOME: HOME, YGL_EVAL_OFFLINE: "1" };
  // simulate a plain shell: no selection session id at all
  delete env.YGL_SESSION;
  delete env.DSH_SESSION_ID;
  return env;
}

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", timeout: 120_000, env: shellEnv() });
  return { rc: r.status ?? -1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

beforeAll(() => {
  HOME = mkdtempSync(resolve(tmpdir(), "ygl-job-plain-"));
});
afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe("plain-shell job worker inherits the default selection bucket (#7 余项)", () => {
  it("job tick resolves the project selected without any session env", () => {
    expect(run(["db", "init"]).rc).toBe(0);
    expect(run(["project", "new", "alpha"]).rc).toBe(0);
    expect(run(["project", "new", "beta"]).rc).toBe(0);
    // no YGL_SESSION: writes current_project@default
    expect(run(["project", "use", "alpha"]).rc).toBe(0);

    const added = run([
      "job",
      "add",
      "proj-probe",
      "--every",
      "1",
      "--",
      process.execPath,
      BIN,
      "project",
      "show",
      "--json",
    ]);
    expect(added.rc).toBe(0);

    const tick = run(["job", "tick"]);
    expect(tick.rc).toBe(0);

    const logs = JSON.parse(run(["job", "logs", "--json"]).out) as Array<{ job?: string; title?: string; rc: number; output: string }>;
    const probe = logs.find((l) => (l.title ?? l.job) === "proj-probe");
    expect(probe).toBeTruthy();
    expect(probe!.rc).toBe(0);
    expect(probe!.output).toContain('"alpha"');
    expect(probe!.output).not.toContain("ambiguous project");
  }, 180_000);
});
