import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { gitRepo, runStepAsync } from "./workflow.mjs";

const project = (id, extra = {}) => ({ id, slug: id, name: id, ...extra });

/** Fake pnpm, npm and corepack on PATH that record what ran where. */
function fakeTools() {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-tools-"));
  const log = path.join(dir, "log");
  writeFileSync(log, "");
  for (const tool of ["pnpm", "npm", "corepack"]) {
    const bin = path.join(dir, tool);
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "{\\"tool\\":\\"${tool}\\",\\"cwd\\":\\"$PWD\\",\\"args\\":\\"$*\\"}" >> ${JSON.stringify(log)}\n`);
    chmodSync(bin, 0o755);
  }
  return { dir, calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

async function build(r, dir, tools, env = {}) {
  return runStepAsync("Build", {
    cwd: path.join(r.dir, dir),
    env: { PATH: `${tools.dir}:${process.env.PATH}`, GITHUB_WORKSPACE: r.dir, ...env },
  });
}

describe("Build", () => {
  it("does nothing without a build command", async () => {
    const r = gitRepo({ "apps/a/.imgly-labs.json": project("aaaaaaaa"), "apps/a/package.json": "{}" });
    const tools = fakeTools();
    const res = await build(r, "apps/a", tools);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.deepEqual(tools.calls(), []);
  });

  it("installs with pnpm in the project when it has its own lockfile, then runs build there", async () => {
    const r = gitRepo({
      "apps/a/.imgly-labs.json": project("aaaaaaaa", { build: "echo built > out.txt" }),
      "apps/a/package.json": "{}",
      "apps/a/pnpm-lock.yaml": "",
    });
    const tools = fakeTools();
    const res = await build(r, "apps/a", tools);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.deepEqual(tools.calls(), [
      { tool: "corepack", cwd: path.join(r.dir, "apps/a"), args: "enable" },
      { tool: "pnpm", cwd: path.join(r.dir, "apps/a"), args: "install --frozen-lockfile" },
    ]);
    assert.ok(existsSync(path.join(r.dir, "apps/a/out.txt")));
  });

  it("installs at the workspace root for a monorepo package without its own lockfile", async () => {
    const r = gitRepo({
      "pnpm-lock.yaml": "",
      "pnpm-workspace.yaml": "packages: ['packages/*']",
      "package.json": "{}",
      "packages/demo/.imgly-labs.json": project("dddddddd", { build: "echo built > out.txt" }),
      "packages/demo/package.json": JSON.stringify({ dependencies: { sdk: "workspace:*" } }),
    });
    const tools = fakeTools();
    const res = await build(r, "packages/demo", tools);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.deepEqual(tools.calls(), [
      { tool: "corepack", cwd: r.dir, args: "enable" },
      { tool: "pnpm", cwd: r.dir, args: "install --frozen-lockfile" },
    ]);
    assert.ok(existsSync(path.join(r.dir, "packages/demo/out.txt")));
  });

  it("uses npm ci for a package-lock.json", async () => {
    const r = gitRepo({ "apps/a/.imgly-labs.json": project("aaaaaaaa", { build: "true" }), "apps/a/package.json": "{}", "apps/a/package-lock.json": "{}" });
    const tools = fakeTools();
    await build(r, "apps/a", tools);
    assert.deepEqual(tools.calls(), [{ tool: "npm", cwd: path.join(r.dir, "apps/a"), args: "ci" }]);
  });

  it("falls back to npm install in the project without any lockfile", async () => {
    const r = gitRepo({ "apps/a/.imgly-labs.json": project("aaaaaaaa", { build: "true" }), "apps/a/package.json": "{}" });
    const tools = fakeTools();
    await build(r, "apps/a", tools);
    assert.deepEqual(tools.calls(), [{ tool: "npm", cwd: path.join(r.dir, "apps/a"), args: "install" }]);
  });

  it("installs nothing when there is no package.json and no lockfile", async () => {
    const r = gitRepo({ "apps/a/.imgly-labs.json": project("aaaaaaaa", { build: "echo built > out.txt" }) });
    const tools = fakeTools();
    const res = await build(r, "apps/a", tools);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.deepEqual(tools.calls(), []);
    assert.ok(existsSync(path.join(r.dir, "apps/a/out.txt")));
  });

  it("fails when the build fails", async () => {
    const r = gitRepo({ "apps/a/.imgly-labs.json": project("aaaaaaaa", { build: "exit 3" }) });
    const res = await build(r, "apps/a", fakeTools());
    assert.notEqual(res.status, 0);
  });
});
