/**
 * Batch-nine P2-1 (user report): the only repair channel for a wrong
 * claim↔evidence link was `db sql` DELETE — it silently left the claim status
 * lying (still `supported` with zero evidence), skipped the audit trail, and
 * could not express "delete this evidence but keep the claims coherent".
 *
 * claimUnlink  → remove one link, recompute status from the remaining links,
 *                prediction claims keep their (human-arbitrated) status.
 * evidenceRemove → refuse while links exist; --force cascades and recomputes
 *                every affected claim in the same transaction.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB } from "../../../core/database/src/db";
import { getOrm, closeOrm } from "../../../core/database/src/orm";
import * as writes from "../src/writes";
import { resolveProject } from "../../../core/database/src/selection";

let db: DB;
let dir: string;
let pid: string;

beforeAll(async () => {
  dir = path.join(process.cwd(), "tmp", `unlink-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  db = new DB(path.join(dir, "t.db"));
  const ds = await getOrm(db.path!);
  const p = await writes.projectCreate(ds, "unlink", "unlink fixture");
  pid = p.id as string;
  await closeOrm();
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function fixture(text: string, quote: string) {
  const ds = await getOrm(db.path!);
  const src = await writes.sourceAdd(ds, pid, { title: quote, url: `session://unlink/${quote}` });
  const ev = await writes.evidenceAdd(ds, pid, src.row.id, quote);
  const c = await writes.claimAdd(ds, pid, text, "B");
  await closeOrm();
  return { ds: null, claim: c.row.id as string, evidence: ev.row.id as string };
}

describe("claimUnlink", () => {
  it("removes the link and recomputes status (supported → unverified)", async () => {
    const { claim, evidence } = await fixture("plain claim about billing", "billing quote");
    const ds = await getOrm(db.path!);
    const linked = await writes.claimLink(ds, claim, evidence, "supports");
    expect(linked.status).toBe("supported");
    const r = await writes.claimUnlink(ds, claim, evidence);
    expect(r.recalculated).toBe(true);
    expect(r.status).toBe("unverified");
    expect(r.stance).toBe("supports");
    expect(db.get("SELECT COUNT(*) AS c FROM claim_evidence WHERE claim_id=?", [claim])).toEqual({ c: 0 });
    expect((db.get("SELECT status FROM claims WHERE id=?", [claim]) as any).status).toBe("unverified");
    const ev = db.get("SELECT kind, payload FROM events WHERE kind='claim.unlink' ORDER BY rowid DESC LIMIT 1") as any;
    expect(ev.kind).toBe("claim.unlink");
    expect(String(ev.payload)).toContain("supports");
    await closeOrm();
  });

  it("keeps a prediction claim's status (evidence is not arbitration)", async () => {
    const { claim, evidence } = await fixture("[预测·7天] 2026-11-01 前某指标达标", "prediction quote");
    const ds = await getOrm(db.path!);
    await writes.claimLink(ds, claim, evidence, "supports");
    await writes.claimResolve(ds, claim, "supported", "operator arbitration");
    const r = await writes.claimUnlink(ds, claim, evidence);
    expect(r.recalculated).toBe(false);
    expect(r.status).toBe("supported");
    await closeOrm();
  });

  it("names a missing link instead of deleting nothing", async () => {
    const { claim, evidence } = await fixture("unlinked claim", "unlinked quote");
    const ds = await getOrm(db.path!);
    await expect(writes.claimUnlink(ds, claim, evidence)).rejects.toThrow(/link not found: claim .*↔ evidence/);
    await closeOrm();
  });

  it("names a missing claim or evidence", async () => {
    const { claim, evidence } = await fixture("claim for missing ids", "quote for missing ids");
    const ds = await getOrm(db.path!);
    await expect(writes.claimUnlink(ds, "cls_missing", evidence)).rejects.toThrow(/claim not found: cls_missing/);
    await expect(writes.claimUnlink(ds, claim, "evd_missing")).rejects.toThrow(/evidence not found: evd_missing/);
    await closeOrm();
  });
});

describe("evidenceRemove", () => {
  it("refuses while claims link it and names the repair command", async () => {
    const { claim, evidence } = await fixture("claim guarding evidence", "guarded quote");
    const ds = await getOrm(db.path!);
    await writes.claimLink(ds, claim, evidence, "supports");
    await expect(writes.evidenceRemove(ds, evidence)).rejects.toThrow(
      /is linked to 1 claim\(s\): .* — unlink first \(research claim unlink <claim> .*\) or pass --force to cascade/
    );
    expect(db.get("SELECT COUNT(*) AS c FROM evidence WHERE id=?", [evidence])).toEqual({ c: 1 });
    await closeOrm();
  });

  it("cascades with --force: links gone, affected statuses recomputed", async () => {
    const { claim, evidence } = await fixture("claim to cascade", "cascade quote");
    const ds = await getOrm(db.path!);
    await writes.claimLink(ds, claim, evidence, "supports");
    const r = await writes.evidenceRemove(ds, evidence, true);
    expect(r.forced).toBe(true);
    expect(r.unlinked).toEqual([claim]);
    expect(r.statuses[claim]).toBe("unverified");
    expect(db.get("SELECT COUNT(*) AS c FROM claim_evidence WHERE evidence_id=?", [evidence])).toEqual({ c: 0 });
    expect(db.get("SELECT COUNT(*) AS c FROM evidence WHERE id=?", [evidence])).toEqual({ c: 0 });
    expect((db.get("SELECT status FROM claims WHERE id=?", [claim]) as any).status).toBe("unverified");
    const ev = db.get("SELECT payload FROM events WHERE kind='evidence.rm' ORDER BY rowid DESC LIMIT 1") as any;
    expect(String(ev.payload)).toContain("cascaded: 1 link(s)");
    await closeOrm();
  });

  it("reports forced as the input flag and cascaded as the link count", async () => {
    const { evidence } = await fixture("no links here", "unlinked quote");
    const ds = await getOrm(db.path!);
    const r = await writes.evidenceRemove(ds, evidence, true); // --force, nothing to cascade
    expect(r.forced).toBe(true);
    expect(r.cascaded).toBe(0);
    expect(r.unlinked).toEqual([]);
    await closeOrm();
  });

  it("deletes an unlinked evidence without ceremony", async () => {
    const { evidence } = await fixture("orphan claim", "orphan quote");
    const ds = await getOrm(db.path!);
    const r = await writes.evidenceRemove(ds, evidence);
    expect(r.forced).toBe(false);
    expect(r.unlinked).toEqual([]);
    expect(db.get("SELECT COUNT(*) AS c FROM evidence WHERE id=?", [evidence])).toEqual({ c: 0 });
    // External review #6: the FTS shadow must die with the base row, in the
    // same transaction (write-path rule 1). A leftover shadow is searchable
    // evidence whose base row no longer exists.
    expect(db.get("SELECT COUNT(*) AS c FROM evidence_fts WHERE id=?", [evidence])).toEqual({ c: 0 });
    await closeOrm();
  });
});

describe("sourceRemove (issue #7)", () => {
  it("refuses while evidence rows exist and names the cascade", async () => {
    const { evidence } = await fixture("claim for source guard", "guarded source quote");
    const sid = (db.get("SELECT source_id FROM evidence WHERE id=?", [evidence]) as any).source_id;
    const ds = await getOrm(db.path!);
    await expect(writes.sourceRemove(ds, sid)).rejects.toThrow(
      /still has 1 evidence row\(s\)[\s\S]*pass --force to cascade/
    );
    expect(db.get("SELECT COUNT(*) AS c FROM sources WHERE id=?", [sid])).toEqual({ c: 1 });
    await closeOrm();
  });

  it("cascades with --force: evidence, links and FTS shadows gone; claims recomputed", async () => {
    const { claim, evidence } = await fixture("claim to be stranded", "cascade source quote");
    const sid = (db.get("SELECT source_id FROM evidence WHERE id=?", [evidence]) as any).source_id;
    const ds = await getOrm(db.path!);
    await writes.claimLink(ds, claim, evidence, "supports");
    const r = await writes.sourceRemove(ds, sid, true);
    expect(r.forced).toBe(true);
    expect(r.evidence_removed).toBe(1);
    expect(r.claims_recomputed).toBe(1);
    // GitHub #9: one JSON field, one type — cascaded is a count on both faces.
    expect(r.cascaded).toBe(1);
    expect(db.get("SELECT COUNT(*) AS c FROM evidence WHERE source_id=?", [sid])).toEqual({ c: 0 });
    expect(db.get("SELECT COUNT(*) AS c FROM evidence_fts WHERE id=?", [evidence])).toEqual({ c: 0 });
    expect(db.get("SELECT COUNT(*) AS c FROM sources_fts WHERE id=?", [sid])).toEqual({ c: 0 });
    expect((db.get("SELECT status FROM claims WHERE id=?", [claim]) as any).status).toBe("unverified");
    const ev = db.get("SELECT payload FROM events WHERE kind='source.rm' ORDER BY rowid DESC LIMIT 1") as any;
    expect(String(ev.payload)).toContain("cascaded: 1 evidence");
    await closeOrm();
  });
});

describe("selection attribution (K3 0.106.0)", () => {
  it("records actor = session id on writes; tree events also carry the resolved selection layer", async () => {
    const prevSid = process.env.YGL_SESSION;
    const prevVia = process.env.YGL_SELECTION_VIA;
    process.env.YGL_SESSION = "spec-via";
    db.metaSet("current_project@spec-via", "unlink");
    let ds: any = null;
    try {
      const sel = resolveProject(db);
      expect(sel.source).toBe("session");
      expect(process.env.YGL_SELECTION_VIA).toBe("session");

      // research writes log string payloads (frozen shape): only the actor is
      // attributed there; the tree domain logs object payloads, so `via` rides
      // along without changing the payload type of existing events.
      ds = await getOrm(db.path!);
      const c = await writes.claimAdd(ds, pid, "selection attribution claim");
      const claimEv = db.get("SELECT actor FROM events WHERE kind='claim.add' AND entity_id=?", [c.row.id]) as any;
      expect(claimEv.actor).toBe("spec-via");

      const treeWrites = await import("../../../techtree/model/src/writes");
      const t = await treeWrites.treeCreate(ds, "attr-tree", pid, "");
      const n = await treeWrites.nodeAdd(ds, t.id, { key: "attr-node" });
      const nodeEv = db.get("SELECT actor, payload FROM events WHERE kind='node.add' AND entity_id=?", [n.row.id]) as any;
      expect(nodeEv.actor).toBe("spec-via");
      expect(String(nodeEv.payload)).toContain('"via":"session"');
    } finally {
      if (ds) await closeOrm();
      if (prevSid === undefined) delete process.env.YGL_SESSION; else process.env.YGL_SESSION = prevSid;
      if (prevVia === undefined) delete process.env.YGL_SELECTION_VIA; else process.env.YGL_SELECTION_VIA = prevVia;
      db.run("DELETE FROM meta WHERE key=?", ["current_project@spec-via"]);
    }
  });
});
