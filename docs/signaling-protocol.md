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
| C→S | `JoinLobby` | `roomId` (`^[a-z2-7]{26}$`), `identity: IdentityDto` (required), `videoCodecs: string[]` (required), `hostProof: HostProofDto \| null`, `ticket: TicketDto \| null` | `LobbyResult { selfId, admitted, participants[], authority, ticket }` — see "Lobby and admission" |
| C→S | `Knock` | `knocks[{ toId, blob }]` (1–16, distinct `toId`s, each an admitter in the call; `blob` base64url, 1–2048 chars) | — (each relayed to its `toId` only, as `KnockReceived`) |
| C→S | `Admit` | `guestId`, `sig` (ticket: our identity's signature over the guest's identity) | — |
| C→S | `Deny` | `guestId` | — |
| C→S | `GrantCoHost` | `participantId`, `sig` (host only) | — |
| C→S | `RemoveParticipant` | `participantId`, `sig` (revocation) | — |
| C→S | `UpdateSettings` | `seq` (1–2³²−1, higher than the last), `autoAdmit`, `sig` (host only) | — |
| C→S | `AskToMute` | `participantId`, `seq`, `sig` | — |
| C→S | `EndCall` | `sig` | — |
| C→S | `GetRtcConfig` | — | `RtcConfig { iceServers[], forceRelay }` (Cloudflare STUN/TURN; `forceRelay` only when `Turn:ForceRelay` is set) |
| C→S | `LeaveRoom` | — | — (also on disconnect; also leaves the lobby) |
| C→S | `PublishTracks` | `offerSdp`, `tracks[{ mid, source }]` (1–3, distinct mids and sources) | `AnswerDto { answerSdp }` |
| C→S | `SubscribeTracks` | `tracks[{ participantId, source }]` (1–64, same room only) | `SubscribeResult { offerSdp \| null, tracks[{ participantId, source, mid }] }` |
| C→S | `Renegotiate` | `answerSdp` (answer to a `SubscribeTracks` offer) | — |
| C→S | `RestartIce` | `offerSdp` (ICE-restart offer) | `AnswerDto { answerSdp }` |
| C→S | `UnpublishTracks` | `sources[]` | — |
| C→S | `UnsubscribeTracks` | `mids[]` (own receiving mids, 1–64) | — |
| C→S | `SetTrackMuted` | `source`, `muted` | — |
| C→S | `SelectVideoLayer` | `mid` (received camera track), `rid` (`f` / `h` / `q`) | — |
| C→S | `SendKeyEnvelopes` | `envelopes[{ toId, blob }]` (1–64, distinct `toId`s, each another participant of the caller's room; `blob` base64url, 1–2048 chars) | — (each relayed to its `toId` only) |
| C→S | `ReportCallStats` | `CallStatsDto` (numbers only — see "Call-quality reports") | — |
| S→C | `ParticipantJoined` | `ParticipantDto { id, tracks[], identity, videoCodecs[], ticket }` (no name: names travel encrypted) | |
| S→C | `ParticipantLeft` | `id` | |
| S→C | `TracksPublished` | `participantId`, `TrackDto[] { source, kind, muted }` | |
| S→C | `TracksUnpublished` | `participantId`, `sources[]` | |
| S→C | `TrackMuted` | `participantId`, `source`, `muted` | |
| S→C | `KeyEnvelopeReceived` | `fromId` (set by the server from the sender's connection), `blob` | |
| S→C | `KnockReceived` | `LobbyGuestDto { id, identity }`, `blob` | to the admitter it's for |
| S→C | `LobbyLeft` | `guestId` | to admitters: admitted, denied or gone |
| S→C | `Admitted` | `LobbyResult` (as from `JoinLobby`, `admitted: true`) | to the guest |
| S→C | `Denied` | — | to the guest |
| S→C | `AuthorityUpdated` | `AuthorityDto` | to the room and the lobby |
| S→C | `Removed` | — | to the removed participant |
| S→C | `MuteRequested` | `fromId`, `seq`, `sig` | to the participant asked |
| S→C | `CallEnded` | `issuer`, `sig` | to the room and the lobby |

Values: `source` ∈ `microphone` / `camera` / `screen`; `kind` ∈ `audio` / `video` (follows from the source); SDP ≤ 32 KB
and starts with `v=0`; `mid` matches `^[A-Za-z0-9_-]{1,16}$`. Media events go to the **other** participants in the room;
the caller already knows its own state. The media session is created on the first `PublishTracks` / `SubscribeTracks`.

### Lobby and admission

Design: `docs/plans/2026-10-08-lobby-admission-design.md`. Rooms belong to a **host key**: the room id is
`base32(SHA-256(fields("cipheroom/room/v1", hostEd25519Pub, hostX25519Pub)))`, first 26 characters. Every decision is
an Ed25519 signature over `fields(label, roomId, …)` (`encoding.ts` / `AdmissionMessages`; shared test vectors in
`tests/fixtures/admission-vectors.json`). The api verifies each one before acting; **clients verify everything
again** and only exchange keys with admitted participants.

| Statement | Signed by | Message |
|---|---|---|
| host attestation | host key | `fields("cipheroom/host/v1", roomId, identityEd25519Pub)` |
| ticket | host or co-host identity | `fields("cipheroom/ticket/v1", roomId, issuer, subject)` |
| co-host grant | host identity | `fields("cipheroom/cohost/v1", roomId, issuer, subject)` |
| removal | host (anyone else) or co-host (guests only) | `fields("cipheroom/revoke/v1", roomId, issuer, subject)` |
| settings | host identity | `fields("cipheroom/settings/v1", roomId, issuer, seq, autoAdmit ? 1 : 0)` |
| end call | host or co-host | `fields("cipheroom/end/v1", roomId, issuer)` |
| ask to mute | host or co-host | `fields("cipheroom/mute/v1", roomId, issuer, subject, seq)` |

Public keys in messages are the raw 32 bytes; numbers are uint32 big-endian; on the wire everything is unpadded
base64url (keys 32 B, signatures 64 B).

- `JoinLobby`: `HostProofDto { hostEd25519Pub, hostX25519Pub, attestation }` → admitted as host when the keys derive
  `roomId` and `attestation` verifies over the caller's identity (else `Invalid host proof.`). `TicketDto { issuer,
  sig }` → admitted straight back (same identity, e.g. a reconnect) when its issuer was a host or co-host of this
  room and the identity wasn't removed; a ticket that doesn't check out just means waiting in the lobby. Otherwise
  the caller **waits**: `admitted: false`, no participants, and `Not admitted.` from every member method.
- `LobbyResult { selfId, admitted, participants[], authority: AuthorityDto, ticket: TicketDto | null }` — `ticket` is
  the one that admitted us (kept by the browser for rejoining).
- `AuthorityDto { hostEd25519Pub, hostX25519Pub, hosts[{ identity, sig }], coHosts[StatementDto], revoked[StatementDto],
  settings: SettingsDto | null, admitters[{ id, identity }] }`, `StatementDto { subject, issuer, sig }`,
  `SettingsDto { issuer, seq, autoAdmit, sig }`. Sent with `JoinLobby` / `Admitted` and as `AuthorityUpdated`
  whenever it or the admitters online change. Lobby guests get it too (they need the admitters to knock).
- Knocks: the guest's display name encrypted to one admitter's X25519 identity and signed by the guest
  (`knock.ts`) — the server never sees names. Sent again to admitters who arrive later.
- `Deny`: the guest leaves the lobby; that connection can ask again after 30 s (`Already asked, try again later.`).
  The lobby holds 20 at most (`Lobby is full.`).
- `RemoveParticipant`: the target is dropped from the room (and what their media session receives is closed), gets
  `Removed`, and their identity can't come back to this room. Others get `AuthorityUpdated` (with the revocation),
  then `ParticipantLeft`, and rotate.
- `EndCall`: everyone in the room and the lobby gets `CallEnded`, then the room is gone.
- `AskToMute`: advisory — the target's browser verifies it (`seq` higher than the last from that issuer) and mutes.

### End-to-end keys

Design: `docs/plans/2026-10-07-e2ee-media-design.md`. The api relays public keys and opaque envelopes only; it never
verifies, stores or logs them (clients verify everything — the server is untrusted).

- `IdentityDto { ed25519Pub, x25519Pub, sig }`: unpadded base64url of 32, 32 and 64 bytes — the participant's
  per-call public keys, self-signed by their browser over the room id. Sent with `JoinLobby`, stored on the
  participant, included in every `ParticipantDto`. The server checks the shape only.
- `SendKeyEnvelopes`: one call per key rotation, one envelope per other participant. `blob` is the signed, encrypted
  envelope (v2: sender key and the sender's padded display name, ~1,000 chars); only `toId` is visible to the server.
  Recipients check that the envelope's signed `fromId` matches the relayed `fromId`.
- Clients that call `JoinLobby` without all its arguments fail SignalR's argument binding and never join (so do
  clients still calling the removed `JoinRoom`); `null` or a malformed identity gets `Invalid identity.`

### Video codecs

Designs: `docs/plans/2026-10-08-video-compression-design.md`, `docs/plans/2026-10-08-remove-av1-design.md`.

- `videoCodecs`: what the participant's browser can **decode**, among `vp8`, `vp9`; 1–2 distinct values, `vp8`
  required (the baseline everyone decodes). Sent with `JoinRoom`, stored on the participant, included in every
  `ParticipantDto` in canonical order (`vp8`, `vp9`). The server checks the values only; `av1` (removed) is invalid.
- Each sender picks its codec from these when it joins (its choice if everyone can decode it, else VP8).
  Cloudflare doesn't forward a codec change on a published track, so a sender that needs another codec (it changed
  its choice, or someone joined who can't decode it) leaves and joins again (with its ticket: no new knock).
- Unsigned on purpose: a server that edits them can only make senders use a bigger codec, or send a viewer video it
  can't play — never read anything (frames are end-to-end encrypted whatever the codec).
- `null` or a malformed list gets `Invalid video codecs.`

### Call-quality reports

Design: `docs/plans/2026-10-07-observability-design.md`. Every 15 s each browser in a call sends what changed since
its last report, computed from `getStats()` per stream and from `CryptoService`'s counters:

```
CallStatsDto { platform, path, intervalSeconds, rttMs?,
               audioSent?, audioReceived?, videoSent?, videoReceived?,   // StreamStatsDto
               e2ee? }                                                    // E2eeStatsDto
StreamStatsDto { bytes, packets, packetsLost, jitterMs?, freezeSeconds?, height?, fps? }
E2eeStatsDto   { framesEncrypted, framesDecrypted, framesFailed, framesMissingKey, envelopesDropped, securingSeconds }
```

- `platform`: `ios-safari` / `android-chrome` / `desktop-chrome` / `desktop-safari` / `desktop-firefox` / `other`
  (never the user agent); unknown values are recorded as `other`. `path`: `direct` / `relay` / `unknown`.
- Numbers only: no ids, names, addresses, codecs or track details. Every number must be finite, non-negative and under
  a cap (`CallStatsRules`); `intervalSeconds` is 0–120.
- Members only, no reply, nothing is broadcast or stored: the api records it as `cipheroom_call_*` /
  `cipheroom_e2ee_*` metrics (labels: platform, path, kind, direction). Accepted even when telemetry export is off.

### Errors

Failures arrive as a `HubException`; the client sees `…HubException: <message>`. Messages are constant text and never
echo input. Mapped centrally by `HubExceptionFilter`; pinned by `Cipheroom.Api.FunctionalTests`.

| Message | When |
|---|---|
| `Invalid room id.` | `JoinLobby` with a room id not matching `^[a-z2-7]{26}$` (incl. old `xxxx-xxxx-xxxx` links) |
| `Invalid identity.` | `JoinLobby` with a missing or malformed identity (checked after the room id) |
| `Invalid video codecs.` | `JoinLobby` with missing or malformed `videoCodecs` (checked after the identity) |
| `Invalid host proof.` | `JoinLobby` with a malformed host proof, keys that don't derive the room id, or an attestation that doesn't verify |
| `Invalid signature.` | A malformed ticket in `JoinLobby`; any statement (`Admit`, `GrantCoHost`, `RemoveParticipant`, `UpdateSettings`, `AskToMute`, `EndCall`) whose signature doesn't verify |
| `Invalid participant.` | A malformed `guestId` / `participantId` |
| `Unknown participant.` | No such guest in the lobby / member in the room |
| `Invalid settings.` | `UpdateSettings` with `seq` outside 1–2³²−1 |
| `Invalid knock.` | `Knock` with no / over 16 knocks, a malformed or over-long blob, a duplicate `toId`, or a `toId` that isn't an admitter in the call |
| `Not admitted.` | A lobby guest calling `GetRtcConfig`, a media method, `SendKeyEnvelopes`, `ReportCallStats` or a host control |
| `Not allowed.` | A host control by someone without the role (co-host removing a host or co-host, guest admitting, non-host settings or grants), a stale settings `seq`, `Knock` from a member, or a removed identity trying to come back |
| `Lobby is full.` | `JoinLobby` when 20 people already wait |
| `Already asked, try again later.` | `JoinLobby` within 30 s of being denied, on the same connection |
| `Invalid key envelope.` | `SendKeyEnvelopes` with no / over 64 envelopes, a malformed or over-long blob, a duplicate `toId`, or a `toId` that isn't another participant of the caller's room |
| `Already in a room.` | `JoinLobby` on a connection that is already in a room or lobby |
| `Join a room first.` | `GetRtcConfig`, any media method, `SendKeyEnvelopes` or `ReportCallStats` before joining |
| `Invalid stats.` | `ReportCallStats` with a missing report, a bad platform/path string, an interval outside 0–120 s, or a number that's negative, not finite or over its cap |
| `Invalid session description.` | SDP missing, over 32 KB or not starting with `v=0` |
| `Invalid track.` | Bad track list, mid, source or participant id |
| `Invalid layer.` | `SelectVideoLayer` with a layer other than `f` / `h` / `q` |
| `Track already published.` | `PublishTracks` for a source that is already published (or listed twice) |
| `Unknown track.` | Track not published in the caller's room (incl. own tracks), mute of an unpublished source, layer for a non-camera track |
| `No media session.` | `Renegotiate` / `RestartIce` before publishing or subscribing |
| `Media server unavailable.` | Cloudflare refused or failed the request (cause logged as status / error code only) |
| `Too many requests.` | More than 20 calls in a burst / 5 per second on one connection (`RateLimiting:Hub`) |
| `Something went wrong.` | Any unexpected server error (details only in the server log) |

## Planned

| Direction | Method | Args | Notes |
|---|---|---|---|
| C→S | `SendChat` | `ciphertext, keyIndex` | broadcast to room |
| S→C | `ChatReceived` | `fromId, ciphertext, keyIndex` | |
| S→C | `QuotaWarning` | `usedGb, limitGb` | admins |

_Draft — update as the hub is implemented._
