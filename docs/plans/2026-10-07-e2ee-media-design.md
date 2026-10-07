# End-to-end encrypted media — design
Status: approved · Date: 2026-10-07

## Problem

Since the move to Cloudflare Realtime SFU, calls rely on DTLS-SRTP only: Cloudflare's SFU decrypts every media
packet and could see and hear every call. That breaks the product's core invariant — no server can see or hear call
content. LiveKit's E2EE worker is gone with LiveKit, so frame encryption and key management are now ours.

## Goals / Non-goals

Goals
- Every call is end-to-end encrypted, always: audio, camera and screen share, incl. placeholder and replaced tracks.
- Per-call identities (Ed25519 + X25519), per-sender keys delivered in signed envelopes over SignalR.
- Key rotation on every join (newcomers can't read earlier media) and leave (leavers can't read later media).
- A safety code everyone in the call can compare out loud to detect a server-injected participant or split view.
- Never plaintext: unsupported browser or failed crypto setup → can't join.

Non-goals (this milestone)
- Lobby / host admission (`JoinLobby`, `Admit`, `Deny`).
- Encrypted chat (will reuse sender keys with label `cipheroom/chat/v1`).
- Persistent device identities and TOFU pinning — identities are fresh per call (decided: calls can't be linked by
  key, nothing stored in the browser).
- P-256 fallback — dropped; all target browsers support Ed25519/X25519 in WebCrypto.
- Verify-to-unlock safety code, key-request messages, MLS.

## Constraints check

| Constraint | Answer |
|---|---|
| E2EE invariant | ✅ This milestone restores it. api relays public keys + opaque signed envelopes only; Cloudflare sees ciphertext frames with the VP8 payload header (3/10 B) and RTP headers in the clear. |
| $0 | ✅ 25 B per frame overhead (~10 kbit/s on audio, negligible on video); envelopes are tiny SignalR messages. |
| No public IP | ✅ Unchanged. |
| Open source / self-hostable | ✅ WebCrypto only, no new dependencies. |
| Untrusted server | A server can inject a ghost participant or show different people different participant sets → visible in the participant list and caught by the safety code. It can drop envelopes or hide a leave → DoS / leaver keeps receiving keys, visible as "who's in the call". It cannot decrypt. Metadata stays visible: who, when, IPs, bandwidth, track sources, frame sizes/timing, the RTP audio-level header extension. |
| Browser support | Needs encoded transforms (`RTCRtpScriptTransform`; `createEncodedStreams` fallback on Chrome) and WebCrypto Ed25519/X25519: current Chrome, Safari 17+ (incl. iOS), Firefox 130+. Others are refused before joining. |
| Signaling | `identity` on `JoinRoom` / `ParticipantDto`; new `SendKeyEnvelopes` (C→S) and `KeyEnvelopeReceived` (S→C). Follows the `signaling-protocol` skill. |

## Chosen approach

The sender-key design from `docs/architecture.md` → "Encryption model": per-sender random keys, delivered pairwise in
envelopes (ephemeral X25519 → HKDF → AES-GCM, Ed25519-signed), one frame-crypto worker with a keyring per
`(participantId, keyIndex)`, transforms attached by `MediaService` to every sender and receiver.

- Why not a single room key distributed by a leader: needs leader election; every leave forces redistribution.
- Why not MLS (RFC 9420): large dependency, overkill for small rooms; remains the "later" option behind `CryptoService`.

**De-risk first:** Cloudflare must keep detecting keyframes and switching simulcast layers on encrypted VP8. Step 1 is
a spike with a fixed test key; if it fails we stop and rethink before building key management.

## Design

### 1. User flow

- Lobby: unchanged. If the browser lacks encoded transforms or Ed25519/X25519 → "This browser can't join encrypted
  calls", no Join button.
- In call: a lock/shield button in the call bar opens the **safety code** (e.g. `🐙 🌵 🚲 🍋 · 4821 9037`) with
  "Compare this with everyone in the call". Visible, non-blocking.
- Someone joins/leaves → toast "Safety code changed".
- A remote tile whose keys haven't arrived shows "Securing…"; its frames are dropped (silent audio) until the key
  arrives.

