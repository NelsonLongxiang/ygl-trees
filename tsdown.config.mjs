import { defineConfig } from "tsdown";

export default defineConfig({
  minify: true,
  // Decorated entities and plugin diagnostics rely on class/function names.
  outputOptions: { keepNames: true },
});
