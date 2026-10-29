import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import Artifacts, { day, groupArtifacts, type ArtifactMeta } from "../src/Artifacts";
import { artifactsExtra } from "../src/pages";

/**
 * Artifacts on real data: `produce report` regenerates the same report as
 * v1…v5, which the roster used to list as five identical rows with no dates.
 * One row per document now — latest version, its day — older versions folded.
 */
const a = (id: string, kind: string, title: string, version: number, created: string): ArtifactMeta => ({ id, kind, title, version, created });
const rows = [
  a("s1", "section", "预测台账", 1, "2026-10-22T14:46:18.099Z"),
  a("r1", "report", "taste report", 1, "2026-10-22T10:00:00.000Z"),
  a("r5", "report", "taste report", 5, "2026-10-22T14:46:18.222Z"),
  a("r3", "report", "taste report", 3, "2026-10-22T12:00:00.000Z"),
  a("d1", "design", "ADR：结合方案", 1, "2026-10-22T15:25:03.856Z"),
  a("x1", "memo", "自定义类型", 1, "2026-10-21T00:00:00.000Z"),
];

describe("groupArtifacts", () => {
  const g = groupArtifacts(rows);

  it("reports first, then designs, then working parts; unknown kinds last", () => {
    expect(g.map((k) => k.kind)).toEqual(["report", "design", "section", "memo"]);
  });

  it("same kind + title is one document: the latest version leads, older ones newest first", () => {
    const [report] = g[0].docs;
    expect(g[0].docs).toHaveLength(1);
    expect(report.latest.id).toBe("r5");
    expect(report.older.map((x) => x.id)).toEqual(["r3", "r1"]);
  });

  it("day is the UTC date the timeline uses", () => {
    expect(day("2026-10-22T23:59:59.000Z")).toBe("2026-10-22");
    expect(day("")).toBe("—");
  });
});

describe("Artifacts roster", () => {
  const html = renderToStaticMarkup(createElement(Artifacts, { artifacts: rows }));

  it("shows each document once with version and day, and folds the older versions", () => {
    expect((html.match(/taste report/g) ?? []).length).toBe(1);
    expect(html).toContain("v5 · 2026-10-22");
    expect(html).toContain("另有 2 个旧版本");
    expect(html).toContain('aria-expanded="false"');
  });

  it("the section header counts documents and versions apart", () => {
    expect(artifactsExtra(rows)).toBe("4 份文档 · 6 个版本");
    expect(artifactsExtra(rows.filter((r) => r.kind !== "report"))).toBe("3 份文档");
  });
});
