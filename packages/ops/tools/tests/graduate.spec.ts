import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { verifyPaths } from "../src/verify-web";
import {
  attachJobTarget,
  checkEligibility,
  GraduationError,
  graduationPath,
  graduationsDir,
  jobCommand,
  patrolEligibility,
  writeGraduation,
} from "../src/graduate";

let dir: string;
let home: string;

function writeJson(p: string, v: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf8");
}

const env = () => ({ home, db: { path: path.join(dir, "workspace.db") } }) as any;

function spec(specId: string, version = 2) {
  writeJson(path.join(verifyPaths(env()).specs, specId, "spec.json"), {
    spec_id: specId,
    spec_version: version,
    contract_version: "1.1",
  });
}

function report(id: string, specId: string, finished: string, overall: string, version = 2, source = "/data/billing.sqlite") {
  writeJson(path.join(verifyPaths(env()).reports, `${id}.json`), {
    run_id: id,
    spec_id: specId,
    finished,
    overall,
    verifier: { spec_version: version },
    data_source: { kind: "sqlite-snapshot", sha256: "a".repeat(64), source },
  });
}

const TH = { min_runs: 3, min_span_days: 30 };

beforeAll(() => {
  dir = path.join(process.cwd(), "tmp", `graduate-${Date.now()}`);
  home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("checkEligibility", () => {
  it("passes with N consecutive PASS runs spanning the threshold", () => {
    spec("spec_eligible");
    report("run_e1", "spec_eligible", "2026-09-01T00:00:00.000Z", "PASS");
    report("run_e2", "spec_eligible", "2026-09-20T00:00:00.000Z", "PASS");
    report("run_e3", "spec_eligible", "2026-10-11T00:00:00.000Z", "PASS");

    const el = checkEligibility(env(), "spec_eligible", TH);
    expect(el.ok).toBe(true);
    expect(el.reasons).toEqual([]);
    expect(el.runs.map((r) => r.run_id)).toEqual(["run_e3", "run_e2", "run_e1"]);
    expect(el.span_days).toBe(40);
    expect(el.data_source?.source).toBe("/data/billing.sqlite");
  });

  it("names the missing report count", () => {
    spec("spec_short");
    report("run_s1", "spec_short", "2026-09-01T00:00:00.000Z", "PASS");

    const el = checkEligibility(env(), "spec_short", TH);
    expect(el.ok).toBe(false);
    expect(el.reasons.join(" ")).toContain("need 3 report(s) at spec_version 2, found 1");
  });

  it("refuses when any of the recent runs is not PASS", () => {
    spec("spec_fail");
    report("run_f1", "spec_fail", "2026-09-01T00:00:00.000Z", "PASS");
    report("run_f2", "spec_fail", "2026-09-15T00:00:00.000Z", "PASS");
    report("run_f3", "spec_fail", "2026-10-05T00:00:00.000Z", "FAIL");

    const el = checkEligibility(env(), "spec_fail", TH);
    expect(el.ok).toBe(false);
    expect(el.reasons.join(" ")).toContain("not all recent runs PASS at spec_version 2: run_f3=FAIL");
  });

  it("refuses when the span is shorter than the threshold", () => {
    spec("spec_span");
    report("run_p1", "spec_span", "2026-10-01T00:00:00.000Z", "PASS");
    report("run_p2", "spec_span", "2026-10-05T00:00:00.000Z", "PASS");
    report("run_p3", "spec_span", "2026-10-09T00:00:00.000Z", "PASS");

    const el = checkEligibility(env(), "spec_span", TH);
    expect(el.ok).toBe(false);
    expect(el.reasons.join(" ")).toContain("span 8 day(s) < 30 day(s)");
  });

  it("ignores other spec ids and other spec versions (crossing a version breaks continuity)", () => {
    spec("spec_scope", 3);
    report("run_v1_old", "spec_scope", "2026-08-01T00:00:00.000Z", "PASS", 2);
    report("run_other", "spec_other", "2026-08-02T00:00:00.000Z", "PASS", 3);
    report("run_v3_a", "spec_scope", "2026-09-01T00:00:00.000Z", "PASS", 3);
    report("run_v3_b", "spec_scope", "2026-10-02T00:00:00.000Z", "PASS", 3);

    const el = checkEligibility(env(), "spec_scope", TH);
    expect(el.runs.map((r) => r.run_id)).toEqual(["run_v3_b", "run_v3_a"]);
    expect(el.ok).toBe(false);
    expect(el.reasons.join(" ")).toContain("found 2");
  });

  it("refuses a single report when a span threshold is set (min-runs 1 + span 30 was vacuous)", () => {
    spec("spec_tight");
    report("run_t1", "spec_tight", "2026-09-01T00:00:00.000Z", "PASS");

    const el = checkEligibility(env(), "spec_tight", { min_runs: 1, min_span_days: 30 });
    expect(el.ok).toBe(false);
    expect(el.reasons.join(" ")).toContain(
      "span threshold 30 day(s) needs at least 2 reports at spec_version 2 (found 1)",
    );
  });

  it("reports window-outside failures in history (last N all PASS does not hide earlier FAIL)", () => {
    spec("spec_hist");
    report("run_h1", "spec_hist", "2026-08-01T00:00:00.000Z", "FAIL");
    report("run_h2", "spec_hist", "2026-09-01T00:00:00.000Z", "PASS");
    report("run_h3", "spec_hist", "2026-09-20T00:00:00.000Z", "PASS");
    report("run_h4", "spec_hist", "2026-10-11T00:00:00.000Z", "PASS");

    const el = checkEligibility(env(), "spec_hist", TH);
    expect(el.ok).toBe(true); // 窗口外 FAIL 不否决资格（FAIL 是有效结论）
    expect(el.history.reports_same_version).toBe(4);
    expect(el.history.non_pass).toBe(1);
    expect(el.history.last_non_pass).toMatchObject({ run_id: "run_h1", overall: "FAIL" });
  });

  it("keeps frozen thresholds on duplicate instead of echoing the request", () => {
    spec("spec_frozen_th");
    report("run_th1", "spec_frozen_th", "2026-09-01T00:00:00.000Z", "PASS");
    report("run_th2", "spec_frozen_th", "2026-09-20T00:00:00.000Z", "PASS");
    report("run_th3", "spec_frozen_th", "2026-10-11T00:00:00.000Z", "PASS");

    const first = writeGraduation(env(), checkEligibility(env(), "spec_frozen_th", TH), TH);
    expect(first.record.thresholds.min_span_days).toBe(30);

    const again = writeGraduation(env(), checkEligibility(env(), "spec_frozen_th", { min_runs: 3, min_span_days: 31 }), {
      min_runs: 3,
      min_span_days: 31,
    });
    expect(again.duplicate).toBe(true);
    expect(again.record.thresholds.min_span_days).toBe(30); // 冻结值，不是本次请求值
  });

  it("throws a named error when the spec is missing", () => {
    expect(() => checkEligibility(env(), "spec_absent", TH)).toThrow(GraduationError);
    expect(() => checkEligibility(env(), "spec_absent", TH)).toThrow(/spec not found: spec_absent/);
  });
});

describe("writeGraduation", () => {
  it("freezes the record, then treats the same shape as duplicate", () => {
    spec("spec_freeze");
    report("run_z1", "spec_freeze", "2026-09-01T00:00:00.000Z", "PASS");
    report("run_z2", "spec_freeze", "2026-09-21T00:00:00.000Z", "PASS");
    report("run_z3", "spec_freeze", "2026-10-11T00:00:00.000Z", "PASS");

    const el = checkEligibility(env(), "spec_freeze", TH);
    const first = writeGraduation(env(), el, TH, "2026-10-20T00:00:00.000Z");
    expect(first.duplicate).toBe(false);
    expect(first.record.run_ids).toEqual(["run_z3", "run_z2", "run_z1"]);
    expect(fs.existsSync(graduationPath(env(), "spec_freeze"))).toBe(true);
    expect(graduationsDir(env())).toBe(path.join(home, "verify", "graduations"));

    const again = writeGraduation(env(), el, TH, "2026-10-21T00:00:00.000Z");
    expect(again.duplicate).toBe(true);
    expect(again.record.created).toBe("2026-10-20T00:00:00.000Z"); // 冻结的 created 不被重跑改写
  });

  it("names the superseded case when the spec version moved on", () => {
    spec("spec_super", 4);
    report("run_s4a", "spec_super", "2026-09-01T00:00:00.000Z", "PASS", 4);
    report("run_s4b", "spec_super", "2026-09-25T00:00:00.000Z", "PASS", 4);
    report("run_s4c", "spec_super", "2026-10-11T00:00:00.000Z", "PASS", 4);
    writeGraduation(env(), checkEligibility(env(), "spec_super", TH), TH);

    spec("spec_super", 5);
    report("run_s5a", "spec_super", "2026-10-01T00:00:00.000Z", "PASS", 5);
    report("run_s5b", "spec_super", "2026-10-12T00:00:00.000Z", "PASS", 5);
    report("run_s5c", "spec_super", "2026-10-16T00:00:00.000Z", "PASS", 5);

    expect(() => writeGraduation(env(), checkEligibility(env(), "spec_super", { min_runs: 3, min_span_days: 10 }), { min_runs: 3, min_span_days: 10 }))
      .toThrow(/graduation frozen for an older spec_version: spec_super was v4/);
  });

  it("refuses to overwrite a frozen record with a different shape", () => {
    report("run_z4", "spec_freeze", "2026-10-18T00:00:00.000Z", "PASS");
    const el = checkEligibility(env(), "spec_freeze", TH);
    expect(() => writeGraduation(env(), el, TH)).toThrow(/refusing to overwrite with a different shape/);
  });
});

describe("jobCommand / patrolEligibility", () => {
  it("builds the recurring job command from the report data source", () => {
    expect(jobCommand("spec_x", "/data/billing.sqlite")).toEqual({
      command: 'ygl-trees verify run spec_x --db "/data/billing.sqlite" --no-archive',
      db: "/data/billing.sqlite",
      usable: true,
      unsafe: false,
      rejected: null,
    });
    expect(jobCommand("spec_x", null)).toMatchObject({ usable: false });
    expect(jobCommand("spec_x", null).command).toContain('--db "<snapshot.sqlite>"');
  });

  it("never trusts a content-addressed source as --db, but an explicit override wins", () => {
    const blob = jobCommand("spec_x", "blob:0123456789ab");
    expect(blob.usable).toBe(false);
    expect(blob.command).toContain('--db "<snapshot.sqlite>"');

    const overridden = jobCommand("spec_x", "blob:0123456789ab", "/data/live.sqlite");
    expect(overridden.usable).toBe(true);
    expect(overridden.command).toContain('--db "/data/live.sqlite"');
  });

  // r26 P1: a crafted report can put anything into data_source.source, and the
  // recurring command is executed by `job tick` through a shell. A source that
  // is not a plain path must never reach the command string.
  it("refuses to build a shell command from an injected source", () => {
    const injected = 'C:\\snap.sqlite" & echo PWNED > C:\\tmp\\PWNED2.txt & rem "';
    const cmd = jobCommand("spec_x", injected);
    expect(cmd.usable).toBe(false);
    expect(cmd.unsafe).toBe(true);
    expect(cmd.command).toContain('--db "<snapshot.sqlite>"');
    expect(cmd.command).not.toContain("PWNED");
    expect(cmd.command).not.toContain("&");
    // r27 P3-1: the summary must describe the shape, never echo the sample back —
    // the old assertion (`toContain("PWNED")`) cemented the leak into the contract.
    expect(cmd.rejected).not.toContain("PWNED");
    expect(cmd.rejected).toMatch(/shell metacharacter at offset \d+/);
    // Same rule for an operator override: the job executes it just the same.
    const viaOverride = jobCommand("spec_x", "/data/ok.sqlite", 'x" & whoami & "');
    expect(viaOverride.usable).toBe(false);
    expect(viaOverride.unsafe).toBe(true);
    expect(viaOverride.command).not.toContain("whoami");
    expect(viaOverride.rejected).not.toContain("whoami");
  });

  it("keeps ordinary paths (spaces, colons, both separators, unicode) executable", () => {
    for (const p of [
      "/data/billing.sqlite",
      "C:\\Users\\me\\My Snapshots\\snap.sqlite",
      "./tmp/snap.sqlite",
      // r27 P2-3: Chinese / '#' / '+' are legal Windows path characters; a narrow
      // ascii whitelist used to reject real user directories and block scheduling.
      "C:\\数据\\账单调账 2026#1+final.sqlite",
      // r28 P4: braces are literal inside double quotes — we deny `$`, not `{}`.
      "/data/{a}/x.sqlite",
    ]) {
      const cmd = jobCommand("spec_x", p);
      expect(cmd.usable).toBe(true);
      expect(cmd.unsafe).toBe(false);
      expect(cmd.command).toContain(p);
    }
    // spec_id is part of the command too — placeholder it when it fails the id shape.
    const badId = jobCommand("spec x; rm -rf /", "/data/ok.sqlite");
    expect(badId.usable).toBe(false);
    expect(badId.command).not.toContain("rm -rf");
  });

  // r27 P2-2: `--db "C:\...\Temp\"` escapes the closing quote and becomes
  // `node: bad option` — a path that cannot be quoted safely must not be scheduled.
  it("rejects paths that cannot survive double quoting", () => {
    for (const p of ["C:\\Users\\me\\Temp\\", "/data/snaps/", "C:\\data\\snap.sqlite "]) {
      const cmd = jobCommand("spec_x", p);
      expect(cmd.usable).toBe(false);
      expect(cmd.unsafe).toBe(true);
      expect(cmd.rejected).toMatch(/paths ending with (a separator|whitespace)/);
    }
  });

  // r28 P3: POSIX sh expands $VAR inside double quotes — `/data/${HOME}/x.sqlite`
  // would silently point the recurring job at a different file.
  it("rejects $ expansion inside double quotes", () => {
    for (const p of ["/data/${HOME}/x.sqlite", "/data/$SNAP/x.sqlite"]) {
      const cmd = jobCommand("spec_x", p);
      expect(cmd.usable).toBe(false);
      expect(cmd.unsafe).toBe(true);
      expect(cmd.rejected).toMatch(/shell metacharacter at offset/);
    }
  });

  it("only allows patrol graduation when the verified db IS the workspace db", () => {
    expect(patrolEligibility(env(), null).ok).toBe(false);
    expect(patrolEligibility(env(), null).reason).toContain("no data_source");
    expect(patrolEligibility(env(), { kind: "sqlite-snapshot", source: "/data/other.sqlite" }).ok).toBe(false);
    expect(
      patrolEligibility(env(), { kind: "sqlite-snapshot", source: path.join(dir, "workspace.db") }).ok,
    ).toBe(true);
  });
});

describe("attachJobTarget (r28 Q2)", () => {
  it("adds job_target without rewriting any frozen field", () => {
    spec("spec_target");
    report("run_t1", "spec_target", "2026-09-01T00:00:00.000Z", "PASS");
    report("run_t2", "spec_target", "2026-09-21T00:00:00.000Z", "PASS");
    report("run_t3", "spec_target", "2026-10-11T00:00:00.000Z", "PASS");
    const frozen = writeGraduation(env(), checkEligibility(env(), "spec_target", TH), TH, "2026-10-20T00:00:00.000Z");
    const before = JSON.parse(fs.readFileSync(frozen.path, "utf8"));

    const after = attachJobTarget(env(), "spec_target", {
      db: "/data/billing.sqlite",
      origin: "report",
      usable: true,
      job_id: "job_123",
      every_minutes: 60,
      updated_at: "2026-10-20T01:00:00.000Z",
    });
    const onDisk = JSON.parse(fs.readFileSync(frozen.path, "utf8"));
    expect(onDisk.job_target).toEqual({
      db: "/data/billing.sqlite",
      origin: "report",
      usable: true,
      job_id: "job_123",
      every_minutes: 60,
      updated_at: "2026-10-20T01:00:00.000Z",
    });
    // Identity fields stay byte-identical: the audit fact must not move with the schedule.
    for (const k of ["spec_id", "spec_version", "run_ids", "thresholds", "history", "span_days", "data_source", "created"]) {
      expect(JSON.stringify(onDisk[k])).toBe(JSON.stringify(before[k]));
    }
    expect(after.job_target?.job_id).toBe("job_123");
  });

  it("replaces only job_target on a re-attach (same spec)", () => {
    const after = attachJobTarget(env(), "spec_target", {
      db: "/data/other.sqlite",
      origin: "override",
      usable: true,
      job_id: "job_123",
      every_minutes: 30,
      updated_at: "2026-10-20T02:00:00.000Z",
    });
    expect(after.job_target).toMatchObject({ db: "/data/other.sqlite", origin: "override", every_minutes: 30 });
    expect(after.run_ids.length).toBe(3);
  });

  it("re-attaching the SAME target is a no-op (updated_at preserved, no rewrite) — Q1", () => {
    const gradPath = path.join(verifyPaths(env()).root, "graduations", "spec_target.json");
    const before = JSON.parse(fs.readFileSync(gradPath, "utf8"));
    // state carried over from the previous test: db=/data/other.sqlite, every=30
    const after = attachJobTarget(env(), "spec_target", {
      db: "/data/other.sqlite",
      origin: "override",
      usable: true,
      job_id: "job_123",
      every_minutes: 30,
    });
    expect(after.job_target?.updated_at).toBe("2026-10-20T02:00:00.000Z"); // unchanged
    const onDisk = JSON.parse(fs.readFileSync(gradPath, "utf8"));
    expect(onDisk.job_target.updated_at).toBe("2026-10-20T02:00:00.000Z");
    expect(JSON.stringify(onDisk.job_target)).toBe(JSON.stringify(before.job_target));
  });

  it("a CHANGED target refreshes updated_at — Q1", () => {
    const after = attachJobTarget(env(), "spec_target", {
      db: "/data/third.sqlite",
      origin: "override",
      usable: true,
      job_id: "job_123",
      every_minutes: 30,
    });
    expect(after.job_target?.db).toBe("/data/third.sqlite");
    expect(after.job_target?.updated_at).not.toBe("2026-10-20T02:00:00.000Z");
  });

  it("refuses to annotate a record that does not exist", () => {
    expect(() =>
      attachJobTarget(env(), "spec_absent", {
        db: "/data/x.sqlite",
        origin: "override",
        usable: true,
        job_id: null,
        every_minutes: 60,
      }),
    ).toThrow(/no graduation record for spec_absent/);
    expect(fs.existsSync(path.join(verifyPaths(env()).root, "graduations", "spec_absent.json"))).toBe(false);
  });
});
