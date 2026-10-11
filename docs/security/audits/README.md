# Security audits

Full audits of the application and a running server, done with the `security-audit` skill
(`.claude/skills/security-audit/SKILL.md`): passes A–F, severities, one report per audit. The rules being checked
live in the `security` and `e2ee-media` skills.

| Date | Scope | Result |
|---|---|---|
| [2026-10-11](2026-10-11.md) | App at `4827b28` + hardening branch; Hetzner cpx42, LiveKit mode | 0 Critical/High · 3 Medium (fixed) · 7 Low · 3 Info |

Findings that were open when a report was written are described at the class level only.
