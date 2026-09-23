# imgly-labs/.github

Shared GitHub configuration for the imgly-labs org.

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
```

Every directory with a `.imgly-labs.json` is deployed on push to `main`.
