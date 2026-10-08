# Lobby and host admission — design
Status: approved · Date: 2026-10-08

## Problem

`JoinRoom` is open: anyone with a room link is in the call at once, opens an SFU session (spends free-tier quota) and
receives media keys from every member. Display names reach the api in plaintext. There's no host, so nobody can keep
people out, remove them or end a call — and anything the server decided alone would contradict the untrusted-server
model.

## Goals / Non-goals

Goals
- **Host = a key, not a server record.** "New meeting" creates a host key in the creator's browser; the room id is a
  hash of its public keys, so nobody (server, man in the middle) can claim to be host without the private key.
- Host key stored non-extractable in the browser, plus a one-time **passphrase-protected backup file** to move it to
  another device.
- **Lobby:** guests knock and wait; the host or a **co-host** (host-signed) admits or denies.
- **Admission enforced cryptographically:** members only exchange media keys with participants holding a valid
  host/co-host-signed ticket. A participant injected by the server gets no keys. The api verifies the same signatures
  as defence in depth (quota, metadata).
- Host controls: **remove** (signed revocation + key rotation), **auto-admit** toggle (still ticket-based), **ask to
  mute** (advisory), **end call for everyone**.
- **No personal data on the server:** display names only travel encrypted end to end (knock → admitters, in-call →
  key envelopes), padded so their length leaks nothing.

Non-goals
- Persistent identities / TOFU of guests (identities stay fresh per call), accounts, scheduled meetings.
- Hiding metadata the transport exposes: IP addresses, timing, head counts, which random id is host.
- Protection against a server that serves malicious JavaScript (inherent to web-app E2EE; documented).
- Encrypted chat, usage guard (separate roadmap items).
- Human-readable room names (ids are now derived from the host key).

## Constraints check

| Constraint | This feature |
|---|---|
| E2EE invariant | Strengthened. Keys only go to ticketed participants; names become ciphertext. The host private key never leaves the browser except as a passphrase-wrapped backup the user downloads. |
| $0 running cost | No new services. Lobby guests can't open SFU sessions, so a leaked link no longer burns quota. |
| No public IP | Unchanged; everything is SignalR over the tunnel. |
| Open source | Server-side Ed25519 verification needs an OSS library: **NSec** (MIT, libsodium) — .NET has no built-in Ed25519. Only new dependency. |
| Untrusted server | Admission and controls can't be forged. The server **can** drop or delay messages (hide a knock, hide a `Remove` from some members), sees IPs, timing, lobby size and host/co-host ids, and serves the JS bundle. Documented. |
| Browser support | Same as today (Ed25519/X25519, encoded transforms) plus IndexedDB `CryptoKey` storage (Chrome, Firefox, Safari incl. iOS). Without it a browser can't host but can join as a guest. |
| Signaling | Breaking: `JoinRoom` replaced by `JoinLobby` + admission/control methods; `displayName` leaves the protocol; old `xxxx-xxxx-xxxx` links stop working. |

## Chosen approach

**Cryptographic admission, enforced twice, in one PR.** Signed statements chain every participant back to the host
key that the room id commits to. Clients enforce (they gate key envelopes on a valid chain — the real protection); the
api verifies the same signatures before granting membership, media access or the participant list.

- Why not server-trusted admission (classic Zoom lobby): the server alone would decide who gets in, contradicting the
  untrusted-server model.
- Why not client-only enforcement (server routes blindly): avoids NSec, but lobby guests could open SFU sessions and
  see the room's participants and media events.
- Why not a host link with the secret in the URL fragment: anyone who sees the link becomes host.
- Why not "first in room is host": whoever opens the link first takes the room.

## Design

### 1. User flow

Home page
- **New meeting** → generates the host key → **"Back up your host key"** dialog: passphrase (≥ 12 chars, strength
  meter), downloads `cipheroom-host-<id>.key`. Skippable with a warning that this is the only chance. Lands in the
  meeting as host.
- **Your meetings**: meetings whose host key is in this browser — Open / Copy link / Delete key.
- **Import host key**: backup file + passphrase → appears under "Your meetings".
- **Join**: paste a link. Room ids are 26 chars derived from the host key (`/r/k3fq…`).

Guest
- Link → pre-join (name, camera/mic preview) → **Ask to join** → lobby screen "Waiting for the host to let you in…"
  (or "The host isn't here yet" when no admitter is online), Cancel.
- Admitted → call. Denied → "The host didn't let you in", **Ask again** after a cooldown. Removed → "You were removed
  from the call". Ended → "The host ended the call".

