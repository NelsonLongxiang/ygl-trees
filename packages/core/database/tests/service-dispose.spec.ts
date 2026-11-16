import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { DatabaseService, apply } from "../src/plugin";
import { InvocationOwner } from "../src/invocation";

const roots: string[] = [], services: DatabaseService[] = [];
function fixture() { fs.mkdirSync(path.join(process.cwd(), "tmp"), { recursive: true }); const dir = fs.mkdtempSync(path.join(process.cwd(), "tmp/service-dispose-")); roots.push(dir); return path.join(dir, "workspace.db"); }
afterEach(async () => { vi.restoreAllMocks(); for (const service of services.splice(0)) service.db.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); vi.unstubAllEnvs(); });
describe("private DatabaseService lifecycle owner", () => {
  it.each(["plugin", "direct"])("closes the private %s owner on real Cordis disposal", async mode => {
    vi.stubEnv("YGL_TEST", ""); vi.stubEnv("YGL_SERVE", ""); const file = fixture(), app = new Context(); let service: DatabaseService;
    if (mode === "plugin") { const fiber = app.plugin(apply, { file }); await fiber.await(); service = app.get("database")!; services.push(service); expect(fs.existsSync(file + ".ygllock")).toBe(true); await fiber.dispose(); }
    else { service = new DatabaseService(app, file); services.push(service); await app.fiber.dispose(); }
    expect(() => service.db.get("SELECT 1")).toThrow(); expect(fs.existsSync(file + ".ygllock")).toBe(false); await service.stop();
  });
  it("retains the strict failure receipt and lock after failed private cleanup", async () => {
    vi.stubEnv("YGL_TEST", ""); const file = fixture(), app = new Context(), fiber = app.plugin(apply, { file }); await fiber.await(); const service = app.get("database")!; services.push(service);
    const failed = vi.spyOn(service.db.db, "close").mockImplementation(() => { throw new Error("native close unknown"); });
    try { await fiber.dispose(); await expect(service.stop()).rejects.toThrow(/cleanup/); expect(service.db.get("SELECT 1 n")).toEqual({ n: 1 }); expect(fs.existsSync(file + ".ygllock")).toBe(true); }
    finally {
      failed.mockRestore();
      service.db.db.close();
      services.splice(services.indexOf(service), 1);
    }
  });
  it("does not close a borrowed application owner when only the service plugin unloads", async () => {
    const file = fixture(), app = new Context(), owner = new InvocationOwner(), fiber = app.plugin(apply, { file, owner }); await fiber.await(); const service = app.get("database")!; services.push(service);
    await fiber.dispose(); expect(service.db.get("SELECT 1 n")).toEqual({ n: 1 }); await owner.close(); expect(() => service.db.get("SELECT 1")).toThrow();
  });
});
