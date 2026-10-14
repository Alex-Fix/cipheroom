# Security model

Cipheroom's promise: **no server can see or hear call content**. That covers your own api, the media server, the TURN
relays and the tunnel. All of them are treated as untrusted.

## What's protected

- **Media**: every frame is encrypted in the browser (AES-GCM, our frame transform in a worker) with per-sender keys.
  Keys rotate whenever someone joins or leaves.
- **Keys**: each call uses fresh identities (Ed25519 / X25519). Sender keys travel only inside signed, encrypted
  envelopes. Private keys are non-extractable in the browser.
- **Chat and files**: encrypted and signed by each sender. Files go straight from the sender's browser over the SFU
  and are never stored, not even on your server.
- **Who gets in**: a meeting belongs to a host key kept in the creator's browser. Admissions, co-hosts, removals and
  "end call" are signed, and each browser checks them, so even a malicious server can't slip anyone in.
- **Names**: display names never reach the server unencrypted.
- **No downgrade**: a browser that can't encrypt (it needs encoded transforms and Ed25519/X25519 in WebCrypto) can't
  join. Calls never fall back to unencrypted.

## Safety codes and contacts

Each call shows a **safety code** (emoji plus digits) derived from everyone's identity keys. Compare it out loud: if
it matches, nobody in the middle swapped keys. Browsers remember contacts (trust on first use) and warn when a name
you verified shows up with a different key.

## What servers can still see (metadata)

When calls happen and for how long, IP addresses, how many people are in a room, which random id is host, and
traffic volumes. With the optional observability stack, your server keeps pseudonymous call metadata and quality
numbers for 7 days: no names, IPs or plain room ids. Traffic analysis, and devices that are already compromised, are
out of scope.

## How it's checked

- Rules: the `security` and `e2ee-media` skills in [`.claude/skills/`](https://github.com/Alex-Fix/cipheroom/tree/main/.claude/skills).
- Every deploy: `scripts/security-check.sh <url>`.
- **Audits**, covering the app and a live server, with reports in
  [`docs/security/audits/`](https://github.com/Alex-Fix/cipheroom/blob/main/docs/security/audits/README.md). Latest, **2026-10-14** (direct mode on a new
  server): no Critical or High findings; one Medium (LiveKit on the host network could reach the internal telemetry
  services — it now runs unprivileged and fenced off) and three Low (servers held secrets their mode doesn't use,
  certbot outside Dependabot, no tests on dependency updates), all fixed the same day. The **2026-10-11** audit's three Medium gaps (container capabilities, SSH host-key pinning,
  HSTS) and seven Low items were all fixed.

Found a vulnerability? Please report it privately through GitHub's "Report a vulnerability" (Security tab), not in
a public issue.
