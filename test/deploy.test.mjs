import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fakeLabs, gitRepo, runStepAsync } from "./workflow.mjs";

const project = (id, extra = {}) => ({ id, slug: id, name: id, ...extra });

describe("Deploy", () => {
  let labs;
  before(async () => {
    labs = await fakeLabs({
      "POST /deploy": () => Response.json({ url: "https://labs.example/p/x", projectUrl: "https://x.example/" }),
    });
  });
  after(() => labs.close());

  async function deploy(r, dir, env = {}) {
    labs.requests.length = 0;
    const res = await runStepAsync("Deploy", { cwd: r.dir, env: { ...labs.env, PROJECT_DIR: dir, ...env } });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const sent = labs.requests.find((q) => q.path === "/deploy");
    return { res, form: sent.body, auth: sent.auth };
  }

  const secretsOf = (form) => Object.fromEntries([...form.entries()].filter(([k]) => k.startsWith("secret:")).map(([k, v]) => [k.slice(7), v]));

  it("sends config, path and files with the OIDC token for the labs audience", async () => {
    const r = gitRepo({ "apps/a/.imgly-labs.json": project("aaaaaaaa"), "apps/a/index.html": "<h1>a</h1>" });
    const { form, auth } = await deploy(r, "apps/a");
    assert.equal(auth, `Bearer oidc-for-${labs.base}`);
    assert.equal(form.get("path"), "apps/a");
    assert.equal(JSON.parse(form.get("config")).id, "aaaaaaaa");
    assert.equal(await form.get("file:/index.html").text(), "<h1>a</h1>");
  });

  it("forwards only this project's LABS_<ID>_* secrets from inherited secrets", async () => {
    const r = gitRepo({ "apps/a/.imgly-labs.json": project("aaaaaaaa"), "apps/a/index.html": "a" });
    const ALL_SECRETS = JSON.stringify({ LABS_AAAAAAAA_KEY: "1", LABS_BBBBBBBB_KEY: "x", OTHER: "y", github_token: "t" });
    const { form } = await deploy(r, "apps/a", { ALL_SECRETS });
    assert.deepEqual(secretsOf(form), { KEY: "1" });
  });

  it("also reads the LABS_SECRETS JSON map that callers outside imgly-labs pass explicitly", async () => {
    const r = gitRepo({ "apps/a/.imgly-labs.json": project("aaaaaaaa"), "apps/a/index.html": "a" });
    const LABS_SECRETS = JSON.stringify({ LABS_AAAAAAAA_TOKEN: "2", LABS_AAAAAAAA_KEY: "explicit", LABS_BBBBBBBB_X: "3", OTHER: "z" });
    const ALL_SECRETS = JSON.stringify({ LABS_AAAAAAAA_KEY: "inherited", LABS_SECRETS, github_token: "t" });
    const { form } = await deploy(r, "apps/a", { ALL_SECRETS });
    assert.deepEqual(secretsOf(form), { KEY: "explicit", TOKEN: "2" });
  });

  it("fails clearly when LABS_SECRETS is not a JSON object", async () => {
    const r = gitRepo({ "apps/a/.imgly-labs.json": project("aaaaaaaa"), "apps/a/index.html": "a" });
    const res = await runStepAsync("Deploy", {
      cwd: r.dir,
      env: { ...labs.env, PROJECT_DIR: "apps/a", ALL_SECRETS: JSON.stringify({ LABS_SECRETS: "not json" }) },
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /::error::LABS_SECRETS must be a JSON object/);
    assert.doesNotMatch(res.stdout + res.stderr, /not json/);
  });
});

describe("Deploy with container images", () => {
  let labs;
  before(async () => {
    labs = await fakeLabs({ "POST /deploy": () => Response.json({ url: "u", projectUrl: "p" }) });
  });
  after(() => labs.close());

  it("sends each pushed image as a container:<class>:<image> part", async () => {
    const r = gitRepo({ "apps/a/.imgly-labs.json": project("aaaaaaaa"), "apps/a/index.html": "a" });
    const IMAGES = JSON.stringify({ "Engine:server": "registry.cloudflare.com/ns/labs-aaaaaaaa-server@sha256:" + "a".repeat(64) });
    const res = await runStepAsync("Deploy", { cwd: r.dir, env: { ...labs.env, PROJECT_DIR: "apps/a", IMAGES } });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const form = labs.requests.find((q) => q.path === "/deploy").body;
    assert.equal(form.get("container:Engine:server"), JSON.parse(IMAGES)["Engine:server"]);
  });
});
