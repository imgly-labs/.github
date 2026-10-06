import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fakeLabs, gitRepo, runStepAsync } from "./workflow.mjs";

const project = (id, extra = {}) => ({ id, slug: id, name: id, ...extra });
const withContainers = (id) =>
  project(id, {
    main: "worker.ts",
    bindings: { durable_objects: [{ name: "ENGINE", class: "EngineServerContainer" }] },
    containers: [
      {
        class: "EngineServerContainer",
        images: { engineServer: { dockerfile: "../engine/Dockerfile", context: "../.." }, sidecar: { dockerfile: "sidecar/Dockerfile" } },
      },
    ],
  });

/** A `docker` that records each call and answers buildx with a digest derived from the tag. */
function fakeDocker() {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-docker-"));
  const log = path.join(dir, "log");
  const bin = path.join(dir, "docker");
  writeFileSync(log, "");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const args = process.argv.slice(2);
let stdin = "";
try { if (args[0] === "login") stdin = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdin }) + "\\n");
if (process.env.FAKE_DOCKER_FAIL && args[0] === "buildx") process.exit(1);
const meta = args.indexOf("--metadata-file");
if (meta >= 0) {
  const tag = args[args.indexOf("-t") + 1];
  fs.writeFileSync(args[meta + 1], JSON.stringify({ "containerimage.digest": "sha256:" + crypto.createHash("sha256").update(tag).digest("hex") }));
}
`
  );
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

const digestOf = async (tag) => {
  const { createHash } = await import("node:crypto");
  return "sha256:" + createHash("sha256").update(tag).digest("hex");
};

describe("Build container images", () => {
  let labs;
  let registryStatus = 200;
  before(async () => {
    labs = await fakeLabs({
      "POST /deploy/registry": async (req) => {
        if (registryStatus !== 200) return Response.json({ error: "id belongs to someone else" }, { status: registryStatus });
        const { config } = await req.json();
        const id = JSON.parse(config).id;
        return Response.json({
          registry: "registry.cloudflare.com",
          username: "v1",
          password: "s3cret-push",
          repositories: {
            engineServer: `registry.cloudflare.com/ns/labs-${id}-engine-server`,
            sidecar: `registry.cloudflare.com/ns/labs-${id}-sidecar`,
          },
        });
      },
    });
  });
  after(() => labs.close());
  beforeEach(() => {
    labs.requests.length = 0;
    registryStatus = 200;
  });

  const repo = (config) =>
    gitRepo({
      "packages/demo/.imgly-labs.json": config,
      "packages/demo/sidecar/Dockerfile": "FROM scratch",
      "packages/engine/Dockerfile": "FROM scratch",
    });

  const run = (r, docker, env = {}) =>
    runStepAsync("Build container images", {
      cwd: r.dir,
      env: { ...labs.env, PROJECT_DIR: "packages/demo", DOCKER: docker.bin, GITHUB_SHA: "abc123", GITHUB_WORKSPACE: r.dir, ...env },
    });

  it("does nothing for a project without containers", async () => {
    const docker = fakeDocker();
    const res = await run(repo(project("aaaaaaaa")), docker);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(labs.requests.length, 0);
    assert.deepEqual(docker.calls(), []);
  });

  it("gets credentials from labs, builds and pushes each image for linux/amd64, and outputs digest-pinned refs", async () => {
    const r = repo(withContainers("ctctctct"));
    const docker = fakeDocker();
    const res = await run(r, docker);
    assert.equal(res.status, 0, res.stdout + res.stderr);

    const reg = labs.requests.find((q) => q.path === "/deploy/registry");
    assert.equal(reg.auth, `Bearer oidc-for-${labs.base}`);
    assert.equal(reg.body.path, "packages/demo");
    assert.equal(JSON.parse(reg.body.config).id, "ctctctct");
    assert.match(res.stdout, /::add-mask::s3cret-push/);

    const calls = docker.calls();
    assert.deepEqual(calls[0], { args: ["login", "--username", "v1", "--password-stdin", "registry.cloudflare.com"], stdin: "s3cret-push" });
    const builds = calls.filter((c) => c.args[0] === "buildx");
    assert.equal(builds.length, 2);
    const engine = builds[0].args;
    const at = (args, flag) => args[args.indexOf(flag) + 1];
    assert.equal(at(engine, "-f"), path.join(r.dir, "packages/engine/Dockerfile"));
    assert.equal(at(engine, "-t"), "registry.cloudflare.com/ns/labs-ctctctct-engine-server:abc123");
    assert.equal(at(engine, "--platform"), "linux/amd64");
    assert.ok(engine.includes("--push") && engine.includes("--provenance=false"));
    assert.equal(engine.at(-1), r.dir);
    // Without a context, the Dockerfile's directory is the context.
    assert.equal(builds[1].args.at(-1), path.join(r.dir, "packages/demo/sidecar"));
    assert.deepEqual(calls.at(-1).args, ["logout", "registry.cloudflare.com"]);

    const out = JSON.parse(res.output.match(/^images=(.*)$/m)[1]);
    assert.deepEqual(out, {
      "EngineServerContainer:engineServer": `registry.cloudflare.com/ns/labs-ctctctct-engine-server@${await digestOf("registry.cloudflare.com/ns/labs-ctctctct-engine-server:abc123")}`,
      "EngineServerContainer:sidecar": `registry.cloudflare.com/ns/labs-ctctctct-sidecar@${await digestOf("registry.cloudflare.com/ns/labs-ctctctct-sidecar:abc123")}`,
    });
  });

  it("refuses a Dockerfile or context outside the repository before asking for credentials", async () => {
    for (const image of [{ dockerfile: "../../../Dockerfile" }, { dockerfile: "sidecar/Dockerfile", context: "../../.." }]) {
      const config = withContainers("ctctctct");
      config.containers[0].images = { sidecar: image };
      const docker = fakeDocker();
      const res = await run(repo(config), docker);
      assert.notEqual(res.status, 0);
      assert.match(res.stdout, /::error::.*inside the repository/);
      assert.equal(labs.requests.length, 0);
      assert.deepEqual(docker.calls(), []);
    }
  });

  it("fails with labs' reason when credentials are refused", async () => {
    registryStatus = 409;
    const docker = fakeDocker();
    const res = await run(repo(withContainers("ctctctct")), docker);
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /::error::.*409.*id belongs to someone else/);
    assert.deepEqual(docker.calls(), []);
  });

  it("fails when a build fails, and still logs out", async () => {
    const docker = fakeDocker();
    const res = await run(repo(withContainers("ctctctct")), docker, { FAKE_DOCKER_FAIL: "1" });
    assert.notEqual(res.status, 0);
    assert.deepEqual(docker.calls().at(-1).args, ["logout", "registry.cloudflare.com"]);
  });
});
