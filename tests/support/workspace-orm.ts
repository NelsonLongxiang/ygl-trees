/** Each direct-consumer test suite explicitly owns its workspace ORM connections. */
import { createWorkspaceOrm } from "../../apps/cli/src/workspace-orm";
import type { OrmAccess, ScopedOrm } from "../../packages/core/database/src/scoped-orm";

export function createWorkspaceOrmFixture(): OrmAccess & { closeOrm(): Promise<void> } {
  const owners = new Map<string, ScopedOrm>();
  function owner(dialect: "sqlite" | "postgres", value: string): ScopedOrm {
    const key = JSON.stringify([dialect, value]);
    let current = owners.get(key);
    if (!current) { current = createWorkspaceOrm(dialect === "sqlite" ? { dialect, file: value } : { dialect, url: value }); owners.set(key, current); }
    return current;
  }
  return Object.freeze({
    getOrm: (file: string) => owner("sqlite", file).getOrm(file),
    getPgOrm: (url: string) => owner("postgres", url).getPgOrm(url),
    closeOrm: async () => {
      const settled = await Promise.allSettled([...owners.values()].map(value => value.close()));
      const errors = settled.filter((row): row is PromiseRejectedResult => row.status === "rejected").map(row => row.reason);
      if (errors.length) throw new AggregateError(errors, "test-owned ORM cleanup failed");
      owners.clear();
    },
  });
}
