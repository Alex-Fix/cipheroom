# Call reliability — design
Status: implemented · Date: 2026-10-11

## Problem
Three open follow-ups from #22 hurt every call:

1. After a codec change (and the rejoin it causes), Cloudflare sometimes refuses a subscriber's answer with
   *"subscriber's SDP is missing the published track's codec"*. The subscriber then stops receiving that person.
2. Once an answer to an SFU offer is refused, Cloudflare keeps waiting for one and refuses every further negotiation
   on that session. Today the client keeps retrying subscriptions against that stuck session; nothing recovers it.
3. At join, the microphone and the camera (or its placeholder) are published in two negotiations: an extra round
   trip, and more chances for negotiations to collide.

## Goals / Non-goals
Goals
- Find the root cause of the codec error with a reproducible test and diagnostics, then fix the confirmed cause.
- A call whose SFU session is stuck after a refused answer recovers by itself (rejoin), without looping forever.
- Publish microphone and camera in one negotiation at join.

Non-goals
- A media-only reconnect that keeps SignalR membership and keys (approach B, rejected: needs hub changes; rare path).
- Changing codec selection, simulcast or quality behaviour.
- Fixing a microphone allowed only after receiving started (publish after answering; can still fail on iOS, as today).

## Constraints check
| Constraint | This feature |
|---|---|
| E2EE invariant | Unchanged. Frame transforms are attached to both senders before the single offer. Diagnostics hold codec names only. |
| $0 running cost | No new services. One extra negotiation per unsubscribe (if the fix needs it) is signaling, not media. |
| No public IP | Unchanged. |
| Self-hostable + open source | Unchanged. |
| Untrusted server | The api already relays full SDP; logging codec names per mid reveals nothing new. No SDP, payload types, fmtp, IPs, ICE or fingerprints are logged. |
| Browser support | Single publish with two transceivers in one offer works in Chrome, Firefox and Safari; iOS rule (publish before receiving) is kept. |
| Signaling | No change for the safety net, the diagnostics or the single publish. Only if the fix is "close tracks with renegotiation", `UnsubscribeTracks` returns `offerSdp \| null` → C#, TS and `docs/signaling-protocol.md` together. |

## Chosen approach
**A — repro → fix confirmed cause → rejoin safety net → single publish.** The full rejoin already exists and is
tested; the real fix is the root cause, not a smoother fallback.
- Not B (media-only reconnect): new hub path and re-publish logic for a failure that should become rare.
- Not "safety net only": leaves a deterministic bug in place that every codec change triggers.

## Root cause (found 2026-10-11, step 4)
**Not H1.** `artifacts/repro/codec-rejoin.mjs` failed 14 checks on the dev stack, including for *fresh* connections
(a newcomer couldn't receive someone sending the other codec), so stale m-lines weren't the cause.
`codec-sdp-probe.mjs` (Hana sends VP9, Bob VP8, codec names per m-line only) showed it:

```
[Bob] local offer:   video#1 sendonly [VP8]                 ← setCodecPreferences: only our sending codec
[Bob] remote offer:  … video#3 sendonly [VP8]               ← Hana's VP9 track, offered to Bob as VP8 only
[Bob] local answer:  … video#3 recvonly [VP8]               → Cloudflare: "subscriber's SDP is missing the published track's codec"
```

Cloudflare offers a subscriber only the video codecs its session advertised when it published. We limited the
publish offer to the one codec we send, so **any call where two people send different codecs** broke: a codec
change (rejoin), a manual pick, or a fallback for someone who can't decode VP9.

**Fix:** the publish offer lists the sending codec first, then our other frame-layout codecs (VP9/VP8, baseline
profile first), then rtx/red/ulpfec (`codecPreferences`). Cloudflare keeps that order in its answer, so we still
send the chosen codec (checked in outbound-rtp stats: Hana VP9 ×3 layers, Bob VP8), and subscriber offers now
carry both codecs. The repro passes all 20 checks. **No protocol change.** H.264/AV1 stay out (unknown to the frame
layout). Risk: if Cloudflare ever reordered its answer, we'd send a codec the frame transform wasn't configured for (frames
still encrypted, but laid out for the wrong codec). `codec-sdp-probe.mjs` checks the sent codec in outbound-rtp
stats; rerun it when Cloudflare changes behaviour.

## Design

### 1. Repro and diagnostics
**Repro** — `artifacts/repro/codec-rejoin.mjs`: two headless Chromium browsers with fake media (no real devices).
A and B join on VP9; A switches to VP8 (rejoin); assert B receives A's video and neither side logs a Renegotiate
failure. Also VP8 → VP9, and a codec change while a screen share is on. Runs against the dev stack's real
Cloudflare SFU.

**Server diagnostics** (Infrastructure only): `CloudflareSfu` keeps, per SFU session, a summary of the last pending
offer it relayed (subscribe, data transport): `mid → kind + codec names`. Removed when the answer is accepted;
the map is bounded (≈1,000 entries, oldest evicted). On a refused `renegotiate`, the `MediaServerException` cause
carries `offered`, `answered` (parsed the same way from the answer) and Cloudflare's sanitized reason;
`HubExceptionFilter` already logs it (Loki). The client message stays `"Media server unavailable."`.

**Client diagnostics**: `MediaService` records the last negotiation failure — step (`publish`, `subscribe-answer`,
`data-transport`, `ice-restart`, later `unsubscribe-answer`), time, and codecs per mid from its local and remote
descriptions. The Connection drawer's copyable report adds a "Last negotiation failure" line (computed in the
browser, no identifiers).

