---
name: security
description: Cipheroom security guidance — threat model, per-layer hardening rules (SignalR hub, LiveKit tokens, TURN quota, Angular/CSP, nginx, Docker, Cloudflare tunnel), secrets handling, dependency auditing, and a review checklist plus scripts/security-check.sh. Use when reviewing changes for security, adding endpoints/hub methods, touching auth, tokens, secrets, headers, Dockerfiles or deploy config, before releases, or when the user asks "is this secure?". For key/crypto work also load e2ee-media.
---

# Security

Cipheroom's promise: **no server can see call content**, and running it **costs nothing**. Threats are judged
against both: leaking content and burning the free tier are both security bugs.

## Threat model

| Asset | Why it matters |
|---|---|
| Media, chat, sender keys, identity private keys | Core promise. Must never reach a server in plaintext. |
| Participant identities and safety codes | Defence against a lying server (MITM, ghost participants). |
| Metadata: who, when, IPs, room ids, durations | Unavoidably visible to api, LiveKit and Cloudflare. Minimise it, never log more than needed. |
| LiveKit API secret, Cloudflare TURN token, tunnel token | They allow minting room tokens, spending TURN quota, or hijacking ingress. |
| Cloudflare TURN quota (1 TB/mo free) | Abuse means real money. |
| The home host | It runs Docker on the owner's network. |

| Adversary | Can | Mitigation |
|---|---|---|
| **Malicious or compromised server** (api, LiveKit) | Read metadata, drop or reorder messages, inject participants, swap public keys | E2EE + signed envelopes + safety codes + TOFU pinning (`e2ee-media`) |
| **Malicious participant** | Spam the hub, oversized payloads, impersonate names, flood TURN | Input validation, rate limits, per-room caps, host admission (lobby) |
| **Internet attacker** | Hit public endpoints, mint tokens, open rooms to burn quota, probe the LAN via TURN | Token only after admission, short TTLs, usage guard, Cloudflare TURN refuses private IPs |
| **Network attacker** | Sniff or modify traffic | TLS at Cloudflare, DTLS-SRTP + E2EE for media |
| **Supply chain** | Malicious npm/NuGet/Docker update | Lockfiles, pinned image tags, `scripts/security-check.sh` audits |

Out of scope for v1 (document it, don't hide it): metadata privacy against Cloudflare, traffic analysis,
compromised client devices.

## Rules by layer

### SignalR hub / API (`src/`)
- Every hub argument is untrusted. SignalR binds `null` to non-nullable parameters, so null-check and length-check everything.
- Authorise per call: the caller is in this room, is admitted, is host for host-only methods. Never trust ids sent by the client for "who am I"; use `Context.ConnectionId` → registry.
- Relay targeted messages only to members of the caller's room (`Clients.Client(id)` after a membership check). Never `Clients.All`.
- Never expose connection ids to clients. Use random participant ids (already done: `ParticipantId.New()` in Domain).
- Errors: `HubException` with a generic message. Don't leak stack traces, config or internal state.
- Logging: ids, counts and lengths only. **Never** log tokens, ICE credentials, envelopes, chat ciphertext, SDP, display names in bulk, or raw client payloads.
- Limits: `MaximumReceiveMessageSize` (64 KB), per-connection rate limits on chatty methods, a max participants per room.
- `AllowedHosts`: set it to the real hostname in production (not `*`).

### LiveKit tokens and TURN
- Issue a LiveKit token or TURN credentials only to admitted participants, never from an anonymous endpoint.
- Token TTL ≤ 10 min, room-scoped, `sub` = participant id, `canPublishData: false`. Never grant `roomAdmin`/`roomCreate` to clients.
- The LiveKit API secret is ≥ 32 random bytes from `scripts/secrets.sh`. Dev secrets (`appsettings.Development.json`, `livekit.dev.yaml`) must never be used in production.
- TURN credential TTL is bounded; the usage guard refuses issuance at the hard limit.
- LiveKit webhooks: verify the signature before trusting usage data.

### Frontend (`web/`)
- No `innerHTML`/`bypassSecurityTrust*` with user data. Display names are text, always interpolated.
- Strict CSP stays (`script-src 'self'`, no inline scripts, `connect-src 'self'`). If a change needs to loosen it, that needs justification in review.
- No third-party scripts, analytics, fonts or CDNs: they leak metadata and break the CSP.
- Key material and `location.hash` never go to `console.*`, storage, errors or network. See `e2ee-media`.
- If E2EE setup fails, refuse to join. Never fall back to unencrypted.

### nginx / Cloudflare / Docker (`deploy/`)
- Security headers live at **server level** in `deploy/nginx/default.conf` (an `add_header` in a location silently drops them): CSP, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `X-Content-Type-Options`.
- Cloudflare dashboard: SSL/TLS mode Full, "Always Use HTTPS" on, HSTS on, minimum TLS 1.2.
- Only the web container is published, and only on `127.0.0.1`. LiveKit publishes only its media ports (7881/tcp, 50000–50100/udp); signaling stays internal behind nginx.
- Containers run as non-root (`USER app`, nginx-unprivileged). Images are pinned to versions, never `latest`.
- `deploy/.env` is gitignored and `chmod 600`. Claude Code is denied from reading it. Ask the user to edit it via `!` commands.

### Secrets
- Never commit `.env`, tokens, certs or tunnel credentials. Run `scripts/security-check.sh` before committing deploy changes.
- A secret pasted into chat, logs or an issue is burned. Recommend rotating it (Cloudflare dashboard → roll token; `scripts/secrets.sh --force` for LiveKit).
- Rotation must not need a code change: everything goes through env vars.

## Review checklist
- [ ] New hub method or endpoint: input validated, authorised (member/admitted/host), rate-limited, targeted relay only.
- [ ] Nothing new is logged that could contain secrets, credentials or content.
- [ ] No new plaintext path for media, chat or keys to any server (if crypto is touched, run the `e2ee-media` checklist).
- [ ] Tokens and credentials: only to admitted participants, minimal grants, short TTL.
- [ ] CSP and headers unchanged, or the loosening is justified.
- [ ] No new third-party runtime dependency (or it's justified, pinned and audited).
- [ ] Docker: non-root, pinned tag, no new published ports.
- [ ] Free-tier impact: can this be abused to burn TURN quota?
- [ ] `scripts/security-check.sh` passes.

## Tools
- `scripts/security-check.sh [https://cipheroom.alexfix.dev]`: secret scan of tracked files, `deploy/.env` ignore and permission check, NuGet and npm vulnerability audit, and (with a URL) a live security-header check.
- For a review of a pending diff, also suggest the built-in `/security-review`.