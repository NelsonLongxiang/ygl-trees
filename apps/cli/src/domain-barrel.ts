/**
 * Domain route barrel — statically imports all domain command modules so
 * tsdown/rolldown can trace them into the bundle (dynamic `require(route)`
 * is invisible to the bundler). The map below is the single source of truth
 * for group → module resolution.
 *
 * @module @ygl/cli/domain-barrel
 */
import * as dbCmds from "../../../packages/ops/tools/src/db-cmds";
import * as configCmds from "../../../packages/ops/tools/src/config-cmds";
import * as jobCmds from "../../../packages/ops/tools/src/job-cmds";
import * as patrolCmds from "../../../packages/ops/tools/src/patrol-cmds";
import * as agentCmds from "../../../packages/ops/tools/src/agent-cmds";
import * as researchCmds from "../../../packages/research/pipeline/src/cmds";
import * as projectCmds from "../../../packages/research/produce/src/project-cmds";
import * as produceCmds from "../../../packages/research/produce/src/produce-cmds";
import * as treeCmds from "../../../packages/techtree/model/src/cmds";
import * as skillCmds from "../../../packages/knowledge/skills/src/skill-cmds";
import * as kbCmds from "../../../packages/knowledge/skills/src/cmds";
import * as webui from "../../../packages/ops/tools/src/webui";
import * as doctor from "../../../packages/ops/tools/src/doctor";
import * as rels from "../../../packages/ops/tools/src/rels";

/** group → statically imported module (bundle-traceable) */
export const DOMAIN_MODULES: Record<string, { run: (env: any, action: string, rest: string[], args: any) => number | Promise<number> }> = {
  db: dbCmds,
  config: configCmds,
  job: jobCmds,
  patrol: patrolCmds,
  agent: agentCmds,
  research: researchCmds,
  project: projectCmds,
  produce: produceCmds,
  task: produceCmds, // task group rides the produce router
  tree: treeCmds,
  node: treeCmds,
  skill: skillCmds,
  kb: kbCmds,
  webui,
  doctor,
  rel: rels,
};
