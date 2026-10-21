/**
 * 0.114.2 (#34 follow-up / r32 GLM Q3): tooling registration drift repair is an
 * explicit, audited act — `--reregister <path> --reason` records a
 * `meta.reregister` event before editing verify/meta.json; no auto-rehash path.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const TOOL = resolve(REPO, "scripts/meta-tooling.mjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let HOME = "";
let ROOT = "";
const SCRIPT = "scripts/verify-driver.sh";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: HOME, YGL_META_ROOT: ROOT },
  });
  return { rc: r.status ?? -1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

describe.skipIf(!HAS_BIN)("meta-tooling drift repair (0.114.2)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-mtool-home-"));
    ROOT = join(mkdtempSync(join(tmpdir(), "ygl-mtool-root-")), "repo");
    mkdirSync(join(ROOT, "scripts"), { recursive: true });
    mkdirSync(join(ROOT, "verify"), { recursive: true });
    writeFileSync(join(ROOT, SCRIPT), "#!/bin/sh\necho verify\n", "utf8");
    writeFileSync(
      join(ROOT, "verify", "meta.json"),
      JSON.stringify({ meta_index_version: 2, specs: [], orchestration: [], tooling: [{ path: SCRIPT, sha256: "0".repeat(64), role: "build" }] }, null, 2),
      "utf8",
    );
    const init = spawnSync(process.execPath, [BIN, "db", "init"], { encoding: "utf8", env: { ...process.env, YGL_HOME: HOME } });
    expect(init.status).toBe(0);
  });

  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("drift is red, --reregister records an event then updates the index, check goes green", () => {
    const red = run(["--check"]);
    expect(red.rc).toBe(1);
    expect(red.err).toMatch(/drift/);

    const noReason = run(["--reregister", SCRIPT]);
    expect(noReason.rc).toBe(2);
    expect(noReason.err).toMatch(/--reason/);

    const ok = run(["--reregister", SCRIPT, "--reason", "fixture byte change"]);
    expect(ok.rc).toBe(0);
    expect(ok.out).toMatch(/meta\.reregister recorded/);

    const index = JSON.parse(readFileSync(join(ROOT, "verify", "meta.json"), "utf8"));
    expect(index.tooling[0].sha256).toBe(sha(Buffer.from("#!/bin/sh\necho verify\n")));
    expect(run(["--check"]).rc).toBe(0);

    const db = new DatabaseSync(join(HOME, "ygl-trees.db"));
    try {
      const rows = db.prepare("SELECT kind, entity, entity_id, payload FROM events WHERE kind='meta.reregister'").all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].entity_id).toBe(SCRIPT);
      const p = JSON.parse(String(rows[0].payload));
      expect(p.old_sha256).toBe("0".repeat(64));
      expect(p.new_sha256).toBe(index.tooling[0].sha256);
      expect(p.reason).toBe("fixture byte change");
    } finally {
      db.close();
    }

    // no drift now → explicit re-register is refused (not a silent no-op)
    const again = run(["--reregister", SCRIPT, "--reason", "nothing changed"]);
    expect(again.rc).toBe(2);
    expect(again.err).toMatch(/no drift/);

    const unregistered = run(["--reregister", "scripts/absent.mjs", "--reason", "x"]);
    expect(unregistered.rc).toBe(2);
  });

  it("no invocation mode silently rehashes: bare run is a usage error", () => {
    const bare = run([]);
    expect(bare.rc).toBe(2);
    expect(bare.err).toMatch(/--check/);
    expect(existsSync(join(ROOT, "verify", "meta.json"))).toBe(true);
  });
});
