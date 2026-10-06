# Participants list — design
Status: approved · Date: 2026-10-06

## Problem
People in a call can't see who else is in it, beyond the tiles. "Who can hear me?" must always be answerable.

## Goals / Non-goals
- **Goals:** a People panel (name, You, mic/camera/screen state, speaking), and a visible notice for every join/leave.
- **Non-goals:** verified identities / safety codes (E2EE work), moderation (kick/mute others), lobby.

## Constraints check
| Constraint | This feature |
|---|---|
| E2EE invariant | No new data leaves the client; names/track state are already known to api and LiveKit. |
| $0 / no public IP / open source | Client-only UI. |
| Untrusted server | Implements the "visible participants + join notices" defence from `docs/architecture.md`. A server holding LiveKit keys can still mint a *hidden* subscriber that no client list shows — only E2EE (no sender key for unknown participants) closes that. The panel says names aren't verified yet. |
| Two signaling channels | Source is LiveKit's participant list (= who can receive your media). No SignalR/protocol change. |
| XSS | Names only via interpolation; join/leave notices are our own capsules, **not** `nz-message` (renders HTML). |

## Design
- `LiveKitService.participants` signal (`CallParticipant`: identity, name, isLocal, isSpeaking, micMuted, cameraOn,
  sharingScreen), refreshed with tiles.
- Header participant count is a button → `ParticipantsPanel` (nz-drawer, inset grouped list; You first, then A–Z).
- `Room` diffs snapshots with `participantChanges()`; the first snapshot after joining is the baseline. Notices are
  glass capsules (max 3, 4 s, `aria-live="polite"`).

## Testing
Unit: `participantChanges`, panel ordering/state/XSS/honesty text, header emits `showParticipants`, room notices
(incl. HTML-looking names rendered as text). Manual: two browsers — join/leave notices and panel state.

## Later (with E2EE)
Per-person "verified" state from identity keys; safety code entry point in the panel; warn when someone in the
LiveKit room has no matching SignalR/identity record.
