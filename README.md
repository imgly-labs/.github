# imgly-labs/.github

Shared GitHub configuration for the imgly-labs org. This repository is public so repositories in other allowed orgs (currently `imgly`) can use the deploy workflow; it contains no secrets.

## Labs deploy

Add `.github/workflows/labs.yml` to a repo:

```yaml
name: labs
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  labs:
    uses: imgly-labs/.github/.github/workflows/labs-deploy.yml@main
    permissions:
      contents: read
      id-token: write
    secrets: inherit
```

Every directory with a `.imgly-labs.json` is a project. A push deploys the projects that

- deploy from the pushed branch: `"branch"` in `.imgly-labs.json`, default `main` (add the branch to `on.push.branches`), and
- changed in that push: a file in the project's directory, or a file matching one of its `"watch"` paths.

`watch` lists paths from the repository root that the project's build depends on, for monorepos: `"watch": ["packages/codesign-sdk/**", "pnpm-lock.yaml"]`. `**` spans directories, `*` and `?` match within one; a path without wildcards matches itself and everything below it.

A manual run (`workflow_dispatch`) deploys every project of the branch it runs on. So does a push whose base is unknown (a new branch, a force push).

Project secrets: a repository or organization secret named `LABS_<ID>_<NAME>` (ID in upper case) is available to that project's Worker code as `env.<NAME>`. Nothing else is forwarded.

Repositories outside `imgly-labs` (allowed orgs: `imgly`) use the same workflow file. GitHub does not pass `secrets: inherit` across organizations, so they pass their secrets as one JSON value instead:

```yaml
jobs:
  labs:
    uses: imgly-labs/.github/.github/workflows/labs-deploy.yml@main
    permissions:
      contents: read
      id-token: write
    secrets:
      LABS_SECRETS: ${{ toJSON(secrets) }}
```

The workflow still forwards only `LABS_<ID>_*` keys, each to its own project; values stay masked in logs. If a name is both inherited and in `LABS_SECRETS`, `LABS_SECRETS` wins.

## Containers

A project with `"containers"` in `.imgly-labs.json` gets its images built and pushed by the workflow, after the project's build:

1. The workflow asks labs (`POST /deploy/registry`, with the job's OIDC token) for registry credentials. Labs checks the token, the branch and that this repo and path own the project id, and returns credentials for Cloudflare's registry that expire after 60 minutes. The repo holds no Cloudflare credentials.
2. Each image is built with `docker buildx build --platform linux/amd64 --push` from its `dockerfile` and `context` (default: the Dockerfile's directory). Both are relative to the project directory and may point anywhere inside the repository, e.g. a monorepo root.
3. The deploy sends the pushed digests; labs runs only those.

Git LFS files are fetched for the project directory only. A build context outside it that needs LFS files must fetch them in the project's `build`.
