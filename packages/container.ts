/**
 * ygl-trees ServiceContainer — 50-line lightweight DI container.
 * Follows deepseek-harness's Service separation patterns without the
 * Cordis framework dependency. Each domain registers a service; services
 * access each other through the container (no circular imports).
 */
export class Container {
  private services = new Map<string, any>();

  register<T>(name: string, factory: (c: Container) => T): T {
    const svc = factory(this);
    this.services.set(name, svc);
    return svc;
  }

  get<T>(name: string): T {
    const svc = this.services.get(name);
    if (!svc) throw new Error(`service not registered: ${name}`);
    return svc;
  }

  has(name: string): boolean {
    return this.services.has(name);
  }

  dispose(): void {
    for (const svc of this.services.values()) {
      if (typeof svc.dispose === "function") svc.dispose();
    }
    this.services.clear();
  }
}

// ── Typed service names (compile-time contract, no framework needed) ──
export type ServiceName = "database" | "research" | "techtree" | "knowledge" | "ops";
