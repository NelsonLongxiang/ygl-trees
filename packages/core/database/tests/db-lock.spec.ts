import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB } from "../src/db";

const dir = mkdtempSync(join(tmpdir(), "ygl-lock-"));
const file = join(dir, "t.db");

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle EPERM (0.34) */ }
});

describe("DB lock re-entry (defense-in-depth for same-process holders)", () => {
  it("a lock dir holding our own pid is stolen, not treated as foreign", () => {
    // 0.65.0 P0 shape: DatabaseService + profile-boot fallback both lock in
    // one process; the fallback saw its OWN pid as "another process" and
    // every real (non-YGL_TEST) invocation died. Same-process holders must
    // not block us. (Cross-process semantics: a live foreign pid still
    // blocks — unchanged.)
    const lockDir = `${file}.ygllock`;
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "pid"), String(process.pid));
    const a = new DB(file, { lock: true }); // pre-fix: threw here
    a.close();
    expect(existsSync(lockDir)).toBe(false);
  });
});