Host / co-host in the call
- Knock → toast + **Lobby** section at the top of the participants panel: name, **Admit / Deny**, **Admit all**.
- Participant menu: **Make co-host** (host only), **Remove**, **Ask to mute**.
- Header menu: **Auto-admit** toggle, **End call for everyone** (confirm).
- Muted participant sees "The host muted you"; the mic turns off and they may turn it back on (advisory).
- Remove / end → the usual rotation and "Safety code changed" toast.

Unchanged: safety code, "Securing…", encrypted badge. The host's browser joins without knocking. A reconnect in the
same tab reuses the per-call identity and ticket (no re-knock); a page reload knocks again (unless host or auto-admit).

### 2. Components and boundaries

Frontend (`web/src/app/core/crypto/` holds all crypto):

| File | Owns |
|---|---|
| `host-key.ts` | create host Ed25519 + X25519 key pair, derive `roomId`, IndexedDB store (non-extractable), list/delete |
| `host-key-backup.ts` | export (once, at creation) / import: PBKDF2 → AES-GCM wrap of PKCS#8 keys |
| `statements.ts` | sign/verify every authority statement, chain verification back to `roomId`, reject reasons |
| `knock.ts` | seal/open the encrypted name for an admitter (same construction as envelopes) |
| `envelopes.ts` | envelope **v2**: payload = sender key + padded display name |
| `crypto.service.ts` | authority state (host, co-hosts, tickets, revocations, settings), key gating, rotation on remove, auto-admit signing, `names` signal |

- New `core/lobby/` `LobbyService`: lobby state machine (waiting / admitted / denied / removed / ended), knocks,
  admitter list; calls `CryptoService` to sign/verify and `SignalingService` to send. Components read signals only.
- `features/home`: New meeting, backup dialog, Your meetings, Import, Join-by-link. `features/room`: lobby screen,
  lobby section + participant menu in the participants panel, host menu in the header.
- `SignalingService` carries statements and knocks as opaque data.

Backend
- Domain `Room`: host public keys (learned from the first valid host proof), lobby (≤ 20), members with their
  authority chain, co-hosts, revoked identities, settings `seq`; permission rules (co-host can't remove the host or a
  co-host; revoked identities can't act; only members can do media/envelopes).
- Application: one command per hub method; FluentValidation for shapes; port `ISignatureVerifier`
  (`Verify(publicKey, message, signature)`) and the shared `fields(...)` encoding in C# (byte-identical to
  `encoding.ts`, pinned by fixtures).
- Infrastructure: `NSecSignatureVerifier`.
- Api: hub methods (thin), `IRoomClient` events; errors via `HubExceptionFilter`.

### 3. Keys and signed statements

Host key
- Ed25519 (`hostEd`) + X25519 (`hostX`), non-extractable, IndexedDB, keyed by `roomId`.
- `roomId = base32lower(SHA-256(fields("cipheroom/room/v1", hostEdPub, hostXPub)))[0..26]` (130 bits; matches the
  existing `^[a-z0-9-]{3,64}$` rule). Anyone recomputes it from the public keys.
- Backup file (JSON): `{ v: 1, roomId, hostEdPub, hostXPub, kdf: "PBKDF2-SHA256", iterations: 600000, salt (16 B),
  iv (12 B), ct }`, `ct = AES-GCM(PBKDF2(passphrase, salt), aad = fields("cipheroom/host-backup/v1", roomId,
  hostEdPub, hostXPub), pkcs8(edPriv) ‖ pkcs8(xPriv))`. At creation the keys are generated extractable, wrapped once
  if the user backs up, re-imported non-extractable for storage; the extractable handles are dropped. Import re-checks
  that the public keys derive `roomId` and that the private keys match them.

Authority statements — each an Ed25519 signature over `fields(label, roomId, …)` (same domain-separation rules as
the E2EE envelopes); identities are the existing per-call `IdentityDto`s:

| Statement | Signed by | Fields after `roomId` |
|---|---|---|
| `cipheroom/host/v1` attestation | host key | host's per-call `ed25519Pub` |
| `cipheroom/cohost/v1` grant | host identity | issuer pub, grantee pub |
| `cipheroom/ticket/v1` admission | host or co-host identity | issuer pub, guest pub |
| `cipheroom/revoke/v1` removal | host identity, or co-host identity (target not host/co-host) | issuer pub, target pub |
| `cipheroom/settings/v1` | host identity | issuer pub, `seq` (uint32, increasing), `autoAdmit` |
| `cipheroom/end/v1` | host or co-host identity | issuer pub |
| `cipheroom/mute/v1` | host or co-host identity | issuer pub, target pub, `seq` |

- Chain: ticket/grant → issuer identity → (grant →) host identity → attestation → host key → `roomId`. Every client
  verifies every member's chain itself; the server's word counts for nothing.
