# Repository restructure — design
Status: approved · Date: 2026-10-06

## Problem

The repo grew in three quick PRs and no longer follows one set of conventions:

- Backend lives in `src/server/` while the frontend sits at the root in `web/`; test projects are mixed in with
  production projects.
- Frontend uses two style preprocessors (Less for global/theme, SCSS for components), mixes inline and external
  templates, keeps 9 components flat in `features/room/`, and `room` imports a helper from the `home` feature.
- IDE config is half-tracked (`.idea/`, `web/.vscode/`), `web/` duplicates root dotfiles, `web/README.md` is CLI
  boilerplate.
- Docs and skills drifted from the code (e.g. `AppHubService` in `architecture.md` vs `SignalingService`).

## Goals / Non-goals

Goals
- .NET-style `src/` + `tests/` at the root, `web/` beside them.
- One style language (Less); every Angular component is a folder with `.ts` + `.html` + `.less` + `.spec.ts`.
- Clear `core/` / `shared/` / `features/` rules, no cross-feature imports.
- IDE files untracked, one root `.editorconfig` / `.gitignore`.
- Docs, skills and `CLAUDE.md` describe the code as it is after the move.

Non-goals
- No runtime behaviour, protocol, UI or dependency changes.
- No rewriting of dated design records in `docs/plans/`.
- No new tooling (CI, monorepo tools, prettier rule changes).

## Constraints check

| Constraint | Answer |
|---|---|
| E2EE invariant | Unaffected — pure refactor, no server-side data flow changes. |
| $0 running cost | Unaffected. |
| No public IP | Unaffected. |
| Self-hostable + open source | Unaffected; no new dependencies. |
| Untrusted server | Unaffected. |
| Browser support | Unaffected; Less compiles to the same CSS. |
| Two signaling channels | Unaffected. |
| **Real risk: broken paths** | Dockerfile `COPY`s, compose `dockerfile:`, `.dockerignore`, `scripts/_common.sh`, `.editorconfig` test glob (would silently stop matching), `.gitignore` secret rules. Each is verified explicitly. |

## Chosen approach

One branch `refactor/repo-layout`, one PR, one green commit per area (.NET layout → frontend styles → component
folders → hygiene → docs/skills). Moves via `git mv` so history survives the squash merge.

- Why not one PR per area: four review/smoke cycles, docs and skills half-stale between merges; squash merges
  already flatten history.
- Why not `server/` + `web/` or `src/server` + `src/web`: user preference for the familiar .NET `src/` + `tests/`
  root.
- Why not Dockerfiles under `deploy/`: images stay next to the code they build; `deploy/` stays runtime config.

## Design

### 1. .NET layout

```
Cipheroom.slnx  global.json  Directory.Build.props  Directory.Packages.props
src/
  Cipheroom.Domain/  Cipheroom.Application/  Cipheroom.Infrastructure/
  Cipheroom.Api/          (+ Dockerfile)
tests/
  Cipheroom.Domain.UnitTests/  Cipheroom.Application.UnitTests/
  Cipheroom.Infrastructure.IntegrationTests/  Cipheroom.Api.FunctionalTests/
web/  deploy/  scripts/  docs/
```

- `git mv` production projects to `src/`, test projects to `tests/`; remove `src/server/`.
- `Cipheroom.slnx`: solution folders `/src/` and `/tests/`.
- Test `ProjectReference`s → `..\..\src\Cipheroom.X\…`.
- `tests/Directory.Build.props` (importing the root one) holds the settings all four test projects repeated
  (`IsPackable`, `OutputType=Exe`, `xunit.v3`, `using Xunit`). The root props pin `ArtifactsPath` to the repo root,
  because the SDK otherwise puts output next to the nearest `Directory.Build.props` (`tests/artifacts/`).
- `.editorconfig`: `[src/server/*Tests/**.cs]` → `[tests/**.cs]`.
- Api `Dockerfile`: `COPY src/server/…` → `src/…`; context stays repo root.
- `deploy/docker-compose.yml`: `dockerfile: src/Cipheroom.Api/Dockerfile`.
- `scripts/_common.sh`: `API_DIR`, `TESTS_DIR` updated; check `test.sh` / `lint.sh`.
- `artifacts/` layout unchanged (keyed by project name).

### 2. Frontend internals

Styles
- `angular.json`: `schematics.style` and `inlineStyleLanguage` → `less`.
- Component `.scss` → `.less` (only nesting/`&` used — content unchanged).

Components — folder per component, always `.ts` + `.html` + `.less` + `.spec.ts`

```
features/
  home/
    home.ts .html .less .spec.ts
    room-id.ts (+spec)                  newRoomId() moved out of home.ts
  room/
    room.ts .html .less .spec.ts
    call-controls/       call-controls.ts .html .less .spec.ts
    call-header/         call-header.ts .html .less .spec.ts
    call-tile/           …
    participants-panel/  …
    diagnostics-drawer/  …  (inline template + styles extracted)
    call-status.ts (+spec)              callStatus() moved out of call-header (room uses it too)
    participant-changes.ts (+spec)
    device-error.ts (+spec)
core/
  signaling/  livekit/                  unchanged
  settings/display-name.ts (+spec)      loadDisplayName + DISPLAY_NAME_KEY moved out of home.ts
  ui/icons.ts  ui/theme.service.ts      unchanged
shared/
  track.directive.ts (+spec)
  initials.ts (+spec)                   renamed from avatar.ts
```

