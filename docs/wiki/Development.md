# Development

## Toolchain

.NET 10 SDK, Node.js LTS, Docker. `scripts/doctor.sh` checks them. Optional: `terraform`, `ansible`, `ansible-lint`,
`shellcheck` (lint uses them when they're installed).

## Run it

```bash
scripts/dev.sh              # api on :5080 (dotnet watch) + Angular on :4200 + LiveKit in Docker
scripts/dev.sh --cloudflare # Cloudflare Realtime SFU/TURN from deploy/.env instead
```

Open http://localhost:4200, create a **New Meeting**, and open the invite link in a second window: it knocks, and you
let it in from the People panel. To test cameras from another device on your LAN, `scripts/certs.sh` creates local
HTTPS certificates.

## Checks

| Command | What |
|---|---|
| `scripts/test.sh [--server\|--web]` | xUnit v3 (one project per layer) and Angular tests |
| `scripts/lint.sh` | `dotnet format`, compose/observability config, Terraform, Ansible, shellcheck |
| `scripts/security-check.sh [url]` | Secrets, `.env` hygiene, NuGet/npm advisories, live headers |

## How the code is organised

- **Backend**: Clean Architecture (`src/`: Domain → Application → Infrastructure → Api). Thin SignalR hub methods
  each send one Mediator command or query, every input is validated with FluentValidation, and errors map to safe
  messages.
- **Frontend**: Angular standalone components and signals. `SignalingService`, `MediaService` and `CryptoService`
  are the boundaries; all crypto lives in `web/src/app/core/crypto/`.
- **Signaling contract**: any hub method or event change updates C#, TypeScript and
  [`docs/signaling-protocol.md`](https://github.com/Alex-Fix/cipheroom/blob/main/docs/signaling-protocol.md) together.

## Making changes

New features start as a short design in [`docs/plans/`](https://github.com/Alex-Fix/cipheroom/tree/main/docs/plans).
The non-negotiable rules are in [`CLAUDE.md`](https://github.com/Alex-Fix/cipheroom/blob/main/CLAUDE.md): keys never touch a server, servers are untrusted for
content, no secrets in git, free and open-source dependencies only. Before a PR, `scripts/test.sh` and
`scripts/lint.sh` must pass.
