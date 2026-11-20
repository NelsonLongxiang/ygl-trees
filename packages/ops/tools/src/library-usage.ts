/** Workspace-free library argument contract shared by the API, CLI and MCP. */
export const LIBRARY_LIST_USAGE = "library list --kind <claim|note|skill|check> [--project <name>] [--scope <s>] [--since <iso>] [--limit 1..500] [--cursor <c>]";
export const LIBRARY_PROJECT_HELP = "--project filters claim; note/skill/check have no project (rc2)";
export class LibraryUsageError extends Error { readonly rc = 2; }
export function validateLibraryProject(project: unknown): void {
  if (project !== undefined && (typeof project !== "string" || !project.trim())) throw new LibraryUsageError("--project needs a nonempty project name");
}
