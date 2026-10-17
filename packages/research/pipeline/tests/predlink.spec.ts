/**
 * 0.82.1 (user report ③): prediction lifecycle — `claim link --stance supports`
 * used to auto-promote `[预测·…]` claims to supported, and predict audit treats
 * supported/refuted as human-arbitrated (terminal). A mere evidence link kicked
 * predictions out of the tracking table before their deadline. Now:
 *   1. claimLink NEVER auto-promotes prediction claims (auto_promote:false).
 *   2. claimUnresolve is the repair channel (reset to unverified, idempotent).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB } from "../../../core/database/src/db";
import { getOrm, closeOrm } from "../../../core/database/src/orm";
import * as writes from "../src/writes";

let db: DB;
let dir: string;
let pid: string;
let predClaim: string;
let plainClaim: string;
let evId: string;

beforeAll(async () => {
  dir = path.join(process.cwd(), "tmp", `predlink-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "t.db");
  db = new DB(f);
  const ds = await getOrm(f);
  const p = await writes.projectCreate(ds, "predlink", "prediction lifecycle");
  pid = p.id as string;
  const src = await writes.sourceAdd(ds, pid, { title: "s", url: "session://t/1" });
  const ev = await writes.evidenceAdd(ds, pid, src.row.id, "quote for prediction");
  evId = ev.row.id as string;
  const pc = await writes.claimAdd(ds, pid, "[预测·7天] 2026-10-24 前 npm 再发 ≥3 个版本", "B");
  predClaim = pc.row.id as string;
  const gc = await writes.claimAdd(ds, pid, "plain claim about something", "B");
  plainClaim = gc.row.id as string;
  await closeOrm();
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("claimLink prediction guard (0.82.1)", () => {
  it("link on [预测· claim: stance recorded, status stays unverified, auto_promote:false", async () => {
    const ds = await getOrm(db.path!);
    const r = await writes.claimLink(ds, predClaim, evId, "supports");
    expect(r.auto_promote).toBe(false);
    expect(r.status).toBe("unverified");
    const row = db.get("SELECT status FROM claims WHERE id=?", [predClaim]) as any;
    expect(row.status).toBe("unverified"); // NOT auto-promoted
    const link = db.get("SELECT stance FROM claim_evidence WHERE claim_id=? AND evidence_id=?", [predClaim, evId]) as any;
    expect(link.stance).toBe("supports"); // evidence link itself still written
    await closeOrm();
  });

  it("link on plain claim: auto-promote still works (supports → supported)", async () => {
    const ds = await getOrm(db.path!);
    const r = await writes.claimLink(ds, plainClaim, evId, "supports");
    expect(r.auto_promote).toBe(true);
    expect(r.status).toBe("supported");
    await closeOrm();
  });
});

describe("claimUnresolve repair channel (0.82.1)", () => {
  it("resets a promoted claim to unverified + logs claim.unresolve event", async () => {
    const ds = await getOrm(db.path!);
    const r = await writes.claimUnresolve(ds, plainClaim);
    expect(r.status).toBe("unverified");
    expect(r.duplicate).toBe(false);
    const row = db.get("SELECT status FROM claims WHERE id=?", [plainClaim]) as any;
    expect(row.status).toBe("unverified");
    const ev = db.get("SELECT kind FROM events WHERE kind='claim.unresolve' AND entity_id=?", [plainClaim]) as any;
    expect(ev).toBeTruthy();
    await closeOrm();
  });

  it("idempotent: already unverified → duplicate:true, no extra event", async () => {
    const ds = await getOrm(db.path!);
    const r = await writes.claimUnresolve(ds, plainClaim);
    expect(r.duplicate).toBe(true);
    const n = (db.get("SELECT COUNT(*) AS c FROM events WHERE kind='claim.unresolve' AND entity_id=?", [plainClaim]) as any).c;
    expect(n).toBe(1);
    await closeOrm();
  });

  it("bad claim id → named not-found (frozen contract ④)", async () => {
    const ds = await getOrm(db.path!);
    await expect(writes.claimUnresolve(ds, "nope")).rejects.toThrow("claim not found: nope");
    await closeOrm();
  });
});
