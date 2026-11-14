/** Market grant key syntax. Empty is unattributed; ids are opaque to ygl-trees. */
export function validateScope(raw: unknown): string {
  if (raw === undefined || raw === "") return "";
  if (typeof raw === "string" && (raw === "*" || raw === "restricted" || /^(dept|bench):[A-Za-z0-9._-]{1,64}$/.exec(raw)?.[0] === raw)) return raw;
  throw Object.assign(new Error("scope must be empty, dept:<id>, bench:<id>, * or restricted; id must match [A-Za-z0-9._-]{1,64}"), { rc: 2 });
}
