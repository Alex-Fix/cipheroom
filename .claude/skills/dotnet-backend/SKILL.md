---
name: dotnet-backend
description: Conventions and scaffolding for the Cipheroom .NET 10 backend (ASP.NET Core minimal APIs, SignalR hubs, LiveKit token + ICE server issuance, LiveKit webhooks/usage guard, xUnit tests, Dockerfile). Use when creating or modifying anything under src/server.
---

# .NET backend

## Scaffold (first time only)
```bash
dotnet new web    -n Cipheroom.Api       -o src/server/Cipheroom.Api       -f net10.0
dotnet new xunit  -n Cipheroom.Api.Tests -o src/server/Cipheroom.Api.Tests -f net10.0
dotnet sln Cipheroom.sln add src/server/Cipheroom.Api src/server/Cipheroom.Api.Tests
dotnet add src/server/Cipheroom.Api.Tests reference src/server/Cipheroom.Api
dotnet add src/server/Cipheroom.Api.Tests package Microsoft.AspNetCore.Mvc.Testing
dotnet add src/server/Cipheroom.Api.Tests package Microsoft.AspNetCore.SignalR.Client
```
Add `Directory.Build.props` at repo root: `Nullable=enable`, `ImplicitUsings=enable`, `TreatWarningsAsErrors=true`,
`LangVersion=latest`. Add `public partial class Program;` so tests can use `WebApplicationFactory<Program>`.

## Structure
```
Cipheroom.Api/
  Program.cs              composition root only
  Hubs/RoomHub.cs, IRoomClient.cs, Contracts/
  Rooms/IRoomRegistry.cs, InMemoryRoomRegistry.cs    lobby, admission, host role
  Rtc/LiveKitOptions.cs, LiveKitTokenService.cs
  Rtc/IIceServerProvider.cs, CloudflareIceServerProvider.cs
  Rtc/LiveKitWebhookEndpoint.cs, UsageGuard.cs        monthly relay usage, free-tier limits
  Health/                 /healthz (used by compose healthcheck)
```

## Conventions
- Minimal APIs grouped with `MapGroup("/api")`; endpoints in static `Map*` extension methods per feature.
- Options pattern + `ValidateOnStart()` for config (`LiveKit:ApiKey`, `LiveKit:ApiSecret`, `LiveKit:Url`, `Turn:Cloudflare:KeyId`, `Turn:Cloudflare:ApiToken`, …). Env vars use `__` (`LiveKit__ApiSecret`). Compose maps `.env` names onto these.
- `TimeProvider` injected for anything time-based (token expiry, usage periods) so tests can fake it.
- Outbound HTTP (Cloudflare TURN API) via typed `HttpClient` + `AddStandardResilienceHandler`; never log the bearer token or returned credentials.
- Logging: structured `ILogger` with message templates. **Never log envelope blobs, chat ciphertext, or anything from client payloads verbatim** beyond ids/lengths.
- CORS: only the configured web origin; SignalR needs `AllowCredentials`.
- Behind cloudflared/nginx: `UseForwardedHeaders` with known proxies.
- Rate limiting: `AddRateLimiter` on `/api/*`; per-connection throttle in the hub.

## LiveKit + ICE
- Token & ICE rules: see the `livekit-media` skill. `GetRtcConfig` is only callable by admitted participants.
- Verify LiveKit webhook signatures (JWT in `Authorization` header, sha256 of body) before trusting usage data.

## Commands
- Run: `dotnet watch --project src/server/Cipheroom.Api` (or `scripts/dev.sh`)
- Test: `dotnet test` (or `scripts/test.sh --server`)
- Format: `dotnet format`

## Dockerfile
Multi-stage: `mcr.microsoft.com/dotnet/sdk:10.0` build → `mcr.microsoft.com/dotnet/aspnet:10.0` runtime,
run as non-root (`USER app`), expose 8080, `HEALTHCHECK` against `/healthz`.
