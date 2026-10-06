import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gitRepo, runStep } from "./workflow.mjs";

const project = (id, extra = {}) => ({ id, slug: id, name: id, ...extra });
const ZERO = "0000000000000000000000000000000000000000";

function repo() {
  return gitRepo({
    "apps/a/.imgly-labs.json": project("aaaaaaaa"),
    "apps/a/index.html": "a",
    "apps/b/.imgly-labs.json": project("bbbbbbbb"),
    "apps/b/index.html": "b",
    "packages/demo/.imgly-labs.json": project("dddddddd", { branch: "develop", watch: ["packages/sdk/**", "pnpm-lock.yaml"] }),
    "packages/demo/index.html": "d",
    "packages/sdk/src/index.ts": "1",
    "pnpm-lock.yaml": "1",
    "node_modules/x/.imgly-labs.json": project("nnnnnnnn"),
    "README.md": "r",
  });
}

function discover(r, { event = "push", ref = "refs/heads/main", before, sha }) {
  const res = runStep("Find projects to deploy", {
    cwd: r.dir,
    env: { EVENT_NAME: event, REF: ref, BEFORE: before ?? "", SHA: sha ?? "" },
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  return JSON.parse(res.outputs.projects);
}

describe("Find projects to deploy", () => {
  it("on push, lists only projects of the pushed branch whose directory changed", () => {
    const r = repo();
    const sha = r.commit({ "apps/a/index.html": "a2", "packages/demo/index.html": "d2" });
    assert.deepEqual(discover(r, { before: r.first, sha }), ["apps/a"]);
    assert.deepEqual(discover(r, { ref: "refs/heads/develop", before: r.first, sha }), ["packages/demo"]);
  });

  it("lists nothing for a push that changes no project", () => {
    const r = repo();
    const sha = r.commit({ "README.md": "r2" });
    assert.deepEqual(discover(r, { before: r.first, sha }), []);
  });

  it("lists a project when one of its watched paths changed", () => {
    const r = repo();
    const sdk = r.commit({ "packages/sdk/src/index.ts": "2" });
    assert.deepEqual(discover(r, { ref: "refs/heads/develop", before: r.first, sha: sdk }), ["packages/demo"]);
    const lock = r.commit({ "pnpm-lock.yaml": "2" });
    assert.deepEqual(discover(r, { ref: "refs/heads/develop", before: sdk, sha: lock }), ["packages/demo"]);
  });

  it("lists every project of the branch on workflow_dispatch", () => {
    const r = repo();
    assert.deepEqual(discover(r, { event: "workflow_dispatch" }), ["apps/a", "apps/b"]);
    assert.deepEqual(discover(r, { event: "workflow_dispatch", ref: "refs/heads/develop" }), ["packages/demo"]);
  });

  it("lists every project of the branch when the push has no usable base (new branch, force push)", () => {
    const r = repo();
    assert.deepEqual(discover(r, { before: ZERO, sha: r.first }), ["apps/a", "apps/b"]);
    assert.deepEqual(discover(r, { before: "1234567890123456789012345678901234567890", sha: r.first }), ["apps/a", "apps/b"]);
  });

  it("treats a project at the repo root as changed by any change", () => {
    const r = gitRepo({ ".imgly-labs.json": project("rrrrrrrr"), "index.html": "1", "docs/x.md": "1" });
    const sha = r.commit({ "docs/x.md": "2" });
    assert.deepEqual(discover(r, { before: r.first, sha }), ["."]);
  });

  it("does not list projects on other events (pull requests deploy nothing yet)", () => {
    const r = repo();
    assert.deepEqual(discover(r, { event: "pull_request", ref: "refs/pull/1/merge" }), []);
  });

  it("fails on an unreadable config", () => {
    const r = gitRepo({ "apps/x/.imgly-labs.json": "{" });
    const res = runStep("Find projects to deploy", { cwd: r.dir, env: { EVENT_NAME: "workflow_dispatch", REF: "refs/heads/main" } });
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /::error::apps\/x\/.imgly-labs.json/);
  });
});
