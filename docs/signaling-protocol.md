# App signaling protocol (SignalR)

Hub: `/hubs/room` (SignalR, JSON). Server→client methods are defined in C# `IRoomClient` and mirrored in
TS `web/src/app/core/signaling/signaling.types.ts`. Keep all three in sync.

Media negotiation with the SFU (Cloudflare Realtime SFU) also goes through this hub: the api relays SDP offers and
answers to Cloudflare with its app secret, which never reaches clients. The api never sees media, and SDP is never
logged (it contains client IP addresses). Clients refer to remote tracks by **participant + source**; Cloudflare track
names and session ids stay server-side. Design: `docs/plans/2026-10-07-cloudflare-sfu-design.md`.
Payloads never contain plaintext keys: only public keys and opaque signed envelopes.

## Implemented

| Direction | Method | Args | Returns |
|---|---|---|---|
| C→S | `JoinRoom` | `roomId` (`^[a-z0-9-]{3,64}$`), `displayName` (1–64 chars) | `JoinResult { selfId, participants[] }` |
| C→S | `GetRtcConfig` | — | `RtcConfig { iceServers[], forceRelay }` (Cloudflare STUN/TURN; `forceRelay` only when `Turn:ForceRelay` is set) |
| C→S | `LeaveRoom` | — | — (also on disconnect) |
| C→S | `PublishTracks` | `offerSdp`, `tracks[{ mid, source }]` (1–3, distinct mids and sources) | `AnswerDto { answerSdp }` |
| C→S | `SubscribeTracks` | `tracks[{ participantId, source }]` (1–64, same room only) | `SubscribeResult { offerSdp \| null, tracks[{ participantId, source, mid }] }` |
| C→S | `Renegotiate` | `answerSdp` (answer to a `SubscribeTracks` offer) | — |
| C→S | `RestartIce` | `offerSdp` (ICE-restart offer) | `AnswerDto { answerSdp }` |
| C→S | `UnpublishTracks` | `sources[]` | — |
| C→S | `UnsubscribeTracks` | `mids[]` (own receiving mids, 1–64) | — |
| C→S | `SetTrackMuted` | `source`, `muted` | — |
| C→S | `SelectVideoLayer` | `mid` (received camera track), `rid` (`f` / `h` / `q`) | — |
| S→C | `ParticipantJoined` | `ParticipantDto { id, displayName, tracks[] }` | |
| S→C | `ParticipantLeft` | `id` | |
| S→C | `TracksPublished` | `participantId`, `TrackDto[] { source, kind, muted }` | |
| S→C | `TracksUnpublished` | `participantId`, `sources[]` | |
| S→C | `TrackMuted` | `participantId`, `source`, `muted` | |

Values: `source` ∈ `microphone` / `camera` / `screen`; `kind` ∈ `audio` / `video` (follows from the source); SDP ≤ 32 KB
and starts with `v=0`; `mid` matches `^[A-Za-z0-9_-]{1,16}$`. Media events go to the **other** participants in the room;
the caller already knows its own state. The media session is created on the first `PublishTracks` / `SubscribeTracks`.

`JoinRoom` is open (no lobby) until admission is built; it will be replaced by `JoinLobby` below.

### Errors

Failures arrive as a `HubException`; the client sees `…HubException: <message>`. Messages are constant text and never
echo input. Mapped centrally by `HubExceptionFilter`; pinned by `Cipheroom.Api.FunctionalTests`.

| Message | When |
|---|---|
| `Invalid room id.` | `JoinRoom` with a room id not matching `^[a-z0-9-]{3,64}$` |
| `Display name must be 1-64 characters.` | `JoinRoom` with a blank or too-long name (checked after the room id) |
| `Already in a room.` | `JoinRoom` on a connection that has already joined |
| `Join a room first.` | `GetRtcConfig` or any media method before joining |
| `Invalid session description.` | SDP missing, over 32 KB or not starting with `v=0` |
| `Invalid track.` | Bad track list, mid, source or participant id |
| `Invalid layer.` | `SelectVideoLayer` with a layer other than `f` / `h` / `q` |
| `Track already published.` | `PublishTracks` for a source that is already published (or listed twice) |
| `Unknown track.` | Track not published in the caller's room (incl. own tracks), mute of an unpublished source, layer for a non-camera track |
| `No media session.` | `Renegotiate` / `RestartIce` before publishing or subscribing |
| `Media server unavailable.` | Cloudflare refused or failed the request (cause logged as status / error code only) |
| `Too many requests.` | More than 20 calls in a burst / 5 per second on one connection (`RateLimiting:Hub`) |
| `Something went wrong.` | Any unexpected server error (details only in the server log) |

## Planned — Client → Server (hub methods)

| Method | Args | Returns | Notes |
|---|---|---|---|
| `JoinLobby` | `roomId, displayName, identity: SignedIdentityBundle` | `LobbyStatus` | waits for admission unless room is open |
| `Admit` / `Deny` | `participantId` | — | host only |
| `LeaveRoom` | — | — | also on disconnect; triggers key rotation |
| `SendKeyEnvelopes` | `envelopes: KeyEnvelope[]` (`{ toId, keyIndex, epoch, blob }`) | — | each relayed to `toId` only |
| `SendChat` | `ciphertext, keyIndex` | — | broadcast to room |

## Planned — Server → Client (`IRoomClient`)

| Method | Args |
|---|---|
| `LobbyRequest` | `participantId, displayName, identity` (to host) |
| `Admitted` / `Denied` | — |
| `ParticipantJoined` | `Participant { id, displayName, identity }` → rotate own sender key |
| `ParticipantLeft` | `id` → rotate own sender key |
| `KeyEnvelopeReceived` | `fromId, keyIndex, epoch, blob` |
| `ChatReceived` | `fromId, ciphertext, keyIndex` |
| `QuotaWarning` | `usedGb, limitGb` (admins) |

_Draft — update as the hub is implemented._
