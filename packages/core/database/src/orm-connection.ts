/** Domain-free DataSource creation, with instance-owned native resources even before initialize settles. */
import type { DataSource } from "typeorm";
import { assertEntityCatalogUnchanged, type EntityCatalog } from "./entity-catalog";
export type OrmTarget = { readonly dialect: "sqlite"; readonly file: string } | { readonly dialect: "postgres"; readonly url: string };
export interface OrmConnection { readonly dataSource: DataSource; close(): Promise<void> }

function withCleanup(primary: unknown, errors: readonly unknown[]): unknown {
  if (!errors.length) return primary;
  if (primary && (typeof primary === "object" || typeof primary === "function") && Object.isExtensible(primary)) {
    Object.defineProperty(primary, "ormCleanupErrors", { value: Object.freeze([...errors]), configurable: true });
    return primary;
  }
  const wrapped = new Error("ORM initialization failed; cleanup is unknown", { cause: primary });
  Object.defineProperty(wrapped, "ormCleanupErrors", { value: Object.freeze([...errors]) });
  return wrapped;
}

function nativeResources(target: OrmTarget) {
  const closers: Array<() => Promise<void>> = [];
  let driver: any;
  if (target.dialect === "sqlite") {
    const Native = require("better-sqlite3");
    driver = new Proxy(Native, {
      construct(Constructor, args) {
        const database: any = Reflect.construct(Constructor, args);
        const originalClose = database.close.bind(database);
        let attempted = false, failure: unknown;
        const close = () => {
          if (!attempted) {
            attempted = true;
            try { originalClose(); } catch (error) { failure = error; }
          }
          if (failure) throw failure;
        };
        // TypeORM can close during metadata failure; the fallback below joins the same native close result.
        database.close = close;
        closers.push(async () => { close(); });
        return database;
      },
    });
  } else {
    const pg = require("pg");
    class OwnedPool extends pg.Pool {
      #endPromise?: Promise<void>;
      constructor(options: any) {
        super(options);
        const end = this.end.bind(this);
        closers.push(() => end());
      }
      end(callback?: (error?: Error) => void): any {
        if (!this.#endPromise) {
          this.#endPromise = new Promise<void>((resolve, reject) => {
            super.end((error?: Error) => error ? reject(error) : resolve());
          });
          void this.#endPromise.catch(() => {});
        }
        if (callback) { void this.#endPromise.then(() => callback(), error => callback(error)); return; }
        return this.#endPromise;
      }
    }
    driver = { ...pg, Pool: OwnedPool };
  }
  return { driver, closers };
}

async function createConnection(target: OrmTarget, catalog: EntityCatalog, cancelled: () => boolean): Promise<OrmConnection> {
  assertEntityCatalogUnchanged(catalog);
  if (cancelled()) throw new Error("ORM owner closed before connection creation");
  const { DataSource } = await import("typeorm");
  assertEntityCatalogUnchanged(catalog);
  if (cancelled()) throw new Error("ORM owner closed before connection creation");
  const resources = nativeResources(target);
  const entities = [...catalog.entities];
  const ds = new DataSource(target.dialect === "sqlite"
    ? { type: "better-sqlite3", database: target.file, driver: resources.driver, entities, synchronize: false }
    : { type: "postgres", url: target.url, driver: resources.driver, entities, synchronize: false, connectTimeoutMS: 4000,
      poolErrorHandler: () => { console.error("ORM PostgreSQL pool failed; connection state may be unavailable"); } });
  const buildMetadata = (ds as any).buildMetadatas.bind(ds);
  (ds as any).buildMetadatas = async () => {
    assertEntityCatalogUnchanged(catalog);
    await buildMetadata();
    assertEntityCatalogUnchanged(catalog);
  };
  let starting = true;
  let destroyPromise: Promise<void> | undefined;
  const cleanupErrors: unknown[] = [];
  const rawDestroy = ds.destroy.bind(ds);
  ds.destroy = () => {
    if (!destroyPromise) { destroyPromise = Promise.resolve().then(rawDestroy); void destroyPromise.catch(() => {}); }
    // TypeORM calls destroy inside initialize's catch. Retain the primary metadata error if destroy also fails.
    return starting ? destroyPromise.catch(error => { if (!cleanupErrors.includes(error)) cleanupErrors.push(error); }) : destroyPromise;
  };
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      if (ds.isInitialized || destroyPromise) {
        try { await ds.destroy(); } catch (error) { if (!cleanupErrors.includes(error)) cleanupErrors.push(error); }
      }
      for (const release of resources.closers) {
        try { await release(); } catch (error) { if (!cleanupErrors.includes(error)) cleanupErrors.push(error); }
      }
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "ORM native resources could not be confirmed closed");
    });
    void closing.catch(() => {});
    return closing;
  };
  try {
    await ds.initialize();
    if (target.dialect === "sqlite") {
      await ds.query("PRAGMA synchronous=NORMAL");
      await ds.query("PRAGMA busy_timeout=10000");
    }
    starting = false;
    return Object.freeze({ dataSource: ds, close });
  } catch (primary) {
    starting = false;
    try { await close(); }
    catch (error) { throw withCleanup(primary, error instanceof AggregateError ? error.errors : [error]); }
    throw primary;
  }
}

/** Existing six-attempt SQLite lock budget; no retry if cleanup cannot be confirmed. */
export async function openOrmConnection(target: OrmTarget, catalog: EntityCatalog, cancelled: () => boolean): Promise<OrmConnection> {
  for (let attempt = 0; ; attempt++) {
    if (cancelled()) throw new Error("ORM owner closed before connection creation");
    try { return await createConnection(target, catalog, cancelled); }
    catch (error: any) {
      if (target.dialect !== "sqlite" || error?.ormCleanupErrors?.length || attempt === 5 || !/database is locked|SQLITE_BUSY/i.test(String(error?.message ?? error))) throw error;
      if (cancelled()) throw new Error("ORM owner closed before connection retry");
      await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt + Math.random() * 80));
    }
  }
}
