// Runs the inline scripts of .github/workflows/labs-deploy.yml outside GitHub Actions.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const dir = mkdtempSync(path.join(tmpdir(), "labs-repo-"));
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
