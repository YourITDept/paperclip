# Building Paperclip — the container toolchain

**Status:** Current as of `W4-20260828a` (2026-08-28).
**Owner:** cwa@youritdept.com
**Companion to:** [`ReverseProxyCustomChanges.md`](CustomCodeDoc/ReverseProxyCustomChanges.md) —
that file records *what the fork carries*; this one records *what builds and
tests it*, and where those commands are meant to run.

> **The rule this document defines: the container is the build and test
> environment.** Every version below is supplied by the image. Nothing in the
> toolchain is taken from a developer's host, and nothing needs to be installed
> on one to produce a correct build.

---

## 1. Why the container is the boundary

The repo pins its toolchain in thirteen source fragments and enforces the pin in CI
([`scripts/check-node-version-policy.mjs`](scripts/check-node-version-policy.mjs),
run from [`pr.yml:53`](.github/workflows/pr.yml#L53)). A host that drifts from
those pins still *runs* — the version guards are floors, not ceilings — so
drift does not announce itself. It shows up later as a result that cannot be
reproduced.

The container removes the question. [`Dockerfile:2`](Dockerfile#L2) is
`FROM node:24-trixie-slim`, every build stage descends from it, and
[`.dockerignore`](.dockerignore) excludes `node_modules` and `**/node_modules`,
so nothing from a host tree can enter the image. `pnpm install` and every
`pnpm build` run **inside** that container ([`Dockerfile:51`](Dockerfile#L51),
[`:59-70`](Dockerfile#L59-L70)).

**The practical consequence: the host's Node version does not affect
`docker build` at all.** It only matters when running repo commands directly on
the host, which is the case §7 is about.

---

## 2. The canonical toolchain

| Tool | Version | Where it is pinned |
| --- | --- | --- |
| **Node.js** | **24** (minimum `24.11.0`) | [`.nvmrc`](.nvmrc), `engines.node` on all 35 workspace packages, `FROM node:24-trixie-slim`, CI `node-version: 24` |
| **pnpm** | **9.15.4** | `packageManager` in [`package.json:82`](package.json#L82); CI `pnpm/action-setup` |
| **corepack** | bundled with Node 24 | `corepack enable`, [`Dockerfile:8`](Dockerfile#L8) — reads `packageManager` and provisions pnpm itself |
| **lockfile format** | `lockfileVersion: '9.0'` | [`pnpm-lock.yaml`](pnpm-lock.yaml) |
| **`@types/node`** | `^24.0.0` | enforced by the policy script |

**npm is not part of the build.** It appears once, in the production stage, to
install the agent CLIs globally ([`Dockerfile:96`](Dockerfile#L96)). No workspace
dependency is ever installed with it.

Corepack is what makes this self-correcting: it reads `packageManager` from the
repo and fetches exactly `pnpm@9.15.4`. When upstream bumps the pin, the image
follows with no Dockerfile edit.

---

## 3. Tools present in each image stage

### 3.1 `base` — every stage descends from this

`FROM node:24-trixie-slim`, plus ([`Dockerfile:5-8`](Dockerfile#L5-L8)):

| Package | Why it is there |
| --- | --- |
| `ca-certificates` | TLS trust for every outbound fetch |
| `gosu` | entrypoint drops from root to the `node` user |
| `curl`, `wget` | runtime fetches; installers |
| `gh` | GitHub CLI — agents use it for PR and issue work |
| `git` | workspace clones, worktrees, `git describe` |
| `ripgrep` (`rg`) | required **on PATH**: OpenCode's skill tooling otherwise tries to download a pinned build at run time, which hangs ~127s and fails under locked-down egress |
| `python3` | native module builds and assorted tooling |
| `tini` | PID 1 — see §6 |
| `corepack enable` | provisions pnpm 9.15.4 from the pin |

The image also remaps the stock `node` user to `USER_UID`/`USER_GID` (default
1000) so bind-mounted files match host ownership.

### 3.2 `deps` — dependency resolution

Copies only manifests, then `pnpm install --frozen-lockfile`. Manifests first,
sources later, so a source-only commit reuses the dependency layer.

### 3.3 `build` — compilation

Adds `cargo` and `rustc` ([`Dockerfile:55-57`](Dockerfile#L55-L57)) for the
Rust-based `paperclip-runner`, then:

```
pnpm --filter @paperclipai/ui build          # Vite
pnpm --filter @paperclipai/plugin-sdk build
pnpm --filter @paperclipai/server build      # tsc + write-build-stamp
```

`NODE_OPTIONS=--max-old-space-size=4096` is set before the server build. The
Rust target directory is deleted afterwards. The build asserts
`server/dist/index.js` exists rather than trusting the exit code.

### 3.4 `production` — the shipped image

Adds `openssh-client` and `jq`, and installs the agent CLIs globally with npm:

```
@anthropic-ai/claude-code@latest   @openai/codex@latest   opencode-ai
@google/gemini-cli@latest          @moonshot-ai/kimi-code@latest
```

These are `@latest`, so `CLI_TOOLS_CACHE_EPOCH` (an ISO week stamped by CI)
exists purely to bust that layer weekly. The layer sits **before** the app copy
on purpose: it is the most expensive layer in the build and references nothing
from `/app`, so ordering it after the app copy would rebuild it on every commit.

Runtime entry:

```
ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
```

### 3.5 Variant stages

| Target | Adds |
| --- | --- |
| `cloud-plugins` | builds sandbox-provider plugins named by `CLOUD_BUNDLED_PLUGINS` (default `daytona`), each installed standalone with `--ignore-workspace --no-lockfile` |
| `cloud-server-deps` | installs optional peer packages named by `CLOUD_BUNDLED_SERVER_DEPS` (default `@sentry/node`), versions read from `server/package.json` `peerDependencies` |
| `cloud` | `production` + both of the above |

Self-hosted builds pin `--target production` and never run these.

### 3.6 `docker/agent-runtime/Dockerfile.base` — the agent sandbox image

Different base, same Node major:

- `golang:1.25-bookworm` builds the Go `paperclip-agent-shim`
- `ubuntu:22.04` runtime, Node installed from NodeSource `setup_24.x` via `ARG NODE_VERSION=24`
- `ca-certificates curl git tini gnupg ripgrep`, non-root `paperclip` user (1000:1000)

---

## 4. Test and build libraries

Versions are what the lockfile currently resolves.

| Library | Version | Role |
| --- | --- | --- |
| `vitest` | 4.1.10 | the entire test suite, every package |
| `typescript` | 7.0.2 | `tsc -b` typecheck and the server build |
| `tsx` | 4.23.12 | TypeScript loader — also the runtime loader in `CMD` |
| `esbuild` | 0.28.2 | CLI bundling, `target: "node24"` |
| `vite` | 8.2.2 | UI build and dev server |
| `@playwright/test` | ^1.62.1 | end-to-end |
| `supertest` | 7.2.2 | HTTP-level server tests |
| `embedded-postgres` | 18.1.0-beta.16 | **patched** — real Postgres for database-backed suites |
| `storybook` | — | UI component workshop, visual CI |

### 4.1 Patched dependencies — read before bumping pnpm

Declared under the `pnpm` key in [`package.json`](package.json):

| Package | Patch |
| --- | --- |
| `embedded-postgres@18.1.0-beta.16` | forces `LC_MESSAGES=C` and passes through `process.env` at `initdb`, so log scraping is locale-independent |
| `acpx@0.12.0` | — |

Overrides in the same block: `rollup >=4.59.0`, `react ^19.2.8`,
`react-dom ^19.2.8`.

> **Trap.** pnpm 10 moved `overrides` and `patchedDependencies` out of
> `package.json` into `pnpm-workspace.yaml`. A pnpm bump past 9 that does not
> move these two blocks makes both patches and all three overrides **silently
> stop applying** — the install still succeeds. The `embedded-postgres` patch is
> what the database-backed test suites depend on. Verify after any pnpm bump
> that `node_modules/.pnpm/` still contains an `embedded-postgres@…_patch_hash=…`
> directory.

### 4.2 Server runtime libraries

`express@5`, `drizzle-orm@0.45.2` (Postgres), `better-auth@1.7.0`,
`embedded-postgres`, `pino` + `pino-http` + `pino-pretty`, `zod@4`,
`ajv` + `ajv-formats`, `ws@8`, `ssh2`, `sharp`, `multer`, `chokidar`,
`dompurify`, `jsdom`, `dotenv`, `open`, `detect-port`,
`@aws-sdk/client-s3`, `@opentelemetry/api`. Optional peer: `@sentry/node`.

### 4.3 UI libraries

`react@19.2.8` + `react-dom`, `react-router-dom`, `@tanstack/react-query`,
`tailwindcss` (+ `@tailwindcss/vite`, `@tailwindcss/typography`),
`radix-ui` / `@radix-ui/react-slot`, `@base-ui/react`, `@assistant-ui/react`,
`lexical` + `@lexical/link` + `@mdxeditor/editor`, `@dnd-kit/*`, `@xterm/xterm`,
`mermaid`, `motion`, `cmdk`, `lucide-react`, `react-markdown` + `remark-gfm`,
`i18next` + `react-i18next`, `yjs`, `react-resizable-panels`,
`class-variance-authority`, `clsx`, `tailwind-merge`.

### 4.4 CLI libraries

`commander`, `@clack/prompts`, `picocolors`, `dotenv`, `drizzle-orm`,
`embedded-postgres`.

### 4.5 Workspace shape

35 workspace packages (`importers` in the lockfile): `server`, `ui`, `cli`,
`packages/*`, `packages/adapters/*`, `packages/plugins/*`,
`packages/plugins/examples/*`. Sandbox providers under
`packages/plugins/sandbox-providers/**` are deliberately **excluded** from the
workspace so each installs standalone.

---

## 5. Running the toolchain in the container

Build the image (nothing required on the host but Docker):

```bash
docker build --target production -t paperclip:local .
```

Run any repo command inside the toolchain:

```bash
docker run --rm -v "$PWD":/app -w /app node:24-trixie-slim \
  bash -lc 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @paperclipai/server typecheck'
```

Same shape for tests:

```bash
docker run --rm -v "$PWD":/app -w /app node:24-trixie-slim \
  bash -lc 'corepack enable && pnpm install --frozen-lockfile && \
    pnpm --filter @paperclipai/server exec vitest run src/auth/proxy-header-auth.test.ts'
```

Bind-mounting the source is fine; bind-mounting a host `node_modules` is not —
native modules built against a different Node ABI will fail at require time.
Let the container install its own.

---

## 6. Two runtime facts worth keeping

**tini is PID 1, not node.** Agent runs spawn `git` / `claude` / `esbuild` / `sh`
descendants that outlive their leader. Without an init, node inherits PID 1 and
never `wait()`s the orphans the kernel re-parents onto it — measured at ~79
zombies/hour until the cgroup pid limit is exhausted and every `fork()` in the
container fails. Both the main and agent-runtime images use tini.

**The image carries no `.git`.** Version and commit reach the server through the
`PAPERCLIP_BUILD_VERSION` / `PAPERCLIP_BUILD_COMMIT` build args, computed by
`git describe` on the CI runner. A local `docker build` leaves them empty, and
the server falls back accordingly — so `/api/health`'s `commit` field is blank
on a locally built image. That is expected, not a defect.

---

## 7. Where work has actually been run — the honest record

**This section exists so results are never attributed to the wrong runtime.**

The toolchain above is the standard. It is not what the assistant sessions
recorded in `ReverseProxyCustomChanges.md` have been executing on. Those ran on
the **host**, not in the container:

| | Session environment (2026-08-28) | Canonical |
| --- | --- | --- |
| Node | **v26.7.0** | 24 (≥ 24.11.0) |
| npm | 11.19.0 | not used by the build |
| pnpm launcher | 11.24.0 (Homebrew) | — |
| pnpm effective | **9.15.4** | 9.15.4 ✓ |
| OS | Ubuntu 24.04.4 LTS, x86_64 | Debian trixie (container) |

The pnpm half matches exactly: the Homebrew pnpm 11 reads `packageManager` and
delegates to 9.15.4, which is what actually runs (`pnpm -v` prints `9.15.4`
inside the repo and `11.24.0` outside it; the delegated copy is cached under
`/Projects/.pnpm-store/v11/links/@/pnpm/9.15.4`). Patches were confirmed applied.

**The Node half does not match — it is one major ahead.** The version guards are
floors, so everything ran and passed, but a Node-24-only failure could not have
surfaced. The Session 10 validation results should be read with that caveat.
There is no Node 24 and no version manager on that host, so it could not be
re-run there.

**To settle it, run the same commands through §5 or let CI do it** — CI is
pinned at `node-version: 24` and is the authoritative environment.

---

## 8. Traps

1. **Never bind-mount a host `node_modules` into the container.** Native addons
   compiled against another Node ABI fail at require time, which reads as a
   corrupt image rather than a version mismatch. `.dockerignore` already prevents
   this for `docker build`; it is `docker run -v` that can reintroduce it.
2. **Do not add a second Node or a `RUN npm i -g pnpm@…` to the Dockerfile.**
   The base image supplies Node 24 and corepack supplies pnpm 9.15.4 from the
   pin. Either addition shadows a correct version with an unmanaged one.
3. **Do not pin Node in the fork.** The policy script demands the literal `24` in
   thirteen source fragments plus every manifest; a partial change fails CI, and a complete
   one becomes a fork-carried change to re-apply on every upstream sync. Let
   upstream drive the bump.
4. **`brew install pnpm@9` gives 9.15.9, not 9.15.4** — and it is keg-only and
   deprecated (disabled 2027-02-06). Any pnpm on PATH already delegates to the
   pinned version; there is nothing to install.
5. **The lockfile has 35 importers; the Dockerfile `deps` stage copies 30
   manifests.** The five uncopied ones (`create-paperclip-plugin` and four
   `plugin-*-example` packages) are **benign** — pnpm skips lockfile importers
   whose directories are absent, verified by replaying the stage's exact file
   layout. Do not "fix" this by adding COPY lines; it is not the cause of an
   `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`.