### 2. Components and boundaries

All crypto in `web/src/app/core/crypto/`:

| File | Owns |
|---|---|
| `identity.ts` | per-call Ed25519 + X25519 key pairs (non-extractable, memory only), self-signed public bundle |
| `envelopes.ts` | seal/open sender-key envelopes: ECDH → HKDF → AES-GCM, sign/verify, all reject rules |
| `safety-code.ts` | code from all participants' Ed25519 public keys + roomId |
| `frame-crypto.worker.ts` | keyring per `(participantId, keyIndex)`; per-source media keys; frame encrypt/decrypt |
| `frame-transforms.ts` | attaches the worker to an `RTCRtpSender`/`RTCRtpReceiver` (`RTCRtpScriptTransform`, else `createEncodedStreams` streams transferred to the same worker) |
| `crypto.service.ts` | orchestration: identity, own sender key, rotation, envelope send/receive, `safetyCode` and per-participant "has keys" signals |

- Components read `CryptoService` signals only.
- `MediaService` calls `frame-transforms` on `addTransceiver` and `ontrack`; it never touches keys. The transform
  sits on the sender, not the track, so `replaceTrack` (camera flip, placeholders) stays covered.
- `SignalingService` carries bundles and envelopes as opaque data.
- Backend is a relay: validates shape and room membership, forwards each envelope to its recipient only, never parses
  crypto.

### 3. Identity bundle

```
IdentityDto { ed25519Pub (32 B), x25519Pub (32 B), sig (64 B) }      // base64url
sig = Ed25519 over fields("cipheroom/id/v1", roomId, ed25519Pub, x25519Pub)
```

`fields(…)` (`encoding.ts`) is the encoding of everything signed, used as AAD or hashed: each field as a 4-byte
big-endian length + bytes (strings UTF-8, numbers uint32 big-endian). Every use has a fixed field order and starts
with its own label (domain separation — the identity key signs both bundles and envelopes). It replaces "canonical
JSON", which has no single agreed canonical form.

Binds the X25519 key to the Ed25519 key (which the safety code covers); including `roomId` stops replay into another
room. Created at Join, kept in memory for the page's call; reused on a full rejoin so the safety code stays stable.

### 4. Sender keys and envelopes

- Sender key: 32 random bytes (`crypto.getRandomValues`), `epoch` (uint32, +1 per rotation, starts at 0),
  `keyIndex = epoch mod 16`. Raw bytes live only long enough to seal envelopes and hand to the worker, then the
  buffer is zeroed; the worker imports it as a non-extractable HKDF key.
- Envelope v1 (the opaque `blob`):

```
header = { v: 1, roomId, epoch, keyIndex, fromId, toId }        keyIndex = epoch mod 16, epoch uint32
k    = HKDF-SHA-256(X25519(ephemeral, recipientX25519), salt = roomId, info = "cipheroom/env/v1")
aad  = fields("cipheroom/env-header/v1", roomId, epoch, keyIndex, fromId, toId)
ct   = AES-GCM(k, iv = random 12 B, aad, senderKey)
sig  = Ed25519(senderIdentity, fields("cipheroom/env-sig/v1", aad, ephPub, iv, ct))
blob = base64url(JSON { v, roomId, epoch, keyIndex, fromId, toId, eph, iv, ct, sig })   ≈ 550 chars, ≤ 1 KB
```

- Receiver rejects (reason counted locally only, never sent anywhere), checking the signature first against the
  sender's identity as shown in the participant list: `malformed`, `bad-signature`, `wrong-room`, `wrong-sender`
  (inner ≠ outer `fromId`), `wrong-recipient` (`toId` ≠ self), `stale-epoch` (≤ last accepted from that sender),
  `undecryptable`.

### 4b. Safety code

`SHA-256(fields("cipheroom/safety/v1", roomId, count, ...sorted Ed25519 public keys))` → 4 emoji (6 bits each, from a
fixed list of 64 nameable emoji — order is part of the format) and 8 digits shown as `1234 5678`; ~50 bits.
Includes our own key; duplicates count.

### 5. Rotation

1. Join: identity → `JoinRoom` → own sender key (epoch 0) into the worker → publish → envelopes to everyone already
   there. Frames are encrypted from the first one; with no key the worker drops frames.
