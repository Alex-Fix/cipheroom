---
name: signaling-protocol
description: How to add or change a SignalR app-signaling message in Cipheroom (lobby, admission, key envelopes, encrypted chat, RTC config) end to end (C# hub + IRoomClient, TypeScript types + SignalingService, protocol doc, tests). Use whenever a hub method, server-to-client event, or signaling DTO is added, renamed, or changed.
---

# Changing the signaling protocol

SignalR is the only signaling channel: rooms, media negotiation with the SFU (the api relays SDP to Cloudflare — see
the `media` skill) and, later, key envelopes and chat. SDP is opaque to the api: validate size/shape, never log it.

A protocol change is incomplete unless **all** of these are updated in the same change:

1. **C# contract**
   - Client→server: method on `src/Cipheroom.Api/Hubs/RoomHub.cs` (`Hub<IRoomClient>`).
   - Server→client: method on `src/Cipheroom.Api/Hubs/IRoomClient.cs`.
   - DTOs: `record`s in `src/Cipheroom.Api/Hubs/Contracts/`.
2. **TS contract** — `web/src/app/core/signaling/signaling.types.ts`: mirror DTOs as `interface`s, add method
   names to the `HubMethods` / `ClientEvents` maps.
3. **TS service** — `web/src/app/core/signaling/signaling.service.ts`: typed `invoke` wrapper or `on` handler
   exposed as a signal/observable. Components never call `HubConnection` directly.
4. **Doc** — row in `docs/signaling-protocol.md`.
5. **Tests** — hub functional test in `tests/Cipheroom.Api.FunctionalTests` (connect two or more `HubConnection`s to a
   `WebApplicationFactory` host, assert relay/broadcast).

## Server rules
- Validate inputs: lengths (displayName ≤ 64, envelope blob ≤ 1 KB, chat ciphertext ≤ 64 KB), ids are known members of the
  caller's room, caller is admitted (host-only methods check host role). Relaying to an arbitrary connection id outside the room is a bug.
- Relay targeted messages with `Clients.Client(targetId)`; never `Clients.All`.
- Room state lives behind the `IRoomStore` port (in-memory, thread-safe adapter in Infrastructure). Clean up in
  `OnDisconnectedAsync` via the `LeaveRoom` command.
- Rate-limit chatty methods (envelopes, chat) per connection.
- Never add fields that could carry key material. If you think you need one, stop and consult `e2ee-media`.

## Naming
- PascalCase method names in both C# and the TS string literals (SignalR is case-insensitive server-side, but keep it consistent).
- Server→client events are past tense (`ParticipantJoined`, `KeyEnvelopeReceived`); client→server are imperative (`JoinLobby`, `SendChat`).
