---
name: dotnet-backend
description: Conventions for the Cipheroom .NET 10 backend — Clean Architecture (Domain/Application/Infrastructure/Api), Mediator commands/queries with FluentValidation, SignalR hubs and filters, LiveKit token + ICE issuance, xUnit v3 tests per layer, chiseled Dockerfile. Use when creating or modifying anything under src/server.
---

# .NET backend

Design: `docs/plans/2026-10-06-backend-clean-architecture-design.md`.

## Layers (dependencies point inward only — enforced by project references)
```
src/server/
  Cipheroom.Domain/          entities, value objects, rules. No project or package references.
    Common/DomainException.cs
    Rooms/RoomId.cs DisplayName.cs ParticipantId.cs Participant.cs Room.cs
  Cipheroom.Application/     → Domain. Mediator.Abstractions, FluentValidation, Logging.Abstractions
    Common/Behaviours/       UnhandledException, Logging, Validation (pipeline order set in Api/Program.cs)
    Common/Exceptions/       NotFoundException
    Common/Interfaces/       ports: IRoomStore, ILiveKitTokenIssuer, IIceServerProvider
    <Feature>/Commands|Queries/<UseCase>/<UseCase>Command.cs   record + validator + handler in one file
    DependencyInjection.cs   AddApplication() (validators)
  Cipheroom.Infrastructure/  → Application. Adapters + options; AddInfrastructure()
    Rooms/InMemoryRoomStore.cs   Rtc/LiveKitTokenIssuer.cs  Rtc/IceServerProviders.cs  Rtc/RtcOptions.cs
  Cipheroom.Api/             → Application, Infrastructure. Composition root; Mediator.SourceGenerator runs here
    Hubs/RoomHub.cs IRoomClient.cs Contracts/   (wire contract — see signaling-protocol skill)
    Hubs/Filters/HubRateLimitFilter.cs HubExceptionFilter.cs
    Hosting/ForwardedHeadersSetup.cs HealthProbe.cs
  Cipheroom.Domain.UnitTests/  Cipheroom.Application.UnitTests/  Cipheroom.Infrastructure.IntegrationTests/
  Cipheroom.Api.FunctionalTests/   WebApplicationFactory + real SignalR client
```

## Adding a use case
1. Domain: new rules/types if needed (constants for limits live here, e.g. `DisplayName.MaxLength`).
2. Application: `XCommand`/`XQuery` record (`ICommand<T>`/`IQuery<T>`), `XValidator : AbstractValidator<X>` reusing
   Domain constants with **constant messages that never echo input**, handler. New port interface if it needs I/O.
3. Infrastructure: adapter for any new port, registered in `AddInfrastructure()`.
4. Api: hub method = one `mediator.Send(...)` + SignalR-only work (groups, events). Map results to `Contracts` by hand
   (`ParticipantDto.From(...)`) — no AutoMapper.
5. Tests: validator + handler unit tests; functional test for the client-visible behaviour and messages.
6. Any hub method/event change → `signaling-protocol` skill (C#, TS, `docs/signaling-protocol.md`, incl. Errors table).

## Conventions
- **Validation:** FluentValidation only, run by `ValidationBehaviour`. Domain constructors keep a cheap guard as a last
  line of defence, not as user-facing validation. `ClassLevelCascadeMode = Stop` when the client shows one message.
- **Errors:** throw `DomainException` (business rule), `NotFoundException`, or let `ValidationException` happen.
  `HubExceptionFilter` maps them to `HubException(message)`; anything else becomes "Something went wrong." and is logged
  without request values. Never `throw new HubException` in Application/Domain. REST uses ProblemDetails.
- **Logging:** `[LoggerMessage]` source-generated methods (CA1848). Log ids and types, **never request values** —
  no display names, envelopes, ciphertext, tokens or TURN credentials. Guard expensive arguments with `IsEnabled`.
- **Options:** `AddOptions<T>().BindConfiguration(...).ValidateDataAnnotations().ValidateOnStart()`. Env vars use `__`
  (`LiveKit__ApiSecret`); compose maps `.env` names onto them.
- **Time:** inject `TimeProvider`; tests use `FakeTimeProvider`.
- **Outbound HTTP:** typed `HttpClient` + `AddStandardResilienceHandler()`; never log bearer tokens or credentials.
- **Rate limiting:** hub invocations via `HubRateLimitFilter` (`RateLimiting:Hub`); `/api/*` will use `AddRateLimiter`.
- **Proxies:** `UseForwardedHeaders` trusts only `ForwardedHeaders:KnownNetworks` (compose sets the Docker range);
  nginx forwards `X-Forwarded-For/Proto/Host`.
- **CORS:** none — everything is same-origin behind nginx.
- **Packages:** versions only in `Directory.Packages.props`; free/open-source only. **Not MediatR or AutoMapper**
  (RPL-1.5/commercial since 2025). Mediator = `Mediator.Abstractions`/`Mediator.SourceGenerator` (MIT).
- **Build:** `Directory.Build.props` sets net10.0, nullable, warnings as errors, `AnalysisLevel=latest-recommended`,
  `EnforceCodeStyleInBuild`. Fix analyzer findings rather than suppressing; tests may use underscores (CA1707 off).

## Commands
- Run: `dotnet watch --project src/server/Cipheroom.Api` (or `scripts/dev.sh`)
- Test: `scripts/test.sh --server` (= `dotnet test --solution Cipheroom.slnx`; Microsoft Testing Platform via global.json)
- Format: `scripts/lint.sh` / `scripts/lint.sh --fix`
- New project: create the `.csproj` (no `TargetFramework`/versions — inherited), then
  `dotnet sln Cipheroom.slnx add --solution-folder src/server <path>`; test projects need `<OutputType>Exe</OutputType>`.

## Dockerfile
Build context is the repo root. SDK stage copies `global.json` + `Directory.*.props` + each layer's `.csproj` (cached
restore), then sources, then publishes. Runtime: `mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled` (no shell,
non-root `$APP_UID`), port 8080, `HEALTHCHECK CMD ["dotnet", "Cipheroom.Api.dll", "--health"]`. Add new layer projects
to the COPY lines.

## LiveKit + ICE
Token and ICE rules: `livekit-media` skill. `GetRtcConfig` only for joined participants (`NotFoundException`
otherwise). Verify LiveKit webhook signatures before trusting usage data (future usage guard).
