---
name: e2ee-media
description: End-to-end encryption for Cipheroom — device identities (Ed25519/X25519), sender keys, signed key envelopes over SignalR, rotation on join/leave, LiveKit per-participant key provider, safety codes, and a security review checklist. Use whenever touching web/src/app/core/crypto, the key provider, key envelopes, chat encryption, or anything that could leak key material.
---

# E2EE

Read `docs/architecture.md` → "Encryption model". Invariant: **no server (api, LiveKit, TURN) ever sees a plaintext
key, frame, or chat message.**

## Who does what
- **LiveKit E2EE worker**: frame encryption (AES-GCM, encoded transforms). We don't write frame crypto.
- **Us** (`web/src/app/core/crypto/`):
  - `identity.ts` — create/load device identity (non-extractable keys in IndexedDB), sign bundle.
  - `sender-keys.ts` — generate, rotate, envelope encrypt/decrypt, signature verify.
  - `cipheroom-key-provider.ts` — LiveKit key provider in **per-participant** mode.
  - `safety-code.ts` — emoji/digit code from all identity keys.
  - `chat-crypto.ts` — AES-GCM chat with HKDF-derived key (label `cipheroom/chat/v1`).

## Key provider
Extend LiveKit's `BaseKeyProvider` with `{ sharedKey: false, ratchetWindowSize: 0 }` and feed it keys:
`this.onSetEncryptionKey(cryptoKey, participantIdentity, keyIndex)` — local participant's own key uses its own identity.
(Verify exact names against the installed `livekit-client`; don't use `ExternalE2EEKeyProvider` — it's shared-key.)
Media key = `HKDF(senderKey, info="cipheroom/media/v1")` imported as raw AES key material per LiveKit's expectation.

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
- [ ] LiveKit token has `canPublishData: false` (data channel is outside our key mgmt).
- [ ] Only WebCrypto primitives; no `Math.random`, no custom ciphers.
- [ ] Tests: envelope round trip, tampered envelope → reject, wrong recipient → reject, rotation on leave excludes leaver.
