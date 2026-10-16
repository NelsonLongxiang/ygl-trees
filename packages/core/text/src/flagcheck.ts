/**
 * Flag validation helpers (0.54): the cold-user audits found that bare flags
 * (parser returns boolean true) were silently stored as "true" strings, and
 * enum flags accepted arbitrary values. These helpers centralize the checks.
 */

import { Ctx, bad } from "../../../core/text/src/fmt";

/**
 * Reject bare flags (given without a value → parser yields boolean true).
 * Returns true if any flag failed (caller should `return 2`).
 *
 * Usage: `if (rejectBare(ctx, args.flags, ["title", "url"])) return 2;`
 */
export function rejectBare(ctx: Ctx, flags: any, names: string[]): boolean {
  for (const n of names) {
    if (flags[n] === true) {
      bad(ctx, `--${n} needs a value: --${n} "..."  (bare flag was treated as boolean)`);
      return true;
    }
  }
  return false;
}

/**
 * Validate an enum flag against allowed values. Empty/absent is OK (use
 * `required` to enforce presence). Returns true if validation failed.
 *
 * Usage: `if (validateEnum(ctx, args.flags, "confidence", ["A","B","C"])) return 2;`
 */
export function validateEnum(ctx: Ctx, flags: any, name: string, allowed: string[], required = false): boolean {
  const v = flags[name];
  if (v === undefined || v === "") {
    if (required) {
      bad(ctx, `--${name} is required (one of ${allowed.join("|")})`);
      return true;
    }
    return false;
  }
  if (v === true) {
    bad(ctx, `--${name} needs a value: one of ${allowed.join("|")}`);
    return true;
  }
  if (!allowed.includes(String(v))) {
    bad(ctx, `--${name} must be one of ${allowed.join("|")} (got: "${v}")`);
    return true;
  }
  return false;
}
