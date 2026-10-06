---
name: signaling-protocol
description: How to add or change a SignalR app-signaling message in Cipheroom (lobby, admission, key envelopes, encrypted chat, RTC config) end to end (C# hub + IRoomClient, TypeScript types + SignalingService, protocol doc, tests). Use whenever a hub method, server-to-client event, or signaling DTO is added, renamed, or changed.
---

# Changing the signaling protocol

SignalR carries **app** signaling only. Media signaling (SDP/ICE) belongs to LiveKit — never add it here.

A protocol change is incomplete unless **all** of these are updated in the same change:

1. **C# contract**
   - Client→server: method on `src/server/Cipheroom.Api/Hubs/RoomHub.cs` (`Hub<IRoomClient>`).
   - Server→client: method on `src/server/Cipheroom.Api/Hubs/IRoomClient.cs`.
   - DTOs: `record`s in `src/server/Cipheroom.Api/Hubs/Contracts/`.
2. **TS contract** — `web/src/app/core/signaling/signaling.types.ts`: mirror DTOs as `interface`s, add method
   names to the `HubMethods` / `ClientEvents` maps.
3. **TS service** — `web/src/app/core/signaling/signaling.service.ts`: typed `invoke` wrapper or `on` handler
   exposed as a signal/observable. Components never call `HubConnection` directly.
4. **Doc** — row in `docs/signaling-protocol.md`.
5. **Tests** — hub integration test in `Cipheroom.Api.Tests` (connect two or more `HubConnection`s to a
   `WebApplicationFactory` host, assert relay/broadcast).

## Server rules
- Validate inputs: lengths (displayName ≤ 64, envelope blob ≤ 4 KB, chat ciphertext ≤ 64 KB), ids are known members of the
  caller's room, caller is admitted (host-only methods check host role). Relaying to an arbitrary connection id outside the room is a bug.
- Relay targeted messages with `Clients.Client(targetId)`; never `Clients.All`.
- Room state is in an in-memory `IRoomRegistry` singleton (thread-safe). Clean up in `OnDisconnectedAsync`.
- Rate-limit chatty methods (envelopes, chat) per connection.
- Never add fields that could carry key material. If you think you need one, stop and consult `e2ee-media`.

## Naming
- PascalCase method names in both C# and the TS string literals (SignalR is case-insensitive server-side, but keep it consistent).
- Server→client events are past tense (`ParticipantJoined`, `KeyEnvelopeReceived`); client→server are imperative (`JoinLobby`, `SendChat`).
