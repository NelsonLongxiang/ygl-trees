/** Instance-owned ORM lifecycle. Domain entity loading is supplied explicitly by the application. */
import type { DataSource } from "typeorm";
import { createEntitySelection, sealEntityCatalog, type EntityRegistration, type EntitySelection } from "./entity-catalog";
import type { OrmConnection, OrmTarget } from "./orm-connection";

export type { OrmTarget } from "./orm-connection";
export interface OrmAccess {
  getOrm(file: string): Promise<DataSource>;
  getPgOrm(url: string): Promise<DataSource>;
}
export interface ScopedOrm extends OrmAccess {
  close(): Promise<void>;
}
export interface ScopedOrmOptions {
  readonly target: OrmTarget;
  readonly selection: EntitySelection;
  readonly loadSelected: () => Promise<readonly EntityRegistration[]>;
}

/** Does not load TypeORM, entities, drivers, or open a database until the first matching get. */
export function createScopedOrm(options: ScopedOrmOptions): ScopedOrm {
  if (!options || typeof options.loadSelected !== "function") throw new Error("ORM entity loader is required");
  const dialect = options.target?.dialect;
  const address = dialect === "sqlite" ? options.target.file : dialect === "postgres" ? options.target.url : undefined;
  if (typeof address !== "string" || !address) throw new Error("invalid ORM target");
  const target: OrmTarget = Object.freeze(dialect === "sqlite" ? { dialect, file: address } : { dialect: "postgres", url: address });
  // Validate the branded selection and detach the chosen declarations from the caller.
  const selection = createEntitySelection(options.selection?.owners);
  const loadSelected = options.loadSelected;
  let closing = false;
  let opening: Promise<DataSource> | undefined;
  let closePromise: Promise<void> | undefined;
  let connection: OrmConnection | undefined;
  let cleanupFailure: Error | undefined;

  const closedError = () => new Error("ORM owner was closed during opening");
  const cleanupError = (errors: readonly unknown[]) => new AggregateError(errors, "ORM cleanup failed; owner is poisoned");
  const release = async () => {
    const current = connection;
    if (!current) return;
    try { await current.close(); connection = undefined; }
    catch (error) { cleanupFailure ??= cleanupError([error]); throw cleanupFailure; }
  };
  const open = (): Promise<DataSource> => {
    if (cleanupFailure) return Promise.reject(cleanupFailure);
    if (closing) return Promise.reject(closedError());
    if (opening) return opening;
    if (connection) return Promise.resolve(connection.dataSource);
    // Assign before the first loader callback or await, including module import and metadata validation.
    opening = Promise.resolve().then(async () => {
      if (closing) throw closedError();
      const registrations = await loadSelected();
      if (closing) throw closedError();
      const catalog = sealEntityCatalog(selection, registrations);
      if (closing) throw closedError();
      const { openOrmConnection } = await import("./orm-connection");
      if (closing) throw closedError();
      connection = await openOrmConnection(target, catalog, () => closing);
      if (closing) {
        await release();
        throw closedError();
      }
      return connection.dataSource;
    }).catch((error: unknown) => {
      const errors = error && (typeof error === "object" || typeof error === "function")
        ? (error as { ormCleanupErrors?: unknown }).ormCleanupErrors : undefined;
      if (Array.isArray(errors) && errors.length) {
        cleanupFailure ??= cleanupError(errors);
      }
      throw error;
    }).finally(() => { opening = undefined; });
    // close joins this attempt; a caller ignoring its own promise must not create a second orphan branch.
    void opening.catch(() => {});
    return opening;
  };
  const get = (mode: OrmTarget["dialect"], value: string) => mode === dialect && value === address ? open() : Promise.reject(new Error("ORM target does not match this owner"));
  return Object.freeze({
    getOrm: (file: string) => get("sqlite", file),
    getPgOrm: (url: string) => get("postgres", url),
    close() {
      if (closePromise) return closePromise;
      closing = true;
      const attempt = opening;
      closePromise = Promise.resolve().then(async () => {
        // An attempt owns any cleanup while it is starting; it never awaits this close promise itself.
        if (attempt) { try { await attempt; } catch { /* original get retains its primary error */ } }
        if (cleanupFailure) throw cleanupFailure;
        await release();
      });
      void closePromise.catch(() => {});
      return closePromise;
    },
  });
}
