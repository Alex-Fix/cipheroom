# Remember contacts (TOFU) — design
Status: approved · Date: 2026-10-10

## Problem
Identities are fresh per call (so the server can't link calls), which also means nobody is recognised across calls:
an impersonator who picks a familiar name looks exactly like the real person, and the safety code has to be compared
from scratch every time.

## Goals / Non-goals
Goals:
- Every browser remembers the people it has been in calls with (automatically), keyed by their **device key**.
- Marks in the call: **known** (met before) and **verified** (you compared the safety code and said so).
- A clear **warning** when a newcomer uses the name of a contact you verified but with another key (or none).
- Your own device key: set up once on the home page with a **passphrase backup**; restore it on another device or
  after clearing site data.
- A contacts list on the home page (verify / unverify, forget, forget everyone).

Non-goals: contacts in the backup, syncing contacts between devices, linking several device keys to one person,
server-side anything, calling a contact directly (no directory).

## Constraints check
| Constraint | This feature |
|---|---|
| E2EE invariant | Device keys and statements travel only inside encrypted key envelopes. |
| Untrusted server | Sees the same as today (per-call keys, same-size envelopes); can't forge or swap a device key. |
| Metadata | New only among peers: people you call can link your calls with them (by design, stated in the UI). |
| $0 / no public IP / open source | Browser-only: IndexedDB + WebCrypto. |
| Browser support | Ed25519 keys in IndexedDB work in Safari (host keys do; the WebKit issue was X25519). |
| Signaling | No new methods; key envelopes get format v3 (+~130 chars, under the 2 KB limit). |

## Chosen approach
**A long-term device key signs each per-call identity; the statement travels inside the key envelopes.** The server
keeps seeing unlinkable per-call keys, people who call each other recognise each other.
- Not a long-term identity in place of per-call ones: the server would see the same key in every call.

## Design

### User flow
- **Home → Your identity**: *Set up* creates the device key and opens the passphrase backup (the host-key dialog);
  afterwards the key is non-extractable. *Restore from backup* on a new device or after clearing data. Not set up:
  a nudge ("so people you call can recognise you"); calls work either way and you still remember others.
- **In a call**: participants panel and tile captions show **known** / **✓ verified**; the panel offers **Mark as
  verified** (after comparing the safety code out loud). ⚠️ for a newcomer with a verified contact's name and another
  key: "Not the Bob you verified — new device, or someone else. Compare the safety code." (also a notice).
- **Home → Contacts**: latest name ("Bob, previously Robert"), first / last seen, verified toggle, Forget, Forget
  everyone. In this browser only.

### Crypto
```
deviceKey  = Ed25519, non-extractable in IndexedDB; exportable copy only in memory until the one-time backup
statement  = Ed25519(deviceKey, fields("cipheroom/device/v1", roomId, perCallEd25519Pub))
payload v3 = senderKey (32) ‖ padded name (258) ‖ hasDevice (1) ‖ devicePub (32) ‖ statement (64)
```
- The device block is always there (zeros without a device key): every envelope has the same size.
- A device key is accepted only if the statement verifies over the sender's per-call identity — the one that signed
  the envelope — so nobody can replay someone else's statement.
- The safety code covers the per-call keys, which are bound to the device keys: "Mark as verified" after comparing
  codes verifies the device key.
- Receivers read v2 and v3 (a deploy mid-call can mix them); senders send v3.

### Components
- `core/crypto/device-key.ts` (create, sign, verify), `device-key-store.ts` (IndexedDB, memory fallback — like
  `host-key-store.ts`).
- `core/crypto/key-backup.ts`: the host-key backup generalised with `kind: 'host' | 'device'` (old host backups
  still import).
- `CryptoService`: statement in every envelope; verifies incoming ones; `devices` signal (participant id → verified
  device key). Components only get public data.
- `core/contacts/contacts.service.ts` (`providedIn: 'root'`, IndexedDB `cipheroom-contacts`): `remember`,
  `markVerified` / `unverify`, `forget` / `forgetAll`, `contacts` signal; pure `trustOf(devicePub | undefined, name,
  contacts)` → `verified | known | new | mismatch`.
- `MediaService.participants` gains `trust`; participants panel, tile caption, Room notice on `mismatch`.
- Home: `identity-card` and `contacts-list` components.

### Data and state
Device key and contacts in this browser's IndexedDB; nothing on the server. Clearing site data wipes both; the backup
restores the identity only.

### Edge cases
- New name, known key: still known, contact shows the new name; no warning.
- Two verified contacts share a name: an unknown key with that name warns (it matches neither).
- One identity on two devices (restored backup): recognised on both.
- No device key (not set up / older version): no mark, not remembered; with a verified contact's name: warning.
- IndexedDB unavailable (private mode): setup unavailable with an explanation; contacts kept for the session only.

## Protocol changes
None to the hub; the key-envelope blob format becomes v3 (`docs/signaling-protocol.md` and `docs/architecture.md`
describe it).

## Security notes
- Server: no new information; can't forge, swap or replay a device statement.
- Peers learn your device key and can link calls with you (stated on the identity card).
- A malicious peer can't take on another device key; using a verified person's name triggers the warning.
- Backup strength = passphrase (12+ characters), PBKDF2-SHA-256 600k, as for host keys.
- e2ee checklist: new label `cipheroom/device/v1`; device private key non-extractable at rest; statements verified
  before use; names still only in encrypted payloads.

## Testing
- Unit: statement round trip; replayed statement rejected; envelope v2/v3 interop; device block same size with and
  without a key; `trustOf` for each case; contacts store; backup round trip for both kinds; old host backup imports;
  `CryptoService.devices` only from verified statements.
- E2E (headless-shell, fake devices): set up identity; same person in two calls → known; mark verified; impostor with
  that name → warning.

## Open questions
- Contacts in the backup / syncing between devices — later, if wanted.

## Implementation steps
1. Device key + store.
2. Envelope v3 with the device statement; `CryptoService.devices`.
3. Backup generalised (`kind`), device-key backup and restore.
4. Contacts service + `trustOf`.
5. Call UI: marks, Mark as verified, mismatch warning.
6. Home: identity card + contacts list.
7. E2E check; docs (architecture, protocol doc, README, `e2ee-media` skill).
