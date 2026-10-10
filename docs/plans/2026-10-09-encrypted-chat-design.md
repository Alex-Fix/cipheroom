# Encrypted chat — design
Status: approved · Date: 2026-10-09

## Problem
Calls have no text channel. People need to paste a link, say something while muted, or react without interrupting.
Chat must keep the product's invariant: no server (api, Cloudflare, tunnel) can read it.

## Goals / Non-goals
Goals (v1):
- In-call text chat to everyone in the call, end-to-end encrypted with the call's sender keys.
- Emoji picker in the composer (built-in curated set, no dependency) and emoji **reactions** on messages.
- URLs become clickable links; nothing is fetched.
- Memory only: chat disappears when you leave. Someone who joins sees only messages sent after they joined.

Non-goals: files and images (no transport without storage — later), link previews (would leak the URL to our server
or the sender's IP to the site), lobby chat (guests have no keys), private messages, history for newcomers,
edits/deletes, typing indicators, persistence.

## Constraints check
| Constraint | This feature |
|---|---|
| E2EE invariant | Server relays one opaque blob per event. Message vs reaction, text, ids, names are all inside the ciphertext. |
| $0 running cost | Text over the existing SignalR/tunnel path; no Cloudflare usage. |
| No public IP | Nothing new inbound. |
| Self-hostable + open source | No new dependency (emoji set is ours, links are plain anchors). |
| Untrusted server | Sees sender, room, time and a padded size bucket. Can drop, delay or replay — replays are rejected (per-author sequence numbers), forgeries fail (Ed25519 signature by the author, AES-GCM with the author's key). |
| Browser support | Same as calls (WebCrypto Ed25519 + AES-GCM + HKDF); no extra APIs. |
| Signaling | New `SendChat` (C→S) and `ChatReceived` (S→C), replacing the "Planned" draft. |

## Chosen approach
**One opaque chat-event relay.** `SendChat(blob)` → `ChatReceived(fromId, blob)` to the other admitted members of
the room. All semantics live inside the encrypted, signed payload.
- Not typed hub methods (`SendMessage` / `SendReaction`): the method name would tell the server who reacts to what.
- Not pairwise encryption per recipient: only needed for DMs, which are out of scope; N ciphertexts per message.

## Design

### User flow
- **Chat** button in the call controls with an unread badge. Opens a right-hand drawer (360 px, full width on
  phones) without a mask, so the call stays visible and usable.
- A message while the drawer is closed → a short notice "Alice: first 60 characters…" (template interpolation only).
- Messages: author name, time, text; consecutive messages from one author are grouped. Plain text, no markdown.
  `http(s)://` URLs become `<a target="_blank" rel="noopener noreferrer">`.
- Composer: Enter sends, Shift+Enter is a newline, 2,000 characters max. Own messages show "Sending…" until the
  server accepts them; a failed one can be retried.
- 😊 button opens the emoji picker (≈ 250 emoji in categories + recently used, kept in `localStorage`).
- Reactions: a smile button on each message (on hover; always visible on touch screens) opens a quick row
  (👍 ❤️ 😂 😮 😢 🎉) plus the full picker. Chips under the message show emoji + count; your own chip is
  highlighted and clicking it removes your reaction; hovering lists who reacted.
- Joins and leaves appear as system lines in chat, which also explains where a newcomer's history starts.
- Header text: "Messages are end-to-end encrypted and disappear when you leave."
- The composer is disabled until our first sender key exists, and while reconnecting.

### Components and boundaries
- `core/crypto/chat-crypto.ts` — pure: chat key derivation, padding, `sealChat` / `openChat`, event validation.
- `CryptoService` — chat keys beside media keys (derived from the same sender key before it is transferred to the
  worker), `chatReady`, `sealChat(event)`, `onChatEvent(listener)`; subscribes to `ChatReceived`, holds early
  messages until the sender's key arrives, checks signatures and sequence numbers. Components never see keys.
- `core/chat/chat.service.ts` (room-scoped) — chat state: items, reactions, unread count, send/retry/react,
  system lines, the latest incoming message (for notices). `core/chat/emoji.ts` (curated set, reaction allow-list),
  `core/chat/links.ts` (text → text/link segments), `core/settings/recent-emoji.ts`.
- `features/room/chat-panel/` (drawer, list, composer, reactions) and `features/room/emoji-picker/` —
  presentational. `Room` wires them and adds system lines from its existing join/leave announcements.
- Backend: `Application/Chat/ChatRules.cs`, `Chat/Commands/SendChat/SendChatCommand.cs` (+ validator, handler),
  hub method, `IRoomClient.ChatReceived`, a `cipheroom.chat.relayed` counter.

### Crypto
```
chatKey  = HKDF-SHA-256(senderKey, salt = ∅, info = "cipheroom/chat/v1") → AES-GCM-256, non-extractable
event    = JSON { v: 1, seq, type: "message", id, text }
         | JSON { v: 1, seq, type: "reaction", target, emoji, on }
sig      = Ed25519(author identity, fields("cipheroom/chat-sig/v1", roomId, utf8(event)))
inner    = fields(utf8(event), sig)
padded   = uint32 length ‖ inner ‖ zeros, to 512 / 2,048 / 8,192 / 16,384 bytes
aad      = fields("cipheroom/chat-aad/v1", roomId, fromId, keyIndex)
blob     = base64url(version 1 B = 1 ‖ keyIndex 1 B ‖ iv 12 B (random) ‖ AES-GCM(chatKey, iv, aad, padded))
```
- The chat send key switches together with the media send key (same rotation, same 500 ms delay, at once if the
  envelopes failed), so leavers can't read later messages and newcomers can't read earlier ones.
- Receive keys per sender and key index; the previous one stays usable for 10 s (same as media).
- Receiving: sender must be a verified, admitted peer → key for `(fromId, keyIndex)` (else held up to 10 s, max 64
  pending, retried when that sender's key arrives) → decrypt → unpad → signature against the sender's identity →
  event shape → `seq` greater than the last one from that identity (replays dropped).
- `seq` counts per identity, so it survives a rejoin (the identity is kept for the call). Message ids are 16
  random bytes. Reactions must use an emoji from our set and point at a message we have.
- Text is cleaned on both sides: trimmed, ≤ 2,000 code points, no control characters except newline and tab, no
  bidi overrides (U+202A–202E, U+2066–2069); a received text that cleaning would change is dropped.

### Data and state
Browser memory only (`ChatService`, provided on the room route); kept across an automatic rejoin, gone when the
room is left. At most 500 items (oldest dropped). The server stores nothing.

### Failure modes
- Sending fails (disconnected, rate limit) → message marked failed with Retry; reactions are reverted.
- A sender's key never arrives (unverified participant, malicious server) → their messages are dropped after 10 s.
- Messages sent in the ~1 s around someone joining may not reach the newcomer (old key) — accepted, like media.
- Rate limit: chat shares the per-connection hub bucket (20 burst, 5/s); normal typing stays far below it.

## Protocol changes
| Direction | Method | Args | Notes |
|---|---|---|---|
| C→S | `SendChat` | `blob` | Admitted members only; base64url ≤ 22,528 chars; relayed to everyone else in the room, never stored or logged |
| S→C | `ChatReceived` | `fromId, blob` | `fromId` set by the server |
Errors: `Invalid chat message.` (malformed or too large), `Join a room first.`, `Not admitted.`.

## Security notes
- Metadata visible to the server: who sent a chat event, when, to which room, and its size bucket. It can't
  tell messages from reactions or see lengths beyond the bucket.
- A malicious server can drop or delay events, or show them to a subset of members; it can't forge, alter,
  re-attribute or replay them. An insider + malicious server can't forge another member's messages (signatures).
- Links: only `http(s)` become anchors, `noopener noreferrer`, and the CSP already forbids anything else. No previews.
- No chat content in logs, metrics labels or call-quality reports. Names only from signed key envelopes.
- e2ee checklist: new label `cipheroom/chat/v1` (+ `chat-sig`, `chat-aad`), keys non-extractable, no plaintext
  fallback (no key → can't send), signatures checked before use.

## Testing
- Backend: validator/handler unit tests; functional tests — relay to others only (not the sender, not another
  room, not the lobby), malformed/oversized rejected, not joined rejected.
- Frontend: `chat-crypto` round trip, tamper → reject, wrong key/sender/room → reject, padding buckets, bad
  signature, cleaning; `CryptoService` holds early messages, rejects replays, switches chat key with rotation;
  `ChatService` send/fail/retry, reactions toggle, unread; links, emoji set; panel and picker components.
- Manual: two browsers on the home stack (`scripts/up.sh --tunnel`).

## Open questions
- Files/images later: encrypted blobs held temporarily by the api is the likely transport.

## Implementation steps
1. Backend: `ChatRules`, `SendChatCommand`, hub method + `ChatReceived`, metric, unit + functional tests.
2. Protocol: TS types + `SignalingService.sendChat/onChat`, `docs/signaling-protocol.md`.
3. `chat-crypto.ts` + tests; `CryptoService` chat keys, pending queue, replay check + tests.
4. `core/chat`: emoji set, links, `ChatService` + tests; recent emoji setting.
5. UI: emoji picker, chat panel, chat button + badge, `Room` wiring + notices + system lines.
6. Docs: architecture (chat), README roadmap, skills (`e2ee-media` planned → built, `angular-frontend` layout).