- Everything names per-call identities (fresh per call), so statements can't be replayed into a later call. `seq`
  stops replays of settings/mute within a call. A revoked identity's own statements stop counting from then on.
- Auto-admit: admitters' browsers sign a ticket for each knock automatically while the latest `settings` says on —
  admission stays cryptographic; with no admitter online, guests wait.

Key gating (`CryptoService`)
- Send and accept sender-key envelopes **only** for participants with a valid, unrevoked chain. Others show as
  "Unverified" (orange), get no keys, their frames are dropped, the safety code warns as today.
- On `ParticipantRemoved` (valid revocation): drop the target's keys, rotate excluding them.

Names
- Knock: guest verifies each admitter's chain, then seals its name to the admitter's X25519 identity:
  `k = HKDF(X25519(eph, admitterX), salt = roomId, info = "cipheroom/knock/v1")`, AES-GCM with
  `aad = fields("cipheroom/knock-header/v1", roomId, fromPub, toPub)`, signed by the guest identity.
- In call: key envelope **v2** — encrypted payload = 32-byte sender key ‖ name; v1 rejected.
- Names are UTF-8, padded to 256 bytes (64 chars max as today). Blob limit for envelopes and knocks: 2 KB.
- Safety code unchanged (it covers `roomId`, hence the host key).

### 4. Data and state

- Browser: host keys in IndexedDB (until deleted); per-call identity, ticket and authority state in memory for the
  tab's call (reused on reconnect).
- api: in memory, as today — host pubs per room, lobby, members' chains, co-hosts, revoked set, settings `seq`. Gone
  on restart: the host rejoins and re-establishes the room; guests knock again. Rooms are still deleted when empty
  (and the lobby with them).

### 5. Failure modes

| Case | Behaviour |
|---|---|
| Host key lost (site data cleared) | Not in "Your meetings"; the link makes you a guest. Import the backup or create a new meeting. |
| Wrong passphrase / corrupted backup | "Couldn't unlock this backup" (AES-GCM auth fails); nothing imported. |
| No admitter online | Guest waits ("The host isn't here yet"); `AdmittersChanged` re-sends the knock when one arrives. |
| Server drops a knock / admit | Guest keeps waiting; can cancel or knock again. Blockable, not forgeable. |
| Server hides `Remove` from some members | They keep sending keys to the removed person until the next rotation (known limit, like hidden leaves). |
| Participant with a bad chain | "Unverified", no keys, frames dropped, safety code orange. |
| Admitter disconnects mid-knock | Knock goes to remaining admitters; none left → guest back to waiting. |
| Reconnect (same tab) | `JoinLobby` with the same identity + ticket → straight back in; host with its host proof. |
| api restart | Rooms vanish; host rejoins, guests knock again. |
| No IndexedDB `CryptoKey` support | "This browser can't host meetings"; joining as a guest works. |
| Lobby full (20) | `Lobby is full.` |

## Protocol changes

Client → Server

