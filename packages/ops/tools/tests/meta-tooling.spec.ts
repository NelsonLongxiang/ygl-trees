/**
 * 0.114.2/0.114.3 (#34 follow-up / r32 GLM Q3, #37): tooling registration drift
 * repair is an explicit, audited act — `--reregister <path> --reason` appends a
 * `reregistrations[]` record to verify/meta.json (append-only, travels with the
 * repo; no local-DB-only ledger) before the index goes green. No auto-rehash.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const TOOL = resolve(REPO, "scripts/meta-tooling.mjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let ROOT = "";
const SCRIPT = "scripts/verify-driver.sh";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_META_ROOT: ROOT },
  });
  return { rc: r.status ?? -1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

const readIndex = () => JSON.parse(readFileSync(join(ROOT, "verify", "meta.json"), "utf8"));

describe.skipIf(!HAS_BIN)("meta-tooling drift repair (0.114.2/0.114.3)", () => {
  beforeAll(() => {
    ROOT = join(mkdtempSync(join(tmpdir(), "ygl-mtool-root-")), "repo");
    mkdirSync(join(ROOT, "scripts"), { recursive: true });
    mkdirSync(join(ROOT, "verify"), { recursive: true });
    writeFileSync(join(ROOT, SCRIPT), "#!/bin/sh\necho verify\n", "utf8");
    writeFileSync(
      join(ROOT, "verify", "meta.json"),
      JSON.stringify({ meta_index_version: 2, specs: [], orchestration: [], tooling: [{ path: SCRIPT, sha256: "0".repeat(64), role: "build" }] }, null, 2),
      "utf8",
    );
  });

  afterAll(() => rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("drift is red, --reregister records an in-repo audit entry, check goes green (no DB needed)", () => {
    const red = run(["--check"]);
    expect(red.rc).toBe(1);
    expect(red.err).toMatch(/drift/);

    const noReason = run(["--reregister", SCRIPT]);
    expect(noReason.rc).toBe(2);
    expect(noReason.err).toMatch(/--reason/);

    // #37: no workspace DB is required — the audit record lives in verify/meta.json
    const ok = run(["--reregister", SCRIPT, "--reason", "fixture byte change"]);
    expect(ok.rc).toBe(0);
    expect(ok.out).toMatch(/reregistrations\[\] recorded/);

    const index = readIndex();
    expect(index.tooling[0].sha256).toBe(sha(Buffer.from("#!/bin/sh\necho verify\n")));
    expect(index.reregistrations).toHaveLength(1);
    const entry = index.reregistrations[0];
    expect(entry).toMatchObject({ path: SCRIPT, old_sha256: "0".repeat(64), new_sha256: index.tooling[0].sha256, reason: "fixture byte change" });
    expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
    expect(run(["--check"]).rc).toBe(0);

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
  });
});
