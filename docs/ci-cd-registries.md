# Image registries in CI and CD

Since 2026-11-19 every release image exists in two registries, and CI/CD reads from the one that
has no pull limit.

| What | Where | Why |
| --- | --- | --- |
| Images the homelab and velora-node-2 **pull** | Docker Hub `<DOCKERHUB_USERNAME>/<service>:<sha>` (node-2: `<sha>-amd64`) | unchanged; the deploy controller and `infra/friend-mail-node/deploy.sh` still use it |
| Images the pipeline **reads** (re-tag source, build cache) | GHCR `ghcr.io/<owner>/<service>` (`:buildcache`, `:<sha>`, `:latest`) | Docker Hub's personal plan allows 200 pulls per 6 h; one release used 40-60 |
| Node base image of every build | `public.ecr.aws/docker/library/node:<tag>` through `ARG NODE_IMAGE_REGISTRY` in each Dockerfile | even resolving `docker.io/library/node` counts as a Docker Hub pull and failed whole releases with `429 Too Many Requests` |

How a release runs (`.github/workflows/cd.yml`):

1. `build-and-push-images` (homelab, arm64) and `build-and-push-node2-images` (node-2, amd64) log in to
   both registries with the job's `GITHUB_TOKEN` (`packages: write`) and the Docker Hub secrets.
2. A service nothing changed for is **re-tagged**: `imagetools create` reads `ghcr.io/<owner>/<service>:<previous sha>`
   and writes the new tags to GHCR and to Docker Hub. If the previous tag is not on GHCR the job builds instead.
3. A changed service is **built once** and pushed to both registries. The build cache is
   `ghcr.io/<owner>/<service>:buildcache` (arm64) and `:buildcache-amd64`.
4. Homelab CI (`.github/workflows/deploy.yml`) imports the same cache, logging in with the job token.
5. `promote-homelab` and `deploy-node2` are unchanged.

GHCR packages are created private on the first push and linked to the repository through the
`org.opencontainers.image.source` label, which is what lets the job token read and write them.
Nothing outside the pipeline needs them to be public. To let hosts pull from GHCR later, make each
package public in its settings (a one-way change) or use a token with `read:packages`.

If a release fails with `toomanyrequests` again, look at which registry the failing command names:
GHCR and ECR have no per-hour pull limit for these jobs, so it would be a Docker Hub pull
(a new `FROM docker.io/...`, or a service pulled by a script). `gh run rerun <run id> --failed` re-runs
only the failed jobs, using the workflow definition the run started with.
