/**
 * ygl-trees user plugin demo (spec R14 L3, 0.36.0).
 *
 * Contract:
 *   exports.apply    — Cordis plugin body (services, event wiring); optional
 *   exports.commands — CLI command groups contributed to the dispatcher:
 *     { <group>: { run(env, action, rest, args) → rc } }
 *   args = { _: all positional tokens, flags: parsed options }; rest = args._.slice(2).
 *   Parsing details are current implementation behavior (unstable), not a frozen contract.
 *
 * A business-domain plugin follows the same shape: ship npm package or a
 * local directory, `ygl-trees plugin install <spec>`, done.
 */
"use strict";

exports.name = "ygl-plugin-demo";

// Cordis plugin body: runs at composition (after the base bundle).
exports.apply = (ctx, config = {}) => {
  // e.g. register a service: ctx.plugin(c => new (class extends (require("cordis").Service) {
  //   constructor() { super(c, "demoSvc"); }
  // })())
  void ctx;
  void config;
};

// Contributed command group: `ygl-trees demo ...`
exports.commands = {
  demo: {
    run(env, action, rest, args) {
      const { ctx } = env;
      if (action === "" || action === "hello") {
        if (ctx.json) console.log(JSON.stringify({ plugin: "ygl-plugin-demo", hello: "业务域插件已接通" }));
        else console.log("  demo plugin: hello from the user layer (R14 L3)");
        return 0;
      }
      if (action === "greet") {
        const name = args.flags.name ?? rest[0] ?? "world";
        if (typeof name !== "string" || !name.trim()) {
          if (ctx.json) console.log(JSON.stringify({ error: "--name needs a non-empty string value" }));
          else console.error("  --name needs a non-empty string value");
          return 2;
        }
        const greeting = "Hello, " + name;
        if (ctx.json) console.log(JSON.stringify({ plugin: "ygl-plugin-demo", greeting, name }));
        else console.log(greeting);
        return 0;
      }
      if (action === "env") {
        console.log("  loaded plugins: " + (env.plugins?.loaded || []).join(", "));
        console.log("  plugin commands: " + (env.plugins?.commands || []).join(", "));
        return 0;
      }
      console.error("  usage: ygl-trees demo [hello|greet [name] [--name value]|env]");
      return 2;
    },
  },
};