Rules (go into the `angular-frontend` skill)
- A component file contains only the component; exported helpers live in their own `.ts` next to it.
- `core/` = app-wide singletons and providers; `shared/` = reusable directives/pipes and pure template helpers;
  `features/` never import from other features.
- Directives and pipes are a single `.ts` (+ spec); the html/less/ts rule is for components.
- Every component has a spec — including the root `App`, which also gets `app.html` / `app.less`.

Icon pipeline
- `web/src/assets-src/` → `web/design/` (master SVGs, not part of the build). `web/scripts/icons.mjs` and the root
  entrypoint `scripts/icons.sh` stay; paths updated.

### 3. Repo hygiene

- `git rm -r --cached .idea web/.vscode`; root `.gitignore` gets plain `.idea/` and `.vscode/` (any depth),
  replacing the partial rules.
- Merge `web/.editorconfig` into root (`[*.ts] quote_type = single`, `[*.md] max_line_length = off`) and delete it.
- Merge relevant `web/.gitignore` rules into root (`/web/.angular/cache`, `/web/out-tsc`, `/web/tmp`, `*.log`,
  `__screenshots__/`) and delete it.
- Tool config stays in `web/`: `.prettierrc`, `tsconfig*`, `angular.json`, `proxy.conf.json`.
- `.dockerignore`: add `tests/`; confirm `deploy/.env`, `.certs` still excluded.
- `web/README.md`: short real README (what it is, `npm ci`, pointers to `scripts/dev.sh`, `scripts/test.sh --web`,
  `angular-frontend` skill).
- Fix the stray `r` in `web/angular.json` (uncommitted typo) — confirm with the user first.

### 4. Docs and skills

Living docs updated; dated `docs/plans/*` left as historical records.

- `CLAUDE.md`: Layout block and Conventions (Less only; component folder rule; core/shared/features).
- `README.md`: path/layout mentions.
- `docs/architecture.md`: `AppHubService` → `SignalingService`; verify every named class/service against the code;
  mark not-yet-built pieces (`CryptoService`, identities, envelopes) as *planned*.
- `docs/signaling-protocol.md`: verify cited file paths.
- Skills: `dotnet-backend`, `docker-deploy`, `security`, `signaling-protocol`, `angular-frontend`.
- `.claude/settings.json`: check for path-based permissions.

## Protocol changes

None.

## Security notes

- Secret ignore rules (`.env`, `*.env`, `.certs/`, `*.pem`, `*.key`, `deploy/cloudflared/*.json`) are path-agnostic
  and stay; re-verify with `git check-ignore` after the `.gitignore` rewrite.
- `.dockerignore` must keep excluding `deploy/.env` and `.certs`; adding `tests/` shrinks the build context.
- `scripts/security-check.sh` must pass on the branch.

## Testing

Per commit: build + tests for the touched side, `scripts/lint.sh`.

- .NET: `dotnet build`, `scripts/test.sh --server`, `docker compose -f deploy/docker-compose.yml build api`.
- Web: `scripts/test.sh --web`, `ng lint`, `ng build` (theme bundles), visual check of home + room in both themes.
- End of branch: `scripts/test.sh`, `scripts/security-check.sh`, `scripts/up.sh --tunnel` smoke test with a
  two-device call.
- Drift grep outside `docs/plans/` and `artifacts/` returns nothing: `src/server`, `Api.Tests`, `.scss`,
  `AppHubService`, `assets-src`.
- `git status` clean (no new untracked files) after a full build/test run.

## Open questions

None left: `tests/Directory.Build.props` was worth it (see Design §1).

## Implementation steps

1. Move .NET projects to `src/` + `tests/`; update slnx, test project references, `.editorconfig` glob, api
   Dockerfile, compose, `scripts/_common.sh`, `.dockerignore`.
2. Frontend styles: `angular.json` → less (+ fix stray `r`), rename component `.scss` → `.less`.
3. Frontend helpers: extract `display-name.ts` to `core/settings/`, `room-id.ts`, `room/call-status.ts`; rename
   `avatar.ts` → `initials.ts`; specs follow.
4. Frontend components: folder per component, external `.html` / `.less` for every component (incl. root `App`
   with a new spec).
5. Icon pipeline: `web/src/assets-src/` → `web/design/`, update `icons.mjs` / `scripts/icons.sh` / docs.
6. Hygiene: untrack `.idea` / `web/.vscode`, merge `web/.editorconfig` and `web/.gitignore` into root, real
   `web/README.md`.
7. Docs and skills: `CLAUDE.md`, `README.md`, `architecture.md`, `signaling-protocol.md`, the five skills; drift
   grep; full test + security check + home-stack smoke test.
