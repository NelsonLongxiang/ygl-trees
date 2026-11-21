/**
 * Domain route barrel — statically imports all domain command modules so
 * tsdown/rolldown can trace them into the bundle (dynamic `require(route)`
 * is invisible to the bundler). The map below is the single source of truth
 * for group → module resolution.
 *
 * @module @ygl/cli/domain-barrel
 */
import { run as dbCmdsRun } from "../../../packages/ops/tools/src/db-cmds";
import { run as configCmdsRun } from "../../../packages/ops/tools/src/config-cmds";
import { run as jobCmdsRun } from "../../../packages/ops/tools/src/job-cmds";
import { run as patrolCmdsRun } from "../../../packages/ops/tools/src/patrol-cmds";
import { run as verifyCmdsRun } from "../../../packages/ops/tools/src/verify-cmds";
import { run as agentCmdsRun } from "../../../packages/ops/tools/src/agent-cmds";
import { run as researchCmdsRun } from "../../../packages/research/pipeline/src/cmds";
import { run as projectCmdsRun } from "../../../packages/research/produce/src/project-cmds";
import { run as produceCmdsRun } from "../../../packages/research/produce/src/produce-cmds";
import { run as treeCmdsRun } from "../../../packages/techtree/model/src/cmds";
import { run as skillCmdsRun } from "../../../packages/knowledge/skills/src/skill-cmds";
import { run as kbCmdsRun } from "../../../packages/knowledge/skills/src/cmds";
import { run as webuiRun } from "../../../packages/ops/tools/src/webui";
import { run as doctorRun } from "../../../packages/ops/tools/src/doctor";
import { run as relsRun } from "../../../packages/ops/tools/src/rels";
import { run as libraryCmdsRun } from "../../../packages/ops/tools/src/library-cmds";

export { runProjectSync } from "../../../packages/ops/tools/src/project-sync";
export { createWorkspaceOrm } from "./workspace-orm";

const dbCmds = { run: dbCmdsRun };
const configCmds = { run: configCmdsRun };
const jobCmds = { run: jobCmdsRun };
const patrolCmds = { run: patrolCmdsRun };
const verifyCmds = { run: verifyCmdsRun };
const agentCmds = { run: agentCmdsRun };
const researchCmds = { run: researchCmdsRun };
const projectCmds = { run: projectCmdsRun };
const produceCmds = { run: produceCmdsRun };
const treeCmds = { run: treeCmdsRun };
const skillCmds = { run: skillCmdsRun };
const kbCmds = { run: kbCmdsRun };
const webui = { run: webuiRun };
const doctor = { run: doctorRun };
const rels = { run: relsRun };
const libraryCmds = { run: libraryCmdsRun };

/** group → statically imported module (bundle-traceable) */
export const DOMAIN_MODULES: Record<string, { run: (env: any, action: string, rest: string[], args: any) => number | Promise<number> }> = {
  db: dbCmds,
  config: configCmds,
  job: jobCmds,
  patrol: patrolCmds,
  verify: verifyCmds,
  agent: agentCmds,
  research: researchCmds,
  project: projectCmds,
  produce: produceCmds,
  task: produceCmds, // task group rides the produce router
  tree: treeCmds,
  node: treeCmds,
  skill: skillCmds,
  kb: kbCmds,
  library: libraryCmds,
  webui,
  doctor,
  rel: rels,
};
