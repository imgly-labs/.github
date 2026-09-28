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

Every directory with a `.imgly-labs.json` is deployed on push to `main`.

Project secrets: a repository or organization secret named `LABS_<ID>_<NAME>` (ID in upper case) is available to that project's Worker code as `env.<NAME>`. Nothing else is forwarded.

Repositories outside `imgly-labs` (allowed orgs: `imgly`) use the same workflow file. GitHub does not pass `secrets: inherit` across organizations, so their projects deploy without `LABS_<ID>_*` secrets.
