---
name: brainstorming
description: Turn a rough Cipheroom feature idea into an agreed design before any code is written — clarify with one question at a time, check it against the project's hard constraints (E2EE, $0 cost, no public IP), compare 2–3 approaches, then write a design doc to docs/plans/. Use when the user wants to brainstorm, explore, or design a feature, or says "let's think about…", "how should we…", "what if…", or starts a new feature without a clear spec.
---

# Brainstorming

Goal: leave with a **design the user has approved**, written down. Don't write code, scaffold files or change
config during brainstorming. The output is a design doc.

## 1. Understand the context first (silently)
Before asking anything, read what's relevant so you don't ask what the repo already answers:
- `CLAUDE.md`, `docs/architecture.md`, `docs/signaling-protocol.md`, `docs/plans/` (earlier designs)
- The code the feature would touch, and `git log --oneline -15`

## 2. Clarify — one question at a time
- Ask **one** question per message. Wait for the answer before the next.
- Prefer multiple choice (use AskUserQuestion with 2–4 options, recommended option first) over open questions.
- Focus on: who it's for, the core use case, what "done" looks like, and what's explicitly out of scope.
- Stop asking once you could explain the feature back in two sentences. Usually 3–6 questions.
- If the user's answer reveals a concept they may not know (SFU, TURN, MLS, …), explain it plainly in 2–4 lines.

## 3. Check against Cipheroom's hard constraints
Every idea gets checked against these before approaches are proposed. Name any conflict out loud.

| Constraint | Ask |
|---|---|
| **E2EE invariant** | Does any server (api, Cloudflare SFU/TURN/tunnel) need plaintext media, chat, or keys? If yes it's a design change, not a feature. |
| **$0 running cost** | Does it need a paid service, a rented VM, or push us past Cloudflare's 1 TB/mo free tier? (No Oracle.) |
| **No public IP** | Does it need inbound ports? Only HTTP/WS via the tunnel is available; media only via Cloudflare TURN. |
| **Self-hostable + open source** | Any closed SDK or third-party SaaS dependency? |
| **Untrusted server** | Can a malicious api/SFU abuse it (inject participants, swap keys, read metadata)? What's visible as metadata? |
| **Browser support** | Needs encoded transforms, WebCrypto Ed25519/X25519, etc.? Which browsers break? Mobile Safari? |
| **Signaling** | Everything goes over SignalR (media negotiation is relayed to the SFU). Does it need new hub methods/events (→ `signaling-protocol`)? |

## 4. Propose 2–3 approaches
For each: one-paragraph summary, what changes (backend / frontend / deploy / protocol), trade-offs,
rough size (S/M/L), and the constraint risks from step 3. **Lead with your recommendation and say why.**
Let the user pick or mix. Don't list options you wouldn't actually recommend just to reach three.

## 5. Present the design in small sections
Walk through the chosen approach in chunks of ~200–300 words, checking after each: "Does this look right so far?"
Cover what applies:
- User flow (what the person sees and does)
- Components and boundaries (which service/class owns what — see `CLAUDE.md` conventions)
- Protocol changes (SignalR methods/events → must follow the `signaling-protocol` skill)
- Crypto/key handling (→ `e2ee-media` skill checklist)
- Data and state (in-memory vs persisted; what survives restarts)
- Failure modes (disconnect, reconnect, relay quota hit, unsupported browser)
- Testing (backend hub tests, frontend unit tests, two-browser e2e)
- Rollout (feature flag? migration? docs to update?)

Go back to earlier steps whenever something doesn't fit. YAGNI: cut anything not needed for the core use case.

## 6. Write the design doc
When the user approves, write `docs/plans/YYYY-MM-DD-<topic>-design.md` (today's date):

```markdown
# <Feature> — design
Status: approved · Date: YYYY-MM-DD

## Problem
## Goals / Non-goals
## Constraints check        (table from step 3, with this feature's answers)
## Chosen approach          (+ why not the alternatives, one line each)
## Design                   (sections from step 5)
## Protocol changes         (if any)
## Security notes           (threats, metadata exposure, e2ee checklist items)
## Testing
## Open questions
## Implementation steps     (ordered, each small enough for one commit)
```

Then ask whether to start implementing — on a feature branch (`feat/<topic>`), following the implementation steps.
Don't commit the design doc unless asked.

## Anti-patterns
- Asking several questions in one message.
- Jumping to code or file scaffolding before approval.
- Presenting the whole design in one wall of text.
- Silently dropping a constraint conflict instead of raising it.
- Re-asking things already decided in `CLAUDE.md`, `docs/`, or memory.