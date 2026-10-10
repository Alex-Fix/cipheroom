# Sticky removals — design
Status: approved · Date: 2026-10-10

## Problem
Each browser replaced its verified view of the room's authority with every update from the server. When an update
no longer listed a removal — after an api restart (the server's authority lives in memory and is rebuilt as people
rejoin), or from a server lying by omission — browsers forgot it. A removed participant who kept their per-call
identity and ticket (a modified client) could rejoin and receive everyone's keys again.

## Decision
No database or Redis (they wouldn't stop a lying server, and would keep metadata at rest). Browsers keep every
removal they verified for the rest of the call (`CryptoService.removed`, reset with the per-call identity) and merge it
into each later authority: such a participant stays unverified, gets no envelopes, and has no host or co-host rights.

## Constraints check
Client-only; no protocol, server or storage change. Metadata unchanged.

## Testing
`crypto.service.spec.ts`: removal verified → server's authority loses it → a rotation (newcomer) still excludes the
removed participant. Fails without the fix.

## Open questions
Restoring co-host grants and auto-admit after an api restart (rejoining clients hand back signed statements) — later.
