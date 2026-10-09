---
name: e2ee-media
description: End-to-end encryption for Cipheroom — device identities (Ed25519/X25519), sender keys, signed key envelopes over SignalR, rotation on join/leave, our frame-encryption worker (encoded transforms), safety codes, and a security review checklist. Use whenever touching web/src/app/core/crypto, the frame transform, key envelopes, chat encryption, or anything that could leak key material.
---

# E2EE

Read `docs/architecture.md` → "Encryption model". Invariant: **no server (api, Cloudflare SFU, TURN) ever sees a plaintext
key, frame, or chat message.**

## Who does what
Design: `docs/plans/2026-10-07-e2ee-media-design.md`. Everything lives in `web/src/app/core/crypto/`:
- `crypto.service.ts` — **the boundary** (provided per room route): per-call identity, our sender keys and rotation,
  incoming envelopes and names, the worker's keyring, `safetyCode` / `secured` / `unverified` / `names` signals, and
  the room's verified `authority` (host proof, signing and verifying tickets, grants, removals, settings, mute and
  end; sealing/opening knocks). `start(roomId, selfId, name)` after admission returns the frame transforms for
  MediaService; `stop()` ends the session (identity kept for rejoin).
- `host-key.ts` / `host-key-store.ts` / `host-key-backup.ts` / `host-keys.service.ts` — meetings' host keys: room id
  derivation, non-extractable IndexedDB storage, the one-time PBKDF2 + AES-GCM backup file. Components only see room
  ids and the encrypted file (`HostKeysService`).
- `statements.ts` — admission statements (labels `cipheroom/{host,cohost,ticket,revoke,settings,end,mute}/v1`),
  `verifyAuthority`, `isAdmitted`. Byte-identical to the api's `AdmissionMessages`, pinned by
  `tests/fixtures/admission-vectors.json`.
- `knock.ts` — a lobby guest's name encrypted to one admitter; `names.ts` — name padding; `agreement.ts` — the
  X25519 → HKDF step shared by envelopes and knocks.
- `identity.ts` — per-call Ed25519 + X25519 (non-extractable, memory only), self-signed bundle, `verifyIdentity`.
- `envelopes.ts` — `sealEnvelope` / `openEnvelope` with typed rejections.
- `safety-code.ts` — 4 named emoji + 8 digits; `SAFETY_EMOJI` order is part of the format.
- `encoding.ts` — base64url and `fields(...)` (labelled, length-prefixed) for everything signed, AAD or hashed.
- `frame-codec.ts` (frame layout) · `keyring.ts` · `frame-cryptor.ts` (per-frame logic) · `frame-crypto.worker.ts`
  (thin wiring) · `frame-transforms.ts` (`FrameCrypto`: attaches the worker, transfers keys) · `support.ts`
  (`e2eeSupported`) · `e2ee-debug.ts` (`?e2ee=passthrough`).
- `chat-crypto.ts` — chat events: chat key = HKDF(sender key, `cipheroom/chat/v1`), Ed25519-signed by the author
  (`cipheroom/chat-sig/v1`), padded to 512 B / 2 / 8 / 16 KB, AES-GCM with AAD = room, relayed sender, key index
  (`cipheroom/chat-aad/v1`). `CryptoService` derives chat keys before a sender key goes to the worker (which detaches
  it), switches them with the media key, holds events that beat their key (10 s), drops replays by per-author
  `seq`. `core/chat/ChatService` holds chat state and never sees keys.

## Frame transform
- One worker for all transforms (both APIs), so counters are per key, not per track. Keys per sender: ours (send)
  and each remote participant's by `keyIndex` from the frame trailer; receivers are tagged with their participant
  and retagged if the SFU reuses them. Media key = `HKDF(senderKey, info="cipheroom/media/v1")`, non-extractable;
  one per sender key, shared by all of that sender's tracks.