**Leading hypothesis (H1).** `forget()` drops only bookkeeping; the local transceiver keeps its m-line and the api
closes the SFU tracks with `force: true` (no renegotiation). Cloudflare may then reuse that mid for the rejoined
publisher's track in the new codec while our local description still negotiates the old codec there, so the answer
lacks the published codec.

### 2. Fix and safety net
**Fix**: see *Root cause* — advertise all our codecs in the publish offer (H1 / unsubscribe-with-renegotiation is
not needed).

**Safety net.** Any failure while answering an SFU offer (subscribe, data transport, unsubscribe) means the session
is stuck: `MediaService` sets `state` to `disconnected` and stops the pull retry loop (the reason lives in
`negotiationFailure` for the report; the room needs none). The
room's existing rejoin takes over (teardown → 1 s → join with the wanted devices; others see leave/join; keys
rotate). A failed *publish* (our own offer) is rolled back and does not trigger it.

**Loop guard.** `rejoinAttempts` resets only after 30 s of stable `connected` media (today: on any `connected`).
After 3 quick failures the user sees "Connection lost" with Try Again.

### 3. Single publish at join
1. Capture mic and camera in parallel, independently (a denied camera doesn't fail the mic).
2. `MediaService.publishOwnTracks({ microphone, camera })` (designed as `publishInitial`): add both send
   transceivers, attach the frame transform to each before `createOffer`, set the codec preference on video, one
   `PublishTracks` with two `{ mid, source }` entries (server already allows 3 per publish).
3. Camera = real track or muted placeholder (off, denied, or audio-only under the usage guard). A mic the user
   wants off is published disabled, then `setTrackMuted`.
4. On failure, roll back both transceivers; the join fails into the normal error / Retry path.

Device changes afterwards keep swapping tracks; screen share still publishes on first use.

## Protocol changes
None (the confirmed fix is client-side codec preferences).

## Security notes
- Logged codec summaries: mids (short tokens) and codec names only, from SDP the api already relays. The parser
  never emits anything else (tested with junk SDP). No SDP in logs, telemetry or reports.
- The bounded map lives in memory only and is pseudonymous (keyed by SFU session id, never logged).
- e2ee-media checklist: frames attached to every sender before the first offer; no unencrypted fallback on failure —
  a stuck session rejoins, it never sends without the transform.
- A malicious api could force rejoins by failing answers; it can already end anyone's media, so no new capability.

## Testing
- Backend: codec summary parser (output is only mids + codec names; junk SDP), bounded map eviction, refused-answer
  exception cause; functional hub tests for `UnsubscribeTracks` if it changes.
- Frontend: failed answer → `disconnected`, no retry loop; failed publish → still usable;
  `publishOwnTracks` → one offer, two mids, frames attached before `createOffer`; room loop guard (fake timers).
- E2E: `codec-rejoin` (fails before the fix, passes after); `safety-net-e2e` (old bug injected in one browser:
  refused answer logged as codec summaries, rejoins, ends at "Connection lost."); lobby, layouts, files as regression.
- Manual on the home stack (`scripts/up.sh --tunnel`): Mac Chrome ↔ iPhone, codec change both ways, join with camera
  off.

## Open questions
- iPhone Safari: confirm on the home stack that it sends its chosen codec with both listed (manual test).

## Implementation steps
1. ✅ `codec-rejoin.mjs` repro script (reproduced: 14 failures).
2. ✅ Codec summary parser + bounded pending-offer map in `CloudflareSfu`; refused-answer cause logged (+ tests).
3. ✅ Client: record the last negotiation failure; "Last negotiation failure" line in the Connection report (+ specs).
4. ✅ Root cause found with `codec-sdp-probe.mjs` (not H1, see *Root cause*).
5. ✅ Fix: publish offers list all our codecs, sending codec first (+ specs); repro passes 20/20.
6. ✅ Safety net: failed answer → `disconnected`, stop pull retries (+ specs).
7. ✅ Loop guard: reset rejoin attempts after 30 s stable (+ room spec).
8. ✅ `MediaService.publishOwnTracks`: mic + camera in one negotiation; the room's join uses it (+ specs).
9. ✅ Docs: `media` skill rules, `docs/architecture.md` recovery notes, protocol doc if changed; e2e regression run.