2. `ParticipantJoined`: every existing participant rotates and sends the new key to all current participants, incl.
   the newcomer; the newcomer sends its key to all. The newcomer never receives pre-join keys.
3. `ParticipantLeft`: every remaining participant rotates and sends to the remaining ones only.
4. Bursts debounced (~300 ms) into one rotation = one `SendKeyEnvelopes` call.
5. Switch-over: the sender starts using the new key 500 ms after the server accepts the envelopes. Receivers keep a
   sender's previous key for 10 s for in-flight frames. Unknown `keyIndex` → drop frame, tile shows "Securing…".

### 6. Frame format

- Media key: `HKDF(senderKey, salt = ∅, info = "cipheroom/media/v1")` → AES-GCM-256, non-extractable — one per
  sender key, shared by all of the sender's tracks (the worker-wide counter below keeps IVs unique across tracks, so
  receivers don't need to know a track's source).

```
[ clear header ][ AES-GCM ciphertext + 16 B tag ][ counter 8 B ][ keyIndex 1 B ]
IV  = 0x00000000 ‖ counter                        (12 B)
AAD = clear header ‖ counter ‖ keyIndex
```

- Clear header: VP8 10 B on keyframes, 3 B on delta frames (sender: `frame.type`; receiver: VP8 P-bit, lowest bit of
  byte 0); Opus 0 B. Empty frames pass through unchanged.
- Counter lives in the worker per media key (shared by all senders using it) and never resets while that key
  exists, so several tracks, stopping/restarting screen share, camera flips and placeholder swaps can't reuse an IV.
  Rotation brings a new key.
- Codec guard: anything other than VP8/Opus (`getMetadata().mimeType` when available, else the codec `MediaService`
  negotiated) → frames dropped and an error surfaced. Never pass-through.
- Receiver: decrypt/auth failure → drop and count; repeated failures with a known key → `sendKeyFrameRequest()`
  where supported.
- One shared worker for all transforms on both code paths (keeps counters correct).
- Every video transceiver (camera and screen) prefers VP8, so the clear-header rule always applies.

### 7. Data and state

- Browser: everything in memory, gone on leave/reload. Nothing in IndexedDB or localStorage.
- api: identity stored on the domain `Participant` (so `JoinResult` / `ParticipantJoined` can include it), dropped
  with the participant. Envelopes are never stored, only forwarded. Logs record request type only.

### 8. Failure modes

| Situation | Behavior |
|---|---|
| Missing encoded transforms / Ed25519 / X25519 | Feature check before Join → "This browser can't join encrypted calls". |
| Crypto setup fails mid-join (worker, key import) | Leave the room, show an error. Never publish. |
| Envelope never arrives | Tile stays "Securing…" until the next rotation. No key-request message in v1. |
| ICE restart | Unaffected (same transceivers, keys and counters). |
| Full rejoin fallback | Same identity, new participant id → normal join, everyone rotates. |
| Tampered / replayed envelope | Rejected, counted locally. |
| Old client without `identity` | `JoinRoom` fails with `Invalid identity.` — never joins unencrypted. |

## Protocol changes

| Direction | Method | Change |
|---|---|---|
| C→S | `JoinRoom` | `(roomId, displayName, identity: IdentityDto)` — identity **required** |
| S→C | `ParticipantDto` | gains `identity` (in `JoinResult.participants` and `ParticipantJoined`) |
| C→S | `SendKeyEnvelopes` | **new** — `envelopes[{ toId, blob }]`, 1–64, `blob` base64url ≤ 1 KB, distinct `toId`s; each relayed to `toId` only |
| S→C | `KeyEnvelopeReceived` | **new** — `(fromId, blob)`, `fromId` set by the server from the sender's connection |

