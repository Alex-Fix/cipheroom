# Hetzner deployment

The same stack on a rented Hetzner Cloud server, for when there's no machine at home to leave on, or for a second
instance such as a beta. **This costs money** (billed by Hetzner); the home setup stays free. The full guide is
[`docs/deployment-hetzner.md`](https://github.com/Alex-Fix/cipheroom/blob/main/docs/deployment-hetzner.md).

## How it fits together

```
GitHub Actions ──push──▶ GHCR images (sha-<commit>)
Your laptop ── terraform ──▶ Hetzner server (Ubuntu 26.04, SSH from your IP only)
            ── ansible ────▶   Docker: api, web, cloudflared (+ LiveKit, + observability)
```

- `scripts/provision.sh` (Terraform) creates the server, a dedicated SSH key, and a firewall that only lets SSH in from
  your IP. In LiveKit mode the firewall also opens LiveKit's media and TURN ports.
- `scripts/deploy.sh` (Ansible) hardens the server (SSH, fail2ban, firewall, automatic security updates), installs
  Docker, copies the merged `.env` (mode 600, never printed), starts the stack, and checks it through the tunnel.

## First deploy (short version)

1. Push to `main`, wait for the *images* workflow, and make both GHCR packages public (once).
2. `export HCLOUD_TOKEN=…` (a read & write token from the Hetzner console; never put it in a file).
3. Give the server **its own tunnel**: `cp deploy/.env.hetzner.example deploy/.env.hetzner`, then fill in
   `TUNNEL_TOKEN` and `PUBLIC_HOST`. Two stacks behind one tunnel split calls at random.
4. `scripts/provision.sh`: review the plan, then confirm.
5. `scripts/deploy.sh`.

## Updating, rolling back, resizing

- `scripts/deploy.sh` deploys the last pushed commit that changed the app; `--tag sha-<older>` rolls back.
- **Resizing**: set `server_type` in `terraform.tfvars` and re-run `provision.sh`. The default is `cpx42` (8 AMD vCPU,
  16 GB); `cx23` (2 vCPU, 4 GB) is enough for a handful of people. Hetzner resizes in place, with the same IP, after
  powering the server off for a minute or two. Hetzner sometimes has no capacity for a type: `provision.sh` checks
  first and refuses instead of leaving the server powered off. The disk keeps its size (`keep_disk`), so you can
  resize back down.
- **Your IP changed?** Re-run `provision.sh`; it updates the SSH rule.
- **Host keys** are pinned once, when the server is created. If `provision.sh` says the server shows keys that
  aren't pinned, don't deploy: someone may be intercepting the connection. Delete `deploy/ansible/known_hosts` only
  if you rebuilt the server yourself.

## What Hetzner can see

The same as any host of the api: IP addresses, timing, pseudonymous room activity. Media, chat, files and keys stay
end-to-end encrypted. See [[Security model]].
