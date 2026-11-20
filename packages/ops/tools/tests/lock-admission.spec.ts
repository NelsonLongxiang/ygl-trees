import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DB, acquireLockAdmission } from "../../../core/database/src/db";

const repo = resolve(__dirname, "../../../.."), bin = join(repo, "dist/bundle/bin.cjs");
let home: string, file: string, gate: string, deadPid: string;
beforeEach(() => {
  mkdirSync(join(repo, "tmp"), { recursive: true });
  home = mkdtempSync(join(repo, "tmp/admission-recovery-"));
  file = join(home, "ygl-trees.db"); gate = file + ".ygllock.recovery";
  const db = new DB(file, { managed: true }); db.closeStrict();
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", timeout: 10000 });
  expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.status).toBe(0); deadPid = child.stdout;
});
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
function seed(pid?: string) {
  mkdirSync(gate); writeFileSync(join(gate, "owner"), "abandoned-token");
  writeFileSync(join(gate, "task"), "project sync test");
  if (pid !== undefined) writeFileSync(join(gate, "pid"), pid);
}
function cli(args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args, "--home", home, "--json"], {
    cwd: repo, encoding: "utf8", timeout: 20000,
    env: { ...process.env, YGL_TEST: "0", YGL_SERVE: "", YGL_LOCK_RETRY_MS: "0", YGL_HOME: home, YGL_DB_URL: "", YGL_PG_URL: "", YGL_NO_UPDATE_CHECK: "1", YGL_EVAL_OFFLINE: "1" },
  });
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
  return { rc: result.status, value: JSON.parse(result.stdout), text: result.stderr };
}
describe("admission gate crash recovery", () => {
  it("human doctor fix cannot delete a live application lock installed by an ordinary writer", async () => {
    const lock = file + ".ygllock";
    mkdirSync(lock); writeFileSync(join(lock, "owner"), "dead-lock"); writeFileSync(join(lock, "pid"), deadPid);
    const doctorFile = join(repo, "dist/packages/ops/tools/src/doctor.js");
    // Resolve the outer-holder callsite in the loaded implementation; earlier diagnostic reads are irrelevant.
    const script = [
      "const fs = require(\"node:fs\"), assert = require(\"node:assert/strict\");",
      "const [file, home, deadPid, doctorFile, coreFile] = process.argv.slice(1);",
      "const core = require(coreFile), doctor = require(doctorFile);",
      "const read = fs.readFileSync, normalize = value => String(value).split(String.fromCharCode(92)).join(\"/\");",
      "const lines = read(doctorFile, \"utf8\").split(/\\r?\\n/);",
      "const sites = lines.flatMap((line, index) => /^\\s*holder = fs\\.readFileSync\\(pidFile, \"utf8\"\\)\\.trim\\(\\);$/.test(line) ? [index] : []);",
      "assert.equal(sites.length, 1, \"outer holder read must be unique\");",
      "const site = sites[0], frame = normalize(doctorFile) + \":\" + (site + 1) + \":\";",
      "assert.match(lines.slice(site + 1, site + 8).join(\"\\n\"), /const admission = gate\\(dbPath, \"doctor --fix\"\\)/, \"outer holder read must precede admission\");",
      "const db = new core.DB(file, { lock: false, managed: true });",
      "let paused = false;",
      "const acquire = core.acquireLockAdmission;",
      "core.acquireLockAdmission = function(target, task) {",
      "  if (target === file && task === \"doctor --fix\") {",
      "    assert.equal(paused, true, \"admission reached without outer-holder barrier\");",
      "    fs.writeSync(1, \"admission-after-barrier\\n\");",
      "  }",
      "  return acquire.apply(this, arguments);",
      "};",
      "fs.readFileSync = function(name, ...args) {",
      "  const value = read.call(this, name, ...args);",
      "  if (!paused && normalize(name) === normalize(file) + \".ygllock/pid\" && String(value).trim() === deadPid && normalize(new Error().stack).includes(frame)) {",
      "    paused = true;",
      "    fs.writeSync(1, \"outer-holder:\" + JSON.stringify({ pid: String(value).trim(), line: site + 1 }) + \"\\n\");",
      "    const byte = Buffer.alloc(1);",
      "    assert.equal(fs.readSync(0, byte, 0, 1, null), 1, \"barrier closed\");",
      "  }",
      "  return value;",
      "};",
      "try {",
      "  const rc = doctor.run({ db, home, ctx: { json: false, color: false, quiet: false }, args: { flags: { fix: true }, _: [] }, store: {} }, \"\", [], { flags: { fix: true }, _: [] });",
      "  assert.equal(typeof rc, \"number\", \"unexpected async doctor\");",
      "} finally { db.closeStrict(); }",
    ].join("\n");
    const child = spawn(process.execPath, ["-e", script, file, home, deadPid, doctorFile, join(repo, "dist/packages/core/database/src/db.js")], {
      cwd: repo, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, YGL_LOCK_RETRY_MS: "0", YGL_NO_UPDATE_CHECK: "1" },
    });
    let stdout = "", stderr = "", timer: ReturnType<typeof setTimeout> | undefined, writer: DB | undefined;
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    child.stderr.on("data", data => { stderr += data; });
    const ready = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(Error("doctor barrier not reached " + stdout + stderr)), 15000);
      child.stdout.on("data", data => { stdout += data; if (/outer-holder:[^\n]+\n/.test(stdout)) { clearTimeout(timer); resolve(); } });
      child.once("error", reject); child.once("close", () => reject(Error("doctor exited before barrier " + stdout + stderr)));
    });
    try {
      await ready;
      const barrier = JSON.parse(stdout.match(/outer-holder:([^\n]+)\n/)![1]);
      expect(barrier.pid).toBe(deadPid); expect(barrier.line).toBeGreaterThan(0);
      writer = new DB(file, { lock: true, managed: true });
      const owner = readFileSync(join(lock, "owner"), "utf8");
      child.stdin.end("x"); const result = await closed;
      expect(result.signal, stderr).toBeNull(); expect(result.code, stdout + stderr).toBe(0);
      expect(stdout).toContain("admission-after-barrier\n");
      expect(readFileSync(join(lock, "owner"), "utf8")).toBe(owner);
      expect(readFileSync(join(lock, "pid"), "utf8")).toBe(String(process.pid));
    } finally {
      if (timer) clearTimeout(timer);
      child.stdin.end(); if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed; writer?.closeStrict();
    }
  });

  it("a late concurrent reclaimer cannot move a newer live gate", async () => {
    seed(deadPid);
    const script = [
      'const fs=require("node:fs"),{clearDeadAdmission}=require('+JSON.stringify(join(repo,"dist/packages/core/database/src/db.js"))+');',
      'const file=process.argv[1],gate=file+".ygllock.recovery",rename=fs.renameSync;',
      'fs.renameSync=function(from,to){if(from===gate){fs.writeSync(1,"paused\\n");const b=Buffer.alloc(1);if(fs.readSync(0,b,0,1,null)!==1)throw Error("barrier closed");}return rename.apply(this,arguments);};',
      'try{const cleared=clearDeadAdmission(file);process.stdout.write(JSON.stringify({cleared})+"\\n");}catch(error){process.stderr.write(String(error));process.exitCode=1;}',
    ].join("\n");
    const child = spawn(process.execPath, ["-e", script, file], { cwd: repo, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", timer: ReturnType<typeof setTimeout> | undefined;
    child.stderr.on("data", data => { stderr += data; });
    const closed = new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({code,signal}));
    });
    const ready = new Promise<void>((resolve,reject) => {
      timer=setTimeout(()=>reject(new Error("reclaimer did not reach barrier: "+stdout+stderr)),15000);
      child.stdout.on("data", data => { stdout+=data; if(stdout.includes("paused\n")){clearTimeout(timer);resolve();} });
      child.once("error", reject);child.once("close",()=>reject(new Error("reclaimer exited before barrier: "+stdout+stderr)));
    });
    let current: ReturnType<typeof acquireLockAdmission> | undefined;
    try {
      await ready; current=acquireLockAdmission(file);
      expect(readFileSync(join(gate,"owner"),"utf8")).toBe(current.token);
      child.stdin.end("x"); const result=await closed;
      expect(result.signal,stderr).toBeNull();expect(result.code,stderr).toBe(0);
      expect(JSON.parse(stdout.slice(stdout.indexOf("\n")+1).trim()).cleared).toBe(false);
      expect(readFileSync(join(gate,"owner"),"utf8")).toBe(current.token);
      expect(readFileSync(join(gate,"pid"),"utf8")).toBe(String(process.pid));
    } finally {
      if(timer)clearTimeout(timer);child.stdin.end();if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;current?.release();
    }
  });

  it("records pid and task so a crashed holder can be distinguished from an unknown one", () => {
    const lock = acquireLockAdmission(file);
    try { expect(readFileSync(join(gate, "pid"), "utf8")).toBe(String(process.pid)); expect(readFileSync(join(gate, "task"), "utf8")).not.toBe(""); }
    finally { lock.release(); }
  });
  it("recovers an admission gate left by a real process exit", () => {
    const script = 'const {acquireLockAdmission}=require('+JSON.stringify(join(repo,"dist/packages/core/database/src/db.js"))+');acquireLockAdmission(process.argv[1],"resume-exit-test");process.exit(37);';
    const child = spawnSync(process.execPath,["-e",script,file],{cwd:repo,encoding:"utf8",timeout:15000});
    expect(child.error).toBeUndefined();expect(child.signal).toBeNull();expect(child.status,child.stderr).toBe(37);
    expect(readFileSync(join(gate,"task"),"utf8")).toBe("resume-exit-test");
    expect(cli(["project","list"]).rc).toBe(0);expect(existsSync(gate)).toBe(false);
  });
  it("lets ordinary CLI open reclaim a gate whose holder has exited", () => {
    seed(deadPid); const result = cli(["project", "list"]);
    expect(result.rc, result.text).toBe(0); expect(Array.isArray(result.value)).toBe(true); expect(existsSync(gate)).toBe(false);
  });
  it.each(["live", "unknown"])("ordinary open refuses a %s gate without altering it", mode => {
    seed(mode === "live" ? String(process.pid) : undefined);
    const result = cli(["project", "list"]); expect(result.rc).toBe(1); expect(result.value.error).toMatch(/admission|recovery|locked/);
    expect(readFileSync(join(gate, "owner"), "utf8")).toBe("abandoned-token"); expect(existsSync(gate)).toBe(true);
  });
  it("db unlock names and clears the dead admission gate instead of reporting no lock", () => {
    seed(deadPid); const result = cli(["db", "unlock"]);
    expect(result.rc, result.text).toBe(0); expect(result.value.cleared).toBe(true); expect(result.value.lock).toBe(gate); expect(existsSync(gate)).toBe(false);
  });
  it.each(["live", "unknown"])("db unlock refuses a %s admission owner even with force", mode => {
    seed(mode === "live" ? String(process.pid) : undefined); const result = cli(["db", "unlock", "--force"]);
    expect(result.rc).toBe(1); expect(existsSync(gate)).toBe(true); expect(readFileSync(join(gate, "owner"), "utf8")).toBe("abandoned-token");
  });
  it("doctor reports a dead admission gate and doctor fix clears it", () => {
    seed(deadPid); const first = cli(["doctor"]);
    expect(first.rc, first.text).toBe(0); expect(first.value.find((row: any) => row.name === "admission_gate")).toMatchObject({ status: "warn" });
    expect(existsSync(gate)).toBe(true);
    const fixed = cli(["doctor", "--fix"]); expect(fixed.rc, fixed.text).toBe(0); expect(existsSync(gate)).toBe(false);
  });
  it.each(["live", "unknown"])("doctor fix cannot clear a %s gate", mode => {
    seed(mode === "live" ? String(process.pid) : undefined); const result = cli(["doctor", "--fix"]);
    expect(result.rc).toBe(1); expect(Array.isArray(result.value)).toBe(true); expect(result.value.find((row: any) => row.name === "admission_gate")).toMatchObject({ status: "fail" }); expect(existsSync(gate)).toBe(true);
  });
});
