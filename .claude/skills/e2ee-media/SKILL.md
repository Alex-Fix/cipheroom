---
name: e2ee-media
description: End-to-end encryption for Cipheroom — device identities (Ed25519/X25519), sender keys, signed key envelopes over SignalR, rotation on join/leave, our frame-encryption worker (encoded transforms), safety codes, and a security review checklist. Use whenever touching web/src/app/core/crypto, the frame transform, key envelopes, chat encryption, or anything that could leak key material.
---

# E2EE

Read `docs/architecture.md` → "Encryption model". Invariant: **no server (api, Cloudflare SFU, TURN) ever sees a plaintext
key, frame, or chat message.**

## Who does what
- **Frame encryption is ours** since the move to Cloudflare Realtime SFU (no LiveKit worker any more): one worker
  in `web/src/app/core/crypto/`, AES-GCM via WebCrypto, applied with encoded transforms (`RTCRtpScriptTransform`,
  `createEncodedStreams` fallback) on every sender and receiver `MediaService` creates. No custom ciphers, no
  homemade primitives — only the framing (what stays in the clear, IV layout) is ours, and it gets a design doc first.
- **Us** (`web/src/app/core/crypto/`):
  - `identity.ts` — create/load device identity (non-extractable keys in IndexedDB), sign bundle.
  - `sender-keys.ts` — generate, rotate, envelope encrypt/decrypt, signature verify.
  - `frame-crypto.worker.ts` — per-frame AES-GCM; keys per `(participantId, keyIndex)`.
  - `safety-code.ts` — emoji/digit code from all identity keys.
  - `chat-crypto.ts` — AES-GCM chat with HKDF-derived key (label `cipheroom/chat/v1`).

## Frame transform
- Keys per sender: our own key under our participant id, each remote participant's under theirs, selected by the
  `keyIndex` carried in the frame trailer. Media key = `HKDF(senderKey, info="cipheroom/media/v1")`, non-extractable.
- Leave the codec payload header in the clear so the SFU can still route/packetize: VP8 (the camera codec) has a
  short fixed header (keyframe 10 bytes, delta 3 bytes, as LiveKit's worker does); Opus needs none. If a codec other
  than VP8/Opus is ever negotiated (e.g. H.264 — NAL unit headers must stay clear), the worker must handle it or the
  sender must refuse.
- Unique IV per frame per key (sender id ‖ counter); never reuse a key across rooms or epochs.
- Unsupported browser (no encoded transforms) → can't join an encrypted room; never fall back to plaintext.

## Envelope format (v1)
```
envelope = {
  v: 1, roomId, epoch, keyIndex, fromId, toId,
  ephPub,                         // X25519 ephemeral public key
  iv, ct,                         // AES-GCM(HKDF(ECDH(eph, recipientX25519), salt=roomId, info="cipheroom/env/v1"), senderKey)
  sig                             // Ed25519 over canonical JSON of all fields above
}
```
- AAD for AES-GCM = canonical `{v, roomId, epoch, keyIndex, fromId, toId}`.
- Reject: bad signature, unknown/unpinned-changed sender identity, `toId` ≠ self, stale epoch, replayed `(fromId, keyIndex)`.

## Rotation
- On `ParticipantJoined` / `ParticipantLeft`: generate new sender key, `keyIndex = (keyIndex + 1) % keyringSize`,
  send envelopes to all *current* participants, switch own encryption after a short delay (~500 ms) so receivers
  have the key. Debounce rapid join/leave bursts.
- Never reuse a sender key across rooms or epochs.

## Checklist (run on every crypto-related change)
- [ ] No key, envelope plaintext, or identity private key in: SignalR payloads (except signed envelopes), HTTP, `console.*`, error reports, localStorage.
- [ ] Private keys created with `extractable: false`.
- [ ] Can't join/publish if E2EE setup fails — no silent unencrypted fallback.
- [ ] Every envelope signature verified before use; identity changes surface a warning.
- [ ] Safety code recomputed and shown whenever participant set changes.
- [ ] No SFU data channels for app data (chat goes over SignalR, encrypted) — they're outside our key management.
- [ ] Every sender and receiver `MediaService` creates gets the transform before media flows (incl. placeholder and
      replaced tracks).
- [ ] Only WebCrypto primitives; no `Math.random`, no custom ciphers.
- [ ] Tests: envelope round trip, tampered envelope → reject, wrong recipient → reject, rotation on leave excludes leaver.