| Method | Args | Returns / effect |
|---|---|---|
| `JoinLobby` | `roomId`, `identity`, `videoCodecs`, `hostProof? { hostEdPub, hostXPub, attestation }` | `LobbyResult { state: admitted \| waiting, selfId, admitters[], participants[]? }`; valid `hostProof` (hash matches `roomId`, attestation verifies over the caller's identity) → admitted as host; a reconnecting member may pass `ticket?` / `grant?` to skip the lobby |
| `Knock` | `knocks[{ toId, blob }]` (to current admitters) | each relayed to its admitter only |
| `Admit` | `guestId`, `ticket` | verified → guest `Admitted`, others `ParticipantJoined` |
| `Deny` | `guestId` | guest `Denied`; knock cooldown |
| `GrantCoHost` | `participantId`, `grant` | broadcast `CoHostGranted`; lobby gets `AdmittersChanged` |
| `RemoveParticipant` | `participantId`, `revocation` | broadcast `ParticipantRemoved`; target's tracks closed, target dropped |
| `UpdateSettings` | `settings` | broadcast `SettingsChanged` |
| `AskToMute` | `participantId`, `mute` | target gets `MuteRequested` |
| `EndCall` | `end` | everyone (room + lobby) gets `CallEnded`; room deleted |
| `LeaveRoom` | — | also leaves the lobby |
| `JoinRoom` | — | **removed** |

Server → Client: `KnockReceived(fromId, identity, blob)`, `Admitted(JoinResult)`, `Denied`,
`AdmittersChanged(admitters[])`, `CoHostGranted(participantId, grant)`, `ParticipantRemoved(participantId,
revocation)`, `SettingsChanged(settings)`, `MuteRequested(fromId, mute)`, `CallEnded(end)`.

DTOs: `ParticipantDto` drops `displayName`, gains `authority { attestation? | grant? , ticket? }`; admitters are
`ParticipantDto`s. Signatures/keys unpadded base64url, fixed lengths validated.

Lobby guests get `Not admitted.` from `GetRtcConfig`, every media method, `SendKeyEnvelopes`, `ReportCallStats`,
and receive no participant or media events.

New errors: `Not admitted.`, `Not allowed.`, `Invalid signature.`, `Invalid host proof.`, `Lobby is full.`,
`Already asked, try again later.` Removed: `Display name must be 1-64 characters.` (names are client-side only).

Updated in the same change: `IRoomClient` + hub, `signaling.types.ts` + `SignalingService`,
`docs/signaling-protocol.md` (the "Planned" lobby rows become implemented).

## Security notes

- Threats covered: server injecting a participant (no ticket → no keys), server impersonating the host (room id
  commits to the host key), forged admit/remove/end/mute (signatures), replay into another call (per-call identities),
  replay within a call (`seq`), name disclosure to server (encrypted + padded), quota abuse from lobby (no SFU access
  before admission), host key theft from links/history (non-extractable; backup passphrase-wrapped).
- Not covered (documented): dropped/delayed messages, hidden removals until next rotation, IP/timing/head-count and
  host-id metadata, a server serving malicious JS, offline guessing of a weak backup passphrase (≥ 12 chars + 600k
  PBKDF2 iterations; WebCrypto has no Argon2).
- Never logged or sent to telemetry: statements, knocks, keys, names. Logs keep request type and ids only.
  Observability: counters `admitted` / `denied` / `removed` / `ended` (no ids, no labels beyond outcome).
- `e2ee-media` checklist: domain-separated labels for every new signature; `fields(...)` byte-identical in C# and TS;
  reject before use; zero raw key buffers after wrapping; non-extractable at rest; no fallback to unencrypted.

## Testing

- Domain/Application unit tests: permission rules (co-host can't remove host/co-host, revoked can't act, `seq`
  monotonic), lobby cap, knock cooldown, validators for every new DTO.
- Infrastructure: `NSecSignatureVerifier` and C# `fields(...)` against WebCrypto-generated vectors committed as
  fixtures.
- Api functional tests: host join (valid / wrong hash / bad attestation), knock → admit → `ParticipantJoined`, forged
  ticket, non-admitter `Admit`, lobby guest calling media/envelope methods, remove closes tracks, end empties room,
  every error message pinned.
- Frontend specs: host-key store, backup round-trip + wrong passphrase + tampered file, each statement sign/verify +
  reject cases (wrong room, wrong issuer, revoked issuer, stale `seq`), chain verification, key gating, envelope v2,
  knock seal/open, name padding, `LobbyService` state machine, lobby/home/host-menu components.
- Manual on the home stack (`scripts/up.sh --tunnel`): desktop host + iPhone guest; admit/deny; remove (removed
  person's video freezes → "Securing…"); co-host admits while host away; auto-admit; ask to mute; end for all; backup
  import in a second browser.

## Open questions

- Knock cooldown after `Deny` (proposed 30 s) and lobby cap (proposed 20) — tune during manual testing.
- NSec ships native libsodium: confirm it runs on the chiseled api image (linux-x64/arm64); fallback is BouncyCastle
  (MIT, managed).

## Implementation steps

1. Shared `fields(...)` encoding in C# + cross-language fixtures (TS-generated vectors, C# tests).
2. Backend: `ISignatureVerifier` port + NSec adapter (+ Docker image check), Domain authority/lobby model and rules,
   unit tests.
3. Backend: `JoinLobby` (host proof, reconnect with ticket), `Knock`, `Admit`, `Deny`; remove `JoinRoom` and
   `displayName`; `Not admitted.` gating; functional tests.
4. Backend: `GrantCoHost`, `RemoveParticipant` (closes tracks), `UpdateSettings`, `AskToMute`, `EndCall`; functional
   tests; counters.
5. Frontend crypto: `host-key.ts`, `host-key-backup.ts`, `statements.ts`, `knock.ts`, envelope v2 with names; specs.
6. Frontend: `CryptoService` authority state + key gating + rotation on remove; `SignalingService` + types;
   `LobbyService`.
7. Frontend UI: home (New meeting, backup dialog, Your meetings, Import, Join by link), lobby screen.
8. Frontend UI: participants-panel lobby section + participant menu, header host menu, mute notice, removed/ended
   screens.
9. Docs: `signaling-protocol.md`, `architecture.md` (admission model, metadata, limits), README (feature, roadmap),
   `e2ee-media` + `signaling-protocol` skills; manual test on the home stack.
