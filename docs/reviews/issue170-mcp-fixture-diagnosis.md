# #170 Windows MCP fixture diagnosis

## Observed failure

Candidate 10b68dc56e0ebae3f618884e3c1dfad0a9f98b4f failed the second official Windows G1 run: the published-bundle request hit its 15000ms socket inactivity timeout, then afterAll reported EPERM removing its workspace. G1 exits were 0/1/0; G7 and pack:check later passed. Those later passes do not satisfy three consecutive G1 passes.

The original failing invocation had no per-request timestamps. Its exact stalled stage is unknown. The working classification is an unreproduced host/test stall, not a demonstrated product isolation bug.

## Original-code investigation

All runs used independent full clone D:/workspace/ygl-mcp170-full, Node v24.12.0, pnpm 9.15.9, source 10b68dc, and the original published bundle (SHA256 e28e912cd79f4254acc78b8a9dba9a6f93fc1f16a01d259c748e1ebd0d5c1ae0). No request deadline or production source was changed.

- Thirty focused repetitions under a concurrently running complete default Vitest suite passed 30/30. Ninety interleavings recorded B's response finishing before A's body ended. A second clean-environment batch also passed 30/30 and its background complete suite passed: 1323 passed / 109 skipped = 1432.
- The first batch's background suite had one update-check failure caused by the diagnostic runner setting YGL_NO_UPDATE_CHECK. That result is not a product defect or a full-suite pass. The override was removed before the clean batch and ten-suite series.
- Ten additional **complete** default Vitest runs, each maxWorkers=2, passed 10/10, including the MCP case in every run. Each run registered 1432 tests (1323 passed / 109 environment-skipped).
- Async diagnostic tracing recorded HTTP accept, body end, dispatch spawn/close, response finish, request-handler durations, synchronous fs/child_process calls in request context, and server heartbeat.
- Across the ten complete suites: no synchronous fs/spawnSync/execSync/execFileSync call in request context; maximum synchronous spawn return 12.534ms, maximum request handler 12.745ms, maximum heartbeat interval 1016.598ms (16.598ms beyond its 1000ms period). No request was observed blocked behind another unfinished body.

| Complete suite | MCP duration ms | Max heartbeat extra lag ms | Max request handler ms | Sync fs/spawnSync calls |
|---:|---:|---:|---:|---:|
| 1 | 8365.992 | 16.064 | 8.912 | 0 |
| 2 | 8718.766 | 14.328 | 9.611 | 0 |
| 3 | 8826.845 | 11.580 | 9.688 | 0 |
| 4 | 8691.500 | 15.105 | 7.403 | 0 |
| 5 | 9582.118 | 15.629 | 11.073 | 0 |
| 6 | 7674.923 | 12.713 | 10.760 | 0 |
| 7 | 7800.062 | 13.887 | 10.125 | 0 |
| 8 | 7967.084 | 16.598 | 7.799 | 0 |
| 9 | 8425.545 | 15.510 | 6.900 | 0 |
| 10 | 8264.947 | 9.103 | 12.745 | 0 |

The earlier observer wrote each event with appendFileSync. Its 1845.58ms heartbeat **interval** was 845.58ms beyond the one-second period, not proof of 1845ms product event-loop blocking. Dispatch-to-response duration includes asynchronous child CLI work and is not a synchronous-blocking measurement.

Evidence on the Windows release box:

- Original clean stress: D:/workspace/ygl-mcp170-full/tmp/issue170-stress-q5jkCl/{rounds.json,summary.json,trace-*}
- Ten complete suites: D:/workspace/ygl-mcp170-full/tmp/issue170-full10-DOhdzZ/{full-*.json,full-*.log,trace-*}
- Final analysis: D:/workspace/ygl-trees/tmp/issue170-full10-analysis-final.json
- Official failure: D:/workspace/ygl-trees/tmp/release-10b68dc-verification/g1-2.log:2585–2597

These are local evidence locations, not portable links or proof that the original host stall cannot recur.

## Test-only repair

The request fixture waits for the actual server-accepted IPC signal before completing B while A's body remains open. The published server code is unchanged; a test-only preload observes HTTP events and the server's own CLI subprocess handles.

Cleanup destroys outstanding test requests, stops accepting new server requests, terminates only CLI subprocesses acquired by that server, waits for all their close events, and then waits for the parent server close before removing scratch. The parent's exitCode or exit event alone is not sufficient: stdio and child handles may not yet be closed.

The HTTP request timeout remains 15000ms. No retry-to-green, sleep-based teardown, baseline write, product async refactor, or release/version change is part of this repair.

A deterministic negative control using the old kill-parent-first teardown failed with parent.kill/remove before cli.close. The repaired control and an actual subprocess holding a workspace file passed. A separate regression checks exit-before-stdio-close ordering.

## Remaining release boundary

The original timeout was not reproduced; this repair improves test synchronization and failure cleanup without claiming to fix a proven product timeout. Windows post-fix load repetitions passed 30/30; the concurrent complete default suite passed 1326 tests with 109 environment skips (1435 total). Focused cleanup and bundle regressions passed 4/4. The final Windows pnpm test returned rc0: 1435 main tests (1326 passed / 109 environment skips), 10 serial perf tests, demo128, contract152/152, README60/60 including serial count1435, skills289/0 rejected; ratchet entry938774B and Web1401456B held, cold397ms tightened without writing the baseline. Metadata check45 entries/0drift and against-git audit passed. The macOS full chain remains pending independent review, not implied by Windows results. After review/merge, a fresh candidate still requires three consecutive official G1 runs on an idle Windows release box plus G7 and pack:check. Issue #170 remains open until its published-tag close condition is met.