New errors (constant text, never echo input): `Invalid identity.` (lengths / not base64url; the api doesn't verify
signatures — clients do), `Invalid key envelope.` (empty/over 64, blob too large, duplicate `toId`, `toId` not in the
caller's room or the caller itself). Existing `Join a room first.` and rate limiting (20 burst / 5 per s) apply; one
rotation is one call. C# (`IRoomClient`, hub, contracts), `signaling.types.ts` and `docs/signaling-protocol.md` change
together.

## Security notes

- Threats covered: Cloudflare SFU/TURN and the api reading media; server-injected ghost participant or split view
  (participant list + safety code); envelope tampering, misrouting and replay (signature, AAD, `toId`/`fromId` checks,
  monotonic epoch); newcomer reading earlier media / leaver reading later media (rotation).
- Not covered: a malicious server hiding a leave or dropping envelopes (DoS); metadata (who, when, IPs, track sources,
  frame sizes/timing, audio-level header extension); a compromised client or browser; users who never compare codes.
- `e2ee-media` checklist applies to every step: no key material in SignalR plaintext fields, HTTP, `console.*`,
  storage; `extractable: false` for private and media keys; no plaintext fallback; every envelope verified before
  use; safety code recomputed on every participant change; no SFU data channels; transform on every
  sender/receiver; WebCrypto only, no `Math.random`.

## Testing

- Backend functional: `JoinRoom` without / with invalid identity → `Invalid identity.`; identity relayed in
  `JoinResult` and `ParticipantJoined`; `SendKeyEnvelopes` reaches only `toId`; cross-room / self / duplicate `toId`
  → `Invalid key envelope.`; error texts pinned. Domain: identity kept on `Participant`. Validators: unit tests.
- Frontend unit: envelope round trip; tampered ct / sig / header → reject; wrong recipient → reject; replayed epoch →
  reject; frame round trip; VP8 header stays clear (key/delta lengths); tampered clear header → fail; non-VP8/Opus →
  dropped; rotation excludes the leaver, joiner gets only the new key; safety code order-independent and changes with
  the set; `MediaService` attaches the transform on every transceiver and every `ontrack`.
- Manual e2e on the home stack (`scripts/up.sh --tunnel`): Chrome + iPhone Safari + Firefox, three people;
  join/leave rotation, screen share, camera flip, mute/placeholders, quality switch, ICE restart, forced TURN. A
  dev-only "no decrypt" flag on one receiver must show garbage/nothing (proves the SFU carries ciphertext).

## Open questions

- Spike outcome: does Cloudflare keep keyframe detection and simulcast layer switching with encrypted VP8 payloads?
- Chrome: `RTCRtpScriptTransform` vs `createEncodedStreams` — confirm which current Chrome exposes and keep the
  fallback only if needed.
- Can we disable the `ssrc-audio-level` RTP header extension without breaking anything? (Active speaker uses
  receiver-side `audioLevel` stats, computed after decoding, so it should keep working.)
- Emoji set and digit grouping for the safety code (UI detail, decide in step 7).

## Implementation steps

On `feat/e2ee`, one commit each:

1. **Spike:** frame worker + transforms with a fixed test key behind a dev flag; manual check on Chrome, iOS Safari,
   Firefox through Cloudflare (playback, layer switch, new subscriber keyframe, ICE restart, placeholders).
2. **Frame format final:** keyring per `(participantId, keyIndex)` in the worker (receivers tagged with their
   participant), HKDF media keys, previous-key grace, keyframe request on repeated failures. (The frame layout,
   counter and codec guard landed with the spike, with unit tests.)
3. **Key primitives:** `identity.ts`, `envelopes.ts`, `safety-code.ts` + unit tests.
4. **Backend:** identity on `JoinRoom` / `Participant` / `ParticipantDto`, `SendKeyEnvelopes` / `KeyEnvelopeReceived`,
   validators, functional tests, `signaling.types.ts`, `docs/signaling-protocol.md`.
5. **`CryptoService`:** rotation (debounce, switch-over delay, previous-key grace), envelope send/receive, worker
   keyring sync.
6. **`MediaService` wiring:** transform on every sender/receiver, "Securing…" tile state, unsupported-browser gate,
   leave on crypto failure.
7. **Safety-code UI:** call-bar button, popover, "Safety code changed" toast.
8. **Docs and cleanup:** `architecture.md` "Encryption model" → implemented (fresh per-call identity, no P-256, TOFU
   later), README warning removed, `e2ee-media` skill updated to the final framing, dev fixed-key flag removed.
