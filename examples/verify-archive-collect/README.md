---
name: archive collection verification example
description: Collect raw tar/tgz observations with verify collect archive, then judge them with a contract 1.3 spec (glob path grammar, hashes, duplicates, types); failed reads never pass.
kind: reference
---

# Verify a release tarball from raw observations

This example covers the #232 release-audit cases on contract 1.3 (#80):
- `verify collect archive` records what is in a tarball as rows: one per header, with the path bytes, type, size, mode, payload sha256, whether the header checksum is right, and the PAX keys. It writes no `ok`, `changed` or `invalid` columns.
- A failed or partial read is recorded as an `archive_errors` row. It is never dropped.
- The spec in this directory judges the rows with the frozen predicate AST, and nothing else.

The cases are a differing hash, a missing path, an extra path, a duplicate entry, empty input, malformed paths (absolute, `..`, empty segment, backslash, control character, outside `package/`), a symlink, a bad header checksum, a truncated archive, and the extraction bound.

`make-archives.mjs` builds every case byte for byte with a minimal ustar writer, so the inputs are identical on every machine. `packages/ops/tools/tests/verify-collect-archive.spec.ts` runs this same material, candidates file and reviews file against every case.

## Run it

Run from a source checkout after `pnpm build`, with a private test home under the ignored `tmp/` directory:

```bash
mkdir -p tmp/archive-example
node examples/verify-archive-collect/make-archives.mjs tmp/archive-example/cases
export YGL_HOME="$PWD/tmp/archive-example/home"
node dist/bundle/bin.cjs db init --json
node dist/bundle/bin.cjs verify collect archive tmp/archive-example/cases/good.tgz --out tmp/archive-example/good.sqlite --json
node dist/bundle/bin.cjs verify submit --title "release tarball" --text examples/verify-archive-collect/material.md --meta-repo "$PWD" --json > tmp/archive-example/submitted.json
MATERIAL_ID=$(node -p 'JSON.parse(require("fs").readFileSync("tmp/archive-example/submitted.json","utf8")).material_id')
node dist/bundle/bin.cjs verify prepare "$MATERIAL_ID" --candidates examples/verify-archive-collect/candidates.json --reviews examples/verify-archive-collect/reviews.json --db tmp/archive-example/good.sqlite --as-of 2026-11-11T00:00:00Z --candidates-author example-candidates --reviews-author example-reviews --meta-repo "$PWD" --json > tmp/archive-example/prepared.json
SPEC_ID=$(node -p 'JSON.parse(require("fs").readFileSync("tmp/archive-example/prepared.json","utf8")).spec_id')
node dist/bundle/bin.cjs verify run "$SPEC_ID" --db tmp/archive-example/good.sqlite --json
```

The spec freezes as contract 1.3, because it uses `glob` / `not-glob`. The good package passes all six clauses.

Then collect and run any other case:

```bash
node dist/bundle/bin.cjs verify collect archive tmp/archive-example/cases/truncated.tgz --out tmp/archive-example/truncated.sqlite --json
node dist/bundle/bin.cjs verify run "$SPEC_ID" --db tmp/archive-example/truncated.sqlite --json
```

| Case | What the report shows |
|---|---|
| `hash-differs` | S1 FAIL. `evidence.rows` carries the observed `payload_sha256`; `evidence.rendered.findSql` carries the expected hash. |
| `missing-path` / `extra-path` / `duplicate` | S2 / S3 / S4 FAIL, with the raw `path` in `evidence.rows`. |
| `dotdot-path`, `absolute-path`, `empty-segment`, `backslash-path`, `control-char-path`, `outside-package` | S5 FAIL, naming the raw path. |
| `symlink` | S6 FAIL (`typeflag` `2`). |
| `empty-file` | `archive_errors` has an `empty_input` row, and `archive_entries` has none. No clause passes. |
| `empty-archive` | No error rows and no entries. The zero-scan rule makes every clause NEEDS-MATERIAL, never PASS. |
| `truncated`, `bad-checksum`, `--max-entries 2` on `good` | The error rows are `truncated`, `malformed_header` and `bound_entries`. Every clause that would pass is ERROR instead (`input_errors: … in archive_errors`). |

## Rules this relies on

- **Read-only and deterministic.** The collector only reads its input, and it refuses an existing `--out`. The same input gives a byte-identical snapshot. rc is 0 whenever the snapshot was written, including when it holds error rows, because a failed read is data.
- **Bounded.** `--max-entries`, `--max-bytes` (decompressed payload) and `--max-path` default to 100 000, 1 GiB and 4096. The limits are recorded in `archive_meta`. Reaching one writes an error row and stops collection.
- **No silent empty pass.** For a 1.3 spec, rows in `archive_errors` turn every assert unit that would PASS into ERROR. FAIL stays FAIL. A snapshot with no entries is a zero scan, which is never a PASS.
- **No GROUP BY in the AST.** Duplicates are expressed through `path_occurrence`, the raw 1-based count of earlier rows with the same path.

`candidates.json` and `reviews.json` are generated from `material.md` by `gen-candidates.mjs`. The review file is instructional self-review, not an independent reviewer's attestation: replace it with genuine review input for a real release gate.
