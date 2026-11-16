import { describe, expect, it } from "vitest";
import { DOMAIN_MODULES } from "../src/domain-barrel";
import { run as verify } from "../../../packages/ops/tools/src/verify-cmds";
import { run as research } from "../../../packages/research/pipeline/src/cmds";
import { run as database } from "../../../packages/ops/tools/src/db-cmds";

describe("application command composition", () => {
  it("retains every routed group and exposes only its callable command entry", () => {
    expect(Object.keys(DOMAIN_MODULES).sort()).toEqual(["db","config","job","patrol","verify","agent","research","project","produce","task","tree","node","skill","kb","library","webui","doctor","rel"].sort());
    for (const command of Object.values(DOMAIN_MODULES)) { expect(Object.keys(command)).toEqual(["run"]); expect(typeof command.run).toBe("function"); }
  });
  it("retains actual command identities and shared alias routing without module namespace exposure", () => {
    expect(DOMAIN_MODULES.db.run).toBe(database); expect(DOMAIN_MODULES.verify.run).toBe(verify); expect(DOMAIN_MODULES.research.run).toBe(research);
    expect(DOMAIN_MODULES.task).toBe(DOMAIN_MODULES.produce); expect(DOMAIN_MODULES.node).toBe(DOMAIN_MODULES.tree);
  });
});
