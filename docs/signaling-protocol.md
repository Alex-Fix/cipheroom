# App signaling protocol (SignalR)

Hub: `/hubs/room` (SignalR, JSON). Server→client methods are defined in C# `IRoomClient` and mirrored in
TS `web/src/app/core/signaling/signaling.types.ts`. Keep all three in sync.

Media signaling (SDP/ICE) is **not** here — LiveKit handles it over its own WebSocket.
Payloads never contain plaintext keys: only public keys and opaque signed envelopes.

## Implemented (connectivity spike)

| Direction | Method | Args | Returns |
|---|---|---|---|
| C→S | `JoinRoom` | `roomId` (`^[a-z0-9-]{3,64}$`), `displayName` (1–64 chars) | `JoinResult { selfId, participants[] }` |
| C→S | `GetRtcConfig` | — | `RtcConfig { livekitUrl, token, iceServers[], forceRelay }` |
| C→S | `LeaveRoom` | — | — (also on disconnect) |
| S→C | `ParticipantJoined` | `ParticipantDto { id, displayName }` | |
| S→C | `ParticipantLeft` | `id` | |

`JoinRoom` is open (no lobby) until admission is built; it will be replaced by `JoinLobby` below.

## Planned — Client → Server (hub methods)

| Method | Args | Returns | Notes |
|---|---|---|---|
| `JoinLobby` | `roomId, displayName, identity: SignedIdentityBundle` | `LobbyStatus` | waits for admission unless room is open |
| `Admit` / `Deny` | `participantId` | — | host only |
| `LeaveRoom` | — | — | also on disconnect; triggers key rotation |
| `GetRtcConfig` | — | `RtcConfig { livekitUrl, token, iceServers[] }` | admitted participants only |
| `SendKeyEnvelopes` | `envelopes: KeyEnvelope[]` (`{ toId, keyIndex, epoch, blob }`) | — | each relayed to `toId` only |
| `SendChat` | `ciphertext, keyIndex` | — | broadcast to room |
| `UpdateMediaState` | `{ audio, video, screen }` | — | UI hints only |

## Planned — Server → Client (`IRoomClient`)

| Method | Args |
|---|---|
| `LobbyRequest` | `participantId, displayName, identity` (to host) |
| `Admitted` / `Denied` | — |
| `ParticipantJoined` | `Participant { id, displayName, identity }` → rotate own sender key |
| `ParticipantLeft` | `id` → rotate own sender key |
| `KeyEnvelopeReceived` | `fromId, keyIndex, epoch, blob` |
| `ChatReceived` | `fromId, ciphertext, keyIndex` |
| `MediaStateChanged` | `id, MediaState` |
| `QuotaWarning` | `usedGb, limitGb` (admins) |

_Draft — update as the hub is implemented._