- Layout v2 `[clear header][ciphertext + 16 B tag][counter 8 B][codec 1 B][keyIndex 1 B]`, IV = `0⁴ ‖ counter`,
  AAD = clear header ‖ trailer. Codec byte: 0 audio, 1 VP8, 2 VP9; **3 reserved** (was AV1, removed — never reuse
  it); the receiver reads it first and checks it against the receiver's kind and the frame's reported codec. VP8
  header stays clear (keyframe 10 B, delta 3 B — P bit of byte 0); VP9 and Opus none. Any other codec → dropped
  (each video transceiver negotiates only the call's codec). If H.264 or AV1 is ever needed, the worker must learn
  its structure first (AV1: Chrome's packetizer splits by OBU — see the video-compression design's spike notes).
- No key → drop (send and receive). Missing key arrives → keyframe request; 10 failures in a row → keyframe request.
- Unsupported browser (no encoded transforms / Ed25519 / X25519) → can't join; never fall back to plaintext.

## Envelope format (v2)
```
blob = base64url(JSON { v: 2, roomId, epoch, keyIndex, fromId, toId, eph, iv, ct, sig })   ~1,000 chars, ≤ 2 KB
k    = HKDF-SHA-256(X25519(eph, recipient x25519), salt = roomId, info = "cipheroom/env/v1")
aad  = fields("cipheroom/env-header/v1", roomId, epoch, keyIndex, fromId, toId)
ct   = AES-GCM(k, iv, aad, senderKey ‖ padded name)        (names.ts: 2-byte length + UTF-8, zero-padded to 258 B)
sig  = Ed25519(sender identity, fields("cipheroom/env-sig/v1", aad, eph, iv, ct))
```
- `keyIndex = epoch mod 16`. Check the signature first (against the identity shown in the call), then: room,
  inner `fromId` = relayed `fromId`, `toId` = self, epoch > last accepted from that sender.

## Rotation
- Envelopes go to (and are accepted from) participants whose bundle verifies **and** who are admitted: attested by
  the host key, or holding a ticket from a host or co-host, and not revoked. A verified revocation drops that
  participant's keys at once and rotates without them.
- On every join and leave (debounced 300 ms): new random key, `epoch + 1`, one envelope per *verified* participant
  in one `SendKeyEnvelopes` call, switch 500 ms after the server accepted it — at once if sending failed (a leaver
  must never keep reading). The very first key is used immediately.
- Receivers keep a sender's previous key for 10 s. A leaver's keys are removed from the worker at once.
- Never reuse a sender key across rooms, epochs or sessions (each rotation draws a fresh random key).

## Checklist (run on every crypto-related change)
- [ ] No key, envelope plaintext, or identity private key in: SignalR payloads (except signed envelopes), HTTP, `console.*`, error reports, localStorage.
- [ ] Private keys created with `extractable: false`.
- [ ] Can't join/publish if E2EE setup fails — no silent unencrypted fallback.
- [ ] Every envelope signature verified before use; identities that don't verify get no keys and are flagged.
- [ ] Keys only for admitted participants (host attestation or ticket from a host/co-host, not revoked); every new
      signed statement has its own `cipheroom/<name>/v1` label, includes the room id, and is added to the shared
      vectors so the api and browser encode the same bytes.
- [ ] Display names only inside encrypted, padded payloads (knocks, envelopes) — never in SignalR plaintext fields.
- [ ] Host keys non-extractable at rest; the exportable copy only in memory until the one-time backup or skip.
- [ ] Safety code recomputed and shown whenever participant set changes.
- [ ] No SFU data channels for app data (chat goes over SignalR, encrypted) — they're outside our key management.
- [ ] Every sender and receiver `MediaService` creates gets the transform before media flows (incl. placeholder and
      replaced tracks, and receivers the SFU reuses).
- [ ] Only WebCrypto primitives; no `Math.random`, no custom ciphers.
- [ ] Tests: envelope round trip, tampered envelope → reject, wrong recipient → reject, rotation on leave excludes leaver;
      chat: forged author / re-attributed sender / replay → dropped, newcomer can't read earlier events.
