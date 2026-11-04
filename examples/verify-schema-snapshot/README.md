---
name: schema snapshot verification example
description: Read-only SQLite metadata collection into an independent evidence snapshot, verified using contract 1.2 predicates.
kind: reference
---

# Verify a column without extending predicate.from

Contract 1.2 predicates accept table identifiers, not PRAGMA calls, arbitrary subqueries or view definitions. This example satisfies the alternative-path part of [#80](https://github.com/NelsonLongxiang/ygl-trees/issues/80): collect metadata into ordinary tables, then verify those rows. It does **not** implement contract 1.3, registered in-memory views, index predicates or general derived relations. Never bypass P2 with raw SQL to imitate those features.

## Preconditions

Run from a source checkout with Node >=24 and a built CLI. The collector uses Node standard-library SQLite, not the published CLI runtime requirement. Source must be an existing, quiescent standalone SQLite snapshot, not a live WAL database. Nonempty `-wal` / `-journal` causes rejection; first obtain a consistent SQLite backup using the source application’s supported snapshot method. Do not just copy a live main file and discard sidecars.

Only read-only `sqlite_schema`, bound `pragma_table_info(?)` and `PRAGMA user_version` are queried. Table names from metadata are parameter values, never interpolated SQL. Views are not evaluated; a view-only relation does not satisfy a table criterion. All DDL creates a **new independent evidence DB**, never edits the source. This is a caller-side collection example, not a new engine query surface.

## Run the example

Use a private test home and a fresh output path. The following Git Bash commands stay under the checkout’s ignored tmp directory. The fixture review file is instructional self-review, not an independent reviewer attestation; prepare records matching author ids with a diagnostic. Replace it with genuine review input for an independently reviewed business verifier.

```bash
mkdir -p tmp/schema-example
node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("tmp/schema-example/source.sqlite");db.exec("CREATE TABLE orders(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)");db.close();'
node examples/verify-schema-snapshot/collect.mjs tmp/schema-example/source.sqlite tmp/schema-example/evidence.sqlite > tmp/schema-example/producer.json
YGL_HOME="$PWD/tmp/schema-example/home" node dist/bundle/bin.cjs db init --json
YGL_HOME="$PWD/tmp/schema-example/home" node dist/bundle/bin.cjs verify submit --title "Schema metadata example" --text examples/verify-schema-snapshot/material.md --meta-repo "$PWD" --json > tmp/schema-example/submitted.json
```

The source fixture must be newly created; the collector refuses an existing evidence output, source-as-output or source-sidecar output. Do not delete arbitrary files to make a repeated example pass: choose a new private directory. Next, derive identifiers and the collection timestamp from actual receipts, not a sample id or the wall clock at prepare time:

```bash
MATERIAL_ID=$(node -p 'JSON.parse(require("fs").readFileSync("tmp/schema-example/submitted.json","utf8")).material_id')
AS_OF=$(node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("tmp/schema-example/evidence.sqlite",{readOnly:true});console.log(db.prepare("SELECT captured_at FROM collection_source").get().captured_at);db.close();')
YGL_HOME="$PWD/tmp/schema-example/home" node dist/bundle/bin.cjs verify prepare "$MATERIAL_ID" --candidates examples/verify-schema-snapshot/candidates.json --reviews examples/verify-schema-snapshot/reviews.json --db tmp/schema-example/evidence.sqlite --as-of "$AS_OF" --candidates-author example-self-review --reviews-author example-self-review --meta-repo "$PWD" --json > tmp/schema-example/prepared.json
SPEC_ID=$(node -p 'JSON.parse(require("fs").readFileSync("tmp/schema-example/prepared.json","utf8")).spec_id')
YGL_HOME="$PWD/tmp/schema-example/home" node dist/bundle/bin.cjs verify run "$SPEC_ID" --db tmp/schema-example/evidence.sqlite --provenance tmp/schema-example/producer.json --json > tmp/schema-example/run.json
ARCHIVE=$(node -p 'JSON.parse(require("fs").readFileSync("tmp/schema-example/run.json","utf8")).archive.path')
YGL_HOME="$PWD/tmp/schema-example/home" node dist/bundle/bin.cjs verify archive verify "$ARCHIVE" --json
```

Expected: ready prepare; report overall PASS; archive verification ok:true. Delete the amount column only in a separate negative **source fixture**, collect to a new output and run the same frozen spec: report overall FAIL, process rc0. The end-to-end regression tests both cases and verifies both archives.

## Evidence and limits

- `schema_tables` lists physical tables; `schema_columns` stores table/column names, declared type, nullability, default SQL text and primary-key order. Default SQL text is data, never executed.
- `collection_source` records source SHA-256, user_version and actual collection time. Source bytes are hashed before/after collection and must match.
- The CLI report’s data_source.sha256 identifies the **collected evidence DB**, not the original database. Its source hash is inside collection_source; retain the original source separately if later remeasurement is required.
- Collector stdout is a producer JSON accepted by --provenance; it names this script SHA/platform/runtime and an example role. It is self-reported, not authenticated identity or proof the collection was honest.
- Empty output tables remain a completed measurement; a missing matching row yields FAIL for this positive-count material, not false PASS.
- No live-source concurrency, arbitrary view/derived SQL, index collection, signed collector identity or automatic trust is added. Memory usage grows with source file size and metadata; this is a small offline example, not a streaming live collector.

## Regression

`node node_modules/vitest/vitest.mjs run packages/ops/tools/tests/schema-snapshot-recipe.spec.ts --maxWorkers=1` exercises source immutability, quoted table names, broken views, output refusal, non-standalone/corrupt input, prepare/run and positive/negative archive verification.
