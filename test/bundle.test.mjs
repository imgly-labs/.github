import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { gitRepo, runStepAsync } from "./workflow.mjs";

const project = (id, extra = {}) => ({ id, slug: id, name: id, ...extra });
// Bundling installs esbuild once per run into RUNNER_TEMP; share it across tests.
const RUNNER_TEMP = mkdtempSync(path.join(tmpdir(), "labs-runner-"));

async function bundle(r, dir) {
  const res = await runStepAsync("Bundle worker code", { cwd: path.join(r.dir, dir), env: { RUNNER_TEMP, JOB_INDEX: "0" } });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const app = res.output.match(/^app=(.*)$/m)?.[1];
  return { res, app, code: app ? readFileSync(app, "utf8") : null };
}

describe("Bundle worker code", () => {
  it("skips projects without main", async () => {
    const r = gitRepo({ "apps/a/.imgly-labs.json": project("aaaaaaaa"), "apps/a/index.html": "a" });
    const { app } = await bundle(r, "apps/a");
    assert.equal(app, undefined);
  });

  it("bundles main as one ES module, keeping cloudflare: and node: imports external", async () => {
    const r = gitRepo({
      "apps/w/.imgly-labs.json": project("wwwwwwww", { main: "worker.ts" }),
      "apps/w/worker.ts": `import { DurableObject } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { EventEmitter } from "events";
import { helper } from "./helper.ts";
export class Room extends DurableObject {}
export default { fetch: () => new Response(helper(Buffer.from("x").length, typeof EventEmitter)) };`,
      "apps/w/helper.ts": "export const helper = (n: number, t: string): string => `${n} ${t}`;",
    });
    const { code } = await bundle(r, "apps/w");
    assert.match(code, /from "cloudflare:workers"/);
    assert.match(code, /from "node:buffer"/);
    assert.match(code, /from "node:events"/);
    assert.match(code, /export \{[^}]*Room[^}]*\}/);
    assert.doesNotMatch(code, /from "\.\/helper/);
  });

  it("turns require() of Node built-ins in CommonJS dependencies into node: imports", async () => {
    const r = gitRepo({
      "apps/w/.imgly-labs.json": project("wwwwwwww", { main: "worker.js" }),
      "apps/w/worker.js": `import legacy from "legacy";\nexport default { fetch: () => new Response(String(legacy.ok)) };`,
      "apps/w/node_modules/legacy/package.json": JSON.stringify({ name: "legacy", main: "index.js" }),
      "apps/w/node_modules/legacy/index.js": `var EE = require('events').EventEmitter;
var util = require('util');
var Stream = require('node:stream');
module.exports = { ok: typeof EE === 'function' && typeof util.inherits === 'function' && typeof Stream === 'function' };`,
    });
    const { code } = await bundle(r, "apps/w");
    for (const m of ["events", "util", "stream"]) assert.match(code, new RegExp(`from "node:${m}"`));
    assert.doesNotMatch(code, /require\(["'](node:)?(events|util|stream)["']\)/);
  });

  it("fails on code that does not build", async () => {
    const r = gitRepo({ "apps/w/.imgly-labs.json": project("wwwwwwww", { main: "worker.ts" }), "apps/w/worker.ts": `import "./missing.ts";` });
    const res = await runStepAsync("Bundle worker code", { cwd: path.join(r.dir, "apps/w"), env: { RUNNER_TEMP, JOB_INDEX: "0" } });
    assert.notEqual(res.status, 0);
  });
});
