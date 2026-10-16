/**
 * Startup diagnostics — DSH startup-diagnostics.ts exemplar.
 * Concise terminal summary; the full report lands at
 * $YGL_HOME/logs/startup-<uuid>.log (private by construction); a failed
 * save falls back to printing the complete report on stderr. Warns that
 * plugin error text may carry credentials — review before sharing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface StartupIssue {
  where: string;
  error: string;
}

export class StartupError extends Error {
  constructor(
    message: string,
    readonly issues: StartupIssue[],
  ) {
    super(message);
    this.name = "StartupError";
  }
}

export function reportStartupFailure(error: StartupError, home: string, version: string): string {
  const report = [
    `WARNING: raw diagnostics may contain configuration or credential values from plugin errors. Review before sharing.`,
    ``,
    `ygl-trees startup failure (${new Date().toISOString()})`,
    `version: ${version}`,
    `error: ${error.message}`,
    ``,
    `issues (${error.issues.length}):`,
    ...error.issues.map((i) => `  - [${i.where}] ${i.error}`),
    ``,
  ].join("\n");

  const logs = path.join(home, "logs");
  try {
    fs.mkdirSync(logs, { recursive: true });
    const file = path.join(logs, `startup-${randomUUID()}.log`);
    fs.writeFileSync(file, report, "utf8");
    process.stderr.write(`startup failed: ${error.message}\n  full report: ${file}\n`);
    return file;
  } catch {
    process.stderr.write(report);
    return "(printed to stderr — save failed)";
  }
}
