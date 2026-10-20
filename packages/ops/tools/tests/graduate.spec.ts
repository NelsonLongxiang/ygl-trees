import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { verifyPaths } from "../src/verify-web";
import {
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
    });
    expect(jobCommand("spec_x", null)).toMatchObject({ usable: false });
    expect(jobCommand("spec_x", null).command).toContain('--db "<snapshot.sqlite>"');
  });

  it("never trusts a content-addressed source as --db, but an explicit override wins", () => {
    const blob = { command: "", db: "", usable: true };
    Object.assign(blob, jobCommand("spec_x", "blob:0123456789ab"));
    expect(blob.usable).toBe(false);
    expect(blob.command).toContain('--db "<snapshot.sqlite>"');

    const overridden = jobCommand("spec_x", "blob:0123456789ab", "/data/live.sqlite");
    expect(overridden.usable).toBe(true);
    expect(overridden.command).toContain('--db "/data/live.sqlite"');
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
