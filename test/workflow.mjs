// Runs the inline scripts of .github/workflows/labs-deploy.yml outside GitHub Actions.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const WORKFLOW = new URL("../.github/workflows/labs-deploy.yml", import.meta.url);

/** The heredoc (`node --input-type=module <<'JS'`) of the step with this name. */
export function scriptOf(stepName) {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
  const step = lines.findIndex((l) => l.trim() === `- name: ${stepName}` || l.trim() === `name: ${stepName}`);
  if (step < 0) throw new Error(`no step ${stepName}`);
  const start = lines.findIndex((l, i) => i > step && l.includes("<<'JS'"));
  const end = lines.findIndex((l, i) => i > start && l.trim() === "JS");
  const body = lines.slice(start + 1, end);
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return body.map((l) => l.slice(indent)).join("\n");
}

/** Runs a step's script in `cwd` with `env`; returns status, stdout and the GITHUB_OUTPUT values. */
export function runStep(stepName, { cwd, env = {} }) {
  const dir = mkdtempSync(path.join(tmpdir(), "labs-step-"));
  const output = path.join(dir, "output");
  const summary = path.join(dir, "summary");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const res = spawnSync("node", ["--input-type=module"], {
    cwd,
    input: scriptOf(stepName),
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...env },
  });
  const outputs = Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
  );
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, outputs };
}

/** A git repo with `files` committed; returns its path and a commit() that adds more. */
export function gitRepo(files) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "labs-repo-")));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  const commit = (more) => {
    for (const [p, content] of Object.entries(more)) {
      mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      writeFileSync(path.join(dir, p), typeof content === "string" ? content : JSON.stringify(content));
    }
    git("add", "-A");
    git("commit", "-q", "-m", "c");
    return git("rev-parse", "HEAD");
  };
  return { dir, first: commit(files), commit };
}

/** Like runStep, but async so an in-process fake server can answer the script. */
export function runStepAsync(stepName, { cwd, env = {} }) {
  const script = scriptOf(stepName);
  const dir = mkdtempSync(path.join(tmpdir(), "labs-step-"));
  const output = path.join(dir, "output");
  const summary = path.join(dir, "summary");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  return new Promise((resolve) => {
    const child = spawn("node", ["--input-type=module"], {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr, output: readFileSync(output, "utf8") }));
    child.stdin.end(script);
  });
}

/**
 * A fake labs Worker plus GitHub's OIDC token endpoint on one local port.
 * `routes` maps "METHOD /path" to (request) => Response; every request is recorded with its parsed body.
 */
export async function fakeLabs(routes) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers: req.headers,
      ...(chunks.length ? { body: Buffer.concat(chunks), duplex: "half" } : {}),
    });
    const url = new URL(request.url);
    let response;
    if (url.pathname === "/oidc") {
      response = Response.json({ value: `oidc-for-${url.searchParams.get("audience")}` });
    } else {
      const route = routes[`${req.method} ${url.pathname}`];
      const type = request.headers.get("content-type") ?? "";
      const body = type.includes("multipart/form-data") ? await request.clone().formData() : type.includes("json") ? await request.clone().json() : null;
      requests.push({ method: req.method, path: url.pathname, auth: request.headers.get("authorization"), body });
      response = route ? await route(request) : new Response("not found", { status: 404 });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    requests,
    env: { LABS_URL: base, ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/oidc?x=1`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req-token" },
    close: () => new Promise((r) => server.close(r)),
  };
}
