/**
 * ygl-trees user plugin demo (spec R14 L3, 0.36.0).
 *
 * Contract:
 *   exports.apply    — Cordis plugin body (services, event wiring); optional
 *   exports.commands — CLI command groups contributed to the dispatcher:
 *     { <group>: { run(env, action, rest, args) → rc } }
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
    run(env, action, rest) {
      const { ctx } = env;
      if (action === "" || action === "hello") {
        if (ctx.json) console.log(JSON.stringify({ plugin: "ygl-plugin-demo", hello: "业务域插件已接通" }));
        else console.log("  demo plugin: hello from the user layer (R14 L3)");
        return 0;
      }
      if (action === "env") {
        console.log("  loaded plugins: " + (env.plugins?.loaded || []).join(", "));
        console.log("  plugin commands: " + (env.plugins?.commands || []).join(", "));
        return 0;
      }
      console.error("  usage: ygl-trees demo [hello|env]");
      return 2;
    },
  },
};
