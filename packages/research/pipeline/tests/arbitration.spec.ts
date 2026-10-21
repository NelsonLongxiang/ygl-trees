/**
 * Q3 (r29, 0.110.x): claim arbitration lock. An explicit `claim resolve` is a
 * human decision on top of the evidence graph; later link/unlink must not
 * silently re-derive it away. The events table is the truth source (no schema
 * v13); `claim.unresolve` releases the lock. The lookup must use an index
 * (idx_events_kind_entity), not a full events scan.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB } from "../../../core/database/src/db";
import { getOrm, closeOrm } from "../../../core/database/src/orm";
import * as writes from "../src/writes";

let db: DB;
let dir = "";
let claim = "";
let ev1 = "";
let ev2 = "";

beforeAll(async () => {
  dir = path.join(process.cwd(), "tmp", `arbitration-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "t.db");
  db = new DB(f);
  const ds = await getOrm(f);
  const p = await writes.projectCreate(ds, "arb", "arbitration lock");
  const src = await writes.sourceAdd(ds, p.id, { title: "s", url: "session://arb/1" });
  ev1 = (await writes.evidenceAdd(ds, p.id, src.row.id, "first quote")).row.id as string;
  ev2 = (await writes.evidenceAdd(ds, p.id, src.row.id, "second quote")).row.id as string;
  claim = (await writes.claimAdd(ds, p.id, "arbitration claim text", "B")).row.id as string;
  await closeOrm();
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("claim arbitration lock (Q3)", () => {
  it("manual resolve survives later link/unlink", async () => {
    const ds = await getOrm(db.path!);
    const linked = await writes.claimLink(ds, claim, ev1, "supports");
    expect(linked.status).toBe("supported");
    await writes.claimResolve(ds, claim, "refuted");
    const relink = await writes.claimLink(ds, claim, ev2, "supports");
    expect(relink.status).toBe("refuted"); // locked by the resolve event
    expect(relink.auto_promote).toBe(false); // receipt tells the truth
    const unlinked = await writes.claimUnlink(ds, claim, ev1);
    expect(unlinked.status).toBe("refuted");
    await closeOrm();
  });

  it("claim.unresolve releases the lock (links derive again)", async () => {
    const ds = await getOrm(db.path!);
    await writes.claimUnresolve(ds, claim);
    const relink = await writes.claimLink(ds, claim, ev2, "supports");
    expect(relink.auto_promote).toBe(true);
    expect(relink.status).toBe("supported");
    await closeOrm();
  });

  it("arbitration lookup uses the composite events index (no full scan)", () => {
    const plan = db.all(
      `EXPLAIN QUERY PLAN SELECT kind, payload FROM events
        WHERE kind IN ('claim.resolve','claim.unresolve') AND entity='claim' AND entity_id=?
        ORDER BY ts DESC, rowid DESC LIMIT 1`,
      [claim],
    ) as any[];
    const detail = plan.map((r) => String(r.detail)).join(" | ");
    expect(detail).toContain("USING INDEX idx_events_kind_entity");
    expect(detail).not.toMatch(/\bSCAN events\b/);
  });
});
