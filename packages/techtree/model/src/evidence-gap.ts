/**
 * #233: the lifecycle rule "unlock → attach the evidence in the same round", brought to where the action happens.
 *
 * The rule used to live only in the lifecycle skill, and a read-only audit found 167 of 267 unlocked nodes with
 * nothing behind them. These queries let `node unlock`, `node import`, `doctor` and `agent brief` name such nodes.
 *
 * "Evidence" here is a relation (either direction) between the node and anything that can justify it: evidence,
 * claim, source, artifact or kb. A task, a query, a skill or another node does not count. That is the same set the
 * #233 audit counted as "no relation of any kind".
 *
 * The SQL uses `?` placeholders only, so it runs on the SQLite handle and through AsyncTreeStore on PG alike.
 */
export const EVIDENCE_REL_TYPES = ["evidence", "claim", "source", "artifact", "kb"] as const;

const IN = EVIDENCE_REL_TYPES.map((t) => `'${t}'`).join(",");
const HAS_EVIDENCE =
  `EXISTS (SELECT 1 FROM relations r WHERE (r.src_type='node' AND r.src_id=n.id AND r.dst_type IN (${IN}))` +
  ` OR (r.dst_type='node' AND r.dst_id=n.id AND r.src_type IN (${IN})))`;
const UNLOCKED = "EXISTS (SELECT 1 FROM node_state s WHERE s.node_id=n.id AND s.status='unlocked')";

/** Unlocked nodes (in any context) with no evidence-like relation, every tree. Columns: tree, key, id. */
export const UNLOCKED_WITHOUT_EVIDENCE_SQL =
  `SELECT t.name AS tree, n.key AS key, n.id AS id FROM nodes n JOIN trees t ON t.id=n.tree_id` +
  ` WHERE ${UNLOCKED} AND NOT ${HAS_EVIDENCE} ORDER BY t.name, n.key`;

/** Same, for one tree: bind the tree id. */
export const UNLOCKED_WITHOUT_EVIDENCE_IN_TREE_SQL =
  `SELECT t.name AS tree, n.key AS key, n.id AS id FROM nodes n JOIN trees t ON t.id=n.tree_id` +
  ` WHERE n.tree_id=? AND ${UNLOCKED} AND NOT ${HAS_EVIDENCE} ORDER BY n.key`;

/** One row (hit=1) when the node, by id, has an evidence-like relation. */
export const NODE_HAS_EVIDENCE_SQL = `SELECT 1 AS hit FROM nodes n WHERE n.id=? AND ${HAS_EVIDENCE}`;

export type EvidenceGapRow = { tree: string; key: string; id?: string };

/** Count per tree, in tree-name order, with every key kept for the caller to cut. */
export function groupByTree(rows: EvidenceGapRow[]): Array<{ tree: string; count: number; keys: string[] }> {
  const by = new Map<string, string[]>();
  for (const r of rows) {
    const list = by.get(r.tree) ?? [];
    list.push(r.key);
    by.set(r.tree, list);
  }
  return [...by.entries()].map(([tree, keys]) => ({ tree, count: keys.length, keys }));
}

/** A tree/key ref as one shell word, for a next_action line.
 *  Same rule as agent brief's G13 quoting (#105/#106): control characters are escaped so the action stays one line,
 *  and the whole word is single-quoted so `;`, `$()` or a leading `=`/`-` never become shell syntax. */
export function shellWord(value: string): string {
  const oneLine = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, (c) =>
    c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\t" ? "\\t" : "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0")
  );
  return "'" + oneLine.replace(/'/g, "'\\''") + "'";
}

/** The same-round follow-up for an unlocked node with no evidence. `--rel evidenced-by` as the lifecycle skill says:
 *  without it the row lands as the weak default `related`. */
export function attachEvidenceAction(tree: string, key: string): string {
  return `ygl-trees rel add ${shellWord(`node:${tree}/${key}`)} evidence:<evidenceId> --rel evidenced-by`;
}

/** The same-round follow-up after a structural change left the index dirty. */
export function reindexActions(tree: string): string[] {
  return [`ygl-trees node index --tree=${shellWord(tree)}`, `ygl-trees node validate --tree=${shellWord(tree)}`];
}
