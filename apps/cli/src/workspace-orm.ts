/** Application composition is the only layer that selects domain entities for a workspace. */
import { createEntitySelection } from "../../../packages/core/database/src/entity-catalog";
import { CORE_ENTITY_MANIFEST } from "../../../packages/core/database/src/entity-manifest";
import { RESEARCH_ENTITY_MANIFEST } from "../../../packages/research/pipeline/src/entity-manifest";
import { createScopedOrm, type OrmTarget, type ScopedOrm } from "../../../packages/core/database/src/scoped-orm";

export function createWorkspaceOrm(target: OrmTarget): ScopedOrm {
  return createScopedOrm({
    target,
    selection: createEntitySelection([CORE_ENTITY_MANIFEST, RESEARCH_ENTITY_MANIFEST]),
    loadSelected: async () => {
      const [core, research] = await Promise.all([
        import("../../../packages/core/database/src/entities"),
        import("../../../packages/research/pipeline/src/entities"),
      ]);
      return [...core.CORE_ENTITY_REGISTRATIONS, ...research.RESEARCH_ENTITY_REGISTRATIONS];
    },
  });
}
