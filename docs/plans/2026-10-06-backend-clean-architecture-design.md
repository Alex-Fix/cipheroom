# Backend Clean Architecture — design
Status: approved · Date: 2026-10-06

## Problem
The backend is a single `Cipheroom.Api` project (~350 lines) where hub methods mix input validation, room rules,
token issuance and SignalR plumbing. It's fine at this size but has no seams for what's coming (key-envelope relay,
lobby/admission, usage guard, webhooks), and several practices our own `dotnet-backend` skill promises are missing
(hub rate limiting, forwarded headers, health check in the image, central error handling).

Reference: [jasontaylordev/CleanArchitecture](https://github.com/jasontaylordev/cleanarchitecture) (.NET 10).

## Goals / Non-goals
**Goals**
- Clean Architecture layering as in the reference template: Domain, Application, Infrastructure, Api (presentation).
- Command/query pipeline with **Mediator** (MIT) and **FluentValidation** (Apache-2.0) behaviours.
- Central error handling (hub filter + ProblemDetails), per-connection hub rate limiting, forwarded headers.
- Build hygiene: central package management, stricter analyzers, pinned SDK.
- Hardened container: chiseled runtime image with a health probe.
- Tests per layer; **no change to client-visible behaviour or the signaling protocol**.

**Non-goals**
- Persistence / EF Core / Respawn (nothing is persisted yet).
- .NET Aspire (AppHost or ServiceDefaults), OpenTelemetry.
- New REST endpoints, usage guard, E2EE — later features that will slot into these layers.

## Constraints check
| Constraint | This change |
|---|---|
| E2EE invariant | No impact; no new data handled. Logging behaviour explicitly logs request type + ids only, never payload values (future envelopes/ciphertext must never be logged). |
| $0 running cost | No services added. |
| No public IP | No new ports; health probe is in-container. |
| Self-hostable + open source | All dependencies verified free/open: Mediator (MIT), FluentValidation (Apache-2.0), xunit.v3 (Apache-2.0), NSubstitute (BSD-3-Clause). **Not** MediatR / AutoMapper — since 2025 under Lucky Penny's RPL-1.5/commercial terms (checked in the 14.x package license file). |
| Untrusted server / clients | Every hub input validated in the pipeline; rate limiting per connection; generic messages for unexpected errors (no stack traces / internals to clients). |
| Two signaling channels | Unchanged; SignalR contracts keep the exact JSON shape and messages. |

## Chosen approach
Full Clean Architecture (four projects + four test projects) with Mediator + FluentValidation, adopting the
template's cross-cutting practices but not its commercial libraries or Aspire.

- *Why not one project with practices only:* user preference for explicit layers ahead of upcoming features.
- *Why not a Core/Api split:* user chose the full template structure.
- *Why not MediatR:* RPL-1.5/commercial licensing conflicts with "stay free and open".
- *Why not plain handler interfaces:* Mediator gives the same pipeline model with source generation and no reflection.
- *Why not Aspire:* `scripts/dev.sh` + Compose already orchestrate; not worth a second path now.

## Design

### Projects and dependency rule
```
src/server/
  Cipheroom.Domain/                      no dependencies
  Cipheroom.Application/                 → Domain; Mediator.Abstractions, FluentValidation
  Cipheroom.Infrastructure/              → Application; Microsoft.IdentityModel.JsonWebTokens, Http.Resilience
  Cipheroom.Api/                         → Application, Infrastructure; Mediator.SourceGenerator (composition root)
  Cipheroom.Domain.UnitTests/
  Cipheroom.Application.UnitTests/
  Cipheroom.Infrastructure.IntegrationTests/
  Cipheroom.Api.FunctionalTests/         (renamed from Cipheroom.Api.Tests)
```
The presentation project keeps the name **Cipheroom.Api** (the template's "Web") — `web/` is already the Angular app.
Project references enforce inward-only dependencies.

| Today | Layer | Becomes |
|---|---|---|
| Regex/length checks in `RoomHub` | Domain | `RoomId`, `DisplayName`, `ParticipantId` value objects (`readonly record struct`) holding the rule constants (`RoomId.Pattern`, `DisplayName.MaxLength`) + a constructor guard (`ArgumentException`) |
| `Participant`, one-room-per-connection rule | Domain | `Participant` entity, `Room` aggregate (join/leave), `DomainException` |
| `IRoomRegistry` | Application | `IRoomStore` port |
| Hub method logic | Application | `JoinRoomCommand`, `LeaveRoomCommand`, `GetRtcConfigQuery` + handlers + FluentValidation validators |
| `LiveKitTokenService`, ICE providers | Application ports → Infrastructure | `ILiveKitTokenIssuer`, `IIceServerProvider` → `LiveKitTokenIssuer`, `CloudflareIceServerProvider`, `DirectIceServerProvider` |
| `InMemoryRoomRegistry`, options | Infrastructure | `InMemoryRoomStore`, `LiveKitOptions`, `TurnOptions`; `AddInfrastructure()` |
| `RoomHub`, `IRoomClient`, contracts | Api | Thin hub: sends command, then SignalR-only work (groups, `ParticipantJoined`/`Left`). Contract records unchanged. |

### Validation
- **FluentValidation is the single source of input validation.** Validators in Application reference the Domain
  constants, so each rule is written once. Messages are constant text — they never echo input.
- `ValidationBehaviour` runs all validators for every command/query before the handler and throws
  FluentValidation's `ValidationException`.
- Domain constructor guards are a last line of defence for code paths that bypass the pipeline, not user-facing
  validation.
- Registration: `AddValidatorsFromAssembly(typeof(DependencyInjection).Assembly)`.

### Request pipeline
```
RoomHub.JoinRoom(roomId, displayName)
  → mediator.Send(new JoinRoomCommand(connectionId, roomId, displayName))
      LoggingBehaviour            request type + ids only
      ValidationBehaviour         FluentValidation → ValidationException
      UnhandledExceptionBehaviour logs (no request values) + rethrows
      JoinRoomCommandHandler      Room aggregate → IRoomStore → JoinRoomResult
  ← hub: Groups.Add + Clients.OthersInGroup.ParticipantJoined(...)
```

### Error handling
One `HubExceptionFilter` (`IHubFilter`) replaces the scattered `throw new HubException`:

| Exception | Client sees | Logged |
|---|---|---|
| `ValidationException` | `HubException` with validator messages (today's text, byte-identical) | Debug, property names only |
| `DomainException` | `HubException(message)` (e.g. "Already in a room.") | Information |
| `NotFoundException` | `HubException("Join a room first.")` | Information |
| anything else | `HubException("Something went wrong.")` | Error with exception, no request values |

REST: `AddProblemDetails()` + `UseExceptionHandler()` now, so future endpoints (LiveKit webhook, usage guard) return
RFC 9457 errors without stack traces.

### Build and packaging
- `Directory.Packages.props` (central package management); `.csproj` files list names only.
- `Directory.Build.props`: `TargetFramework=net10.0`, `Nullable`, `ImplicitUsings`, `TreatWarningsAsErrors` (moved
  here, removed from `.csproj`s), plus `AnalysisLevel=latest-recommended`, `EnforceCodeStyleInBuild=true`,
  `Deterministic`, `ContinuousIntegrationBuild` (when `CI=true`).
- `global.json`: .NET 10 SDK, `rollForward: latestFeature`.

### Hardening
- **Hub rate limiting:** `HubRateLimitFilter` with a per-connection `PartitionedRateLimiter` token bucket
  (burst 20, 5/s, configurable). Over the limit → `HubException("Too many requests.")`; logged with participant id.
  Limiter partitions are released on disconnect.
- **Forwarded headers:** `UseForwardedHeaders` (proto/host/for) trusting only `ForwardedHeaders:KnownNetworks`
  (the compose network).
- **Container:** runtime `mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled` (no shell, non-root).
  `HEALTHCHECK CMD ["dotnet", "Cipheroom.Api.dll", "--health"]` — `Program.cs` short-circuits on `--health`, GETs
  `http://localhost:8080/healthz`, exits 0/1. Compose: `depends_on: api: condition: service_healthy` for `web`.
- **Health:** `/healthz` stays liveness-only (a TURN outage must not restart the API).
- **CORS:** none (same-origin behind nginx); skill text corrected.

## Protocol changes
None. Hub method names, parameters, results, events and error messages are unchanged; enforced by functional tests
written before the move.

## Security notes
- Logging behaviour and exception filter never log request values (today: names; later: envelopes/ciphertext).
- Unexpected errors return a generic message — no exception text or stack to clients.
- Rate limiting bounds abuse of hub methods per connection (join spam, token minting via `GetRtcConfig`).
- Chiseled image removes shell/package manager from the attack surface.
- Dependency licences verified (see constraints table); no packages with reciprocal/commercial terms.

## Testing
| Project | Covers |
|---|---|
| Domain.UnitTests | `Room` join/leave rules, value-object guards |
| Application.UnitTests | each validator (valid + each rule), handlers with NSubstitute ports, behaviours (validation short-circuits; logging has no values) |
| Infrastructure.IntegrationTests | `InMemoryRoomStore` concurrency, `LiveKitTokenIssuer` (existing tests move here), `CloudflareIceServerProvider` with a fake `HttpMessageHandler` |
| Api.FunctionalTests | existing hub tests + exact error messages, rate limit, generic error, `/healthz`, ProblemDetails shape |

Plus: `scripts/test.sh`, `scripts/lint.sh` (`dotnet format --verify-no-changes`), `scripts/security-check.sh`,
`docker compose build`, container becomes `healthy`, two-browser call on the rebuilt stack.

## Open questions
- None.

## Implementation steps
1. Tooling: `global.json`, `Directory.Packages.props`, stricter `Directory.Build.props`; clean `.csproj`s; fix new
   analyzer warnings.
2. Pin behaviour: rename tests to `Cipheroom.Api.FunctionalTests`, xUnit v3; add tests for current error messages and
   flows.
3. Domain project: value objects, `Participant`, `Room`, `DomainException` + unit tests.
4. Application project: ports, commands/queries, validators, behaviours, `AddApplication()` + unit tests.
5. Infrastructure project: `InMemoryRoomStore`, `LiveKitTokenIssuer`, ICE providers, options, `AddInfrastructure()`
   + integration tests; remove old code from Api.
6. Api: thin `RoomHub` via Mediator, `HubExceptionFilter`, ProblemDetails/exception handler; functional tests green.
7. Hardening: `HubRateLimitFilter`, forwarded headers + tests.
8. Container: chiseled image, `--health` probe, Dockerfile restores all projects, compose healthcheck.
9. Docs: `CLAUDE.md` layout/conventions, `dotnet-backend` skill rewrite, `docs/architecture.md` backend layering.
