#!/usr/bin/env bash
# Create (or update) the Hetzner VM with Terraform, then write the Ansible inventory and pin its SSH host keys.
# Re-run it when your public IP changes: the firewall only lets SSH in from allowed_ssh_cidrs.
#   --destroy   delete the server (after setting protection = false in terraform.tfvars and re-running without it)
# Needs HCLOUD_TOKEN (Hetzner Cloud console → project → Security → API tokens, read & write). The server accepts one
# SSH key, used only for it: ~/.ssh/id_cipheroom (created here if missing) or CIPHEROOM_SSH_KEY=<private key path>.
# Guide: docs/deployment-hetzner.md
source "$(dirname "$0")/_common.sh"

TF_DIR="$DEPLOY_DIR/terraform/hetzner"
ANSIBLE_DIR="$DEPLOY_DIR/ansible"
DESTROY=false
for arg in "$@"; do
  case "$arg" in
    --destroy) DESTROY=true ;;
    *) die "unknown option: $arg (use --destroy)" ;;
  esac
done

command -v terraform >/dev/null || die "terraform missing — brew install terraform"
[[ -n "${HCLOUD_TOKEN:-}" ]] || die "export HCLOUD_TOKEN (Hetzner Cloud console → Security → API tokens, read & write)"
tf() { terraform -chdir="$TF_DIR" "$@"; }

# A key only for this server: if it ever leaks, nothing else is exposed.
SSH_KEY="${CIPHEROOM_SSH_KEY:-$HOME/.ssh/id_cipheroom}"
if [[ ! -f "$SSH_KEY.pub" && "$DESTROY" != true ]]; then
  info "Creating $SSH_KEY for this server (a passphrase is recommended; ssh-agent remembers it per session)"
  ssh-keygen -t ed25519 -f "$SSH_KEY" -C "cipheroom-server"
fi
VARS=(-var "ssh_public_key_path=$SSH_KEY.pub")

# SSH is allowed only from allowed_ssh_cidrs: unless terraform.tfvars sets it, use this machine's public address
# (asked from Cloudflare, which the stack already depends on).
if ! grep -Eq '^[[:space:]]*allowed_ssh_cidrs' "$TF_DIR/terraform.tfvars" 2>/dev/null; then
  ip="$(curl -fsS --max-time 10 https://1.1.1.1/cdn-cgi/trace | sed -n 's/^ip=//p')"
  [[ -n "$ip" ]] || die "couldn't detect your public IP — set allowed_ssh_cidrs in $TF_DIR/terraform.tfvars"
  if [[ "$ip" == *:* ]]; then cidr="$ip/128"; else cidr="$ip/32"; fi
  info "SSH allowed from $cidr (this machine)"
  VARS+=(-var "allowed_ssh_cidrs=[\"$cidr\"]")
fi

# Media mode from the env files (deploy/.env.hetzner over deploy/.env): LiveKit mode opens its media ports.
mode_in() { [[ -f "$2" ]] && grep -E "^$1=" "$2" | tail -1 | cut -d= -f2- || true; }
media_mode="$(mode_in MEDIA_MODE "$DEPLOY_DIR/.env.hetzner")"
[[ -n "$media_mode" ]] || media_mode="$(mode_in MEDIA_MODE "$DEPLOY_DIR/.env")"
VARS+=(-var "media_mode=${media_mode:-cloudflare}")
info "Media mode: ${media_mode:-cloudflare}"

tf init -input=false >/dev/null

if [[ "$DESTROY" == true ]]; then
  tf state show hcloud_server.server >/dev/null 2>&1 || die "no server in the Terraform state"
  if tf state show hcloud_server.server | grep -Eq 'delete_protection[[:space:]]*=[[:space:]]*true'; then
    die "delete protection is on: set protection = false in $TF_DIR/terraform.tfvars, run scripts/provision.sh, then --destroy"
  fi
  name="$(tf output -raw server_name)"
  warn "This permanently deletes server '$name' (Grafana history and the usage-guard estimate on it go too)."
  printf 'Type the server name to confirm: '
  read -r answer
  [[ "$answer" == "$name" ]] || die "not confirmed"
  tf destroy -input=false "${VARS[@]}"
  rm -f "$ANSIBLE_DIR/inventory.ini" "$ANSIBLE_DIR/known_hosts"
  info "Server deleted. Remove its tunnel in Cloudflare Zero Trust if you don't need it any more."
  exit 0
fi

hcloud_api() { curl -fsS --max-time 20 -H "Authorization: Bearer $HCLOUD_TOKEN" "$@"; }
server_status() {
  hcloud_api "https://api.hetzner.cloud/v1/servers/$1" | python3 -c 'import json, sys; print(json.load(sys.stdin)["server"]["status"])'
}

# Hetzner powers the server off before it places a new server type; without capacity the resize fails and the server
# stays off. So check availability first (only a hint, not a guarantee) and power it back on if the apply fails anyway.
server_id=""
if tf state show hcloud_server.server >/dev/null 2>&1; then
  server_id="$(tf output -raw server_id)"
  state="$(tf state show -no-color hcloud_server.server)"
  current_type="$(sed -nE 's/^[[:space:]]*server_type[[:space:]]*=[[:space:]]*"(.*)"$/\1/p' <<<"$state" | head -1)"
  location="$(sed -nE 's/^[[:space:]]*location[[:space:]]*=[[:space:]]*"(.*)"$/\1/p' <<<"$state" | head -1)"
  wanted_type="$(echo 'var.server_type' | tf console "${VARS[@]}" | tr -d '"')"
  if [[ -n "$wanted_type" && "$wanted_type" != "$current_type" ]]; then
    available="$(hcloud_api "https://api.hetzner.cloud/v1/server_types?name=$wanted_type" | LOCATION="$location" python3 -c '
import json, os, sys
types = json.load(sys.stdin)["server_types"]
locations = types[0].get("locations") or [] if types else []
print("yes" if any(l["name"] == os.environ["LOCATION"] and l.get("available") for l in locations) else "no")')" \
      || die "couldn't ask Hetzner whether $wanted_type is available in $location"
    [[ "$available" == yes ]] || die "$wanted_type isn't available in $location right now (the resize would fail with the server powered off) — try again later or set another server_type in terraform.tfvars"
    warn "Resizing $current_type → $wanted_type: the server is powered off for a minute or two"
  fi
fi

if ! tf apply -input=false "${VARS[@]}"; then
  if [[ -n "$server_id" ]] && [[ "$(server_status "$server_id" || true)" == off ]]; then
    warn "Terraform failed with the server powered off — powering it back on"
    hcloud_api -X POST "https://api.hetzner.cloud/v1/servers/$server_id/actions/poweron" >/dev/null \
      || warn "couldn't power it on: Hetzner Cloud console → the server → Power → Power on"
  fi
  die "terraform apply failed (see above)"
fi

ipv4="$(tf output -raw ipv4)"
server_id="$(tf output -raw server_id)"
user="$(tf output -raw admin_user)"
name="$(tf output -raw server_name)"

cat > "$ANSIBLE_DIR/inventory.ini" <<EOF
# Generated by scripts/provision.sh — don't edit (gitignored).
[servers]
$name ansible_host=$ipv4 ansible_user=$user ansible_ssh_private_key_file=$SSH_KEY hcloud_server_id=$server_id
EOF

# Host keys are pinned once per server (trust on first use, right after creation) and only checked after that: a later
# run (new IP allowance, resize) must not trust whatever answers, or a machine in the middle would get the .env that
# deploy.sh copies. The pin records the server id, so a new server gets a fresh pin. A fresh server may need a moment.
info "Waiting for SSH on $ipv4"
keys=""
for _ in $(seq 1 30); do
  keys="$(ssh-keyscan -T 5 -t ed25519,ecdsa,rsa "$ipv4" 2>/dev/null || true)"
  [[ -n "$keys" ]] && break
  sleep 5
done
[[ -n "$keys" ]] || die "SSH on $ipv4 didn't answer — check allowed_ssh_cidrs, then re-run"

KNOWN_HOSTS="$ANSIBLE_DIR/known_hosts"
pin_marker="# cipheroom server $server_id"
key_set() { awk '!/^#/ && NF >= 3 { print $2, $3 }' | sort -u; }
if [[ -f "$KNOWN_HOSTS" ]] && { grep -qxF "$pin_marker" "$KNOWN_HOSTS" || ! grep -q '^# cipheroom server ' "$KNOWN_HOSTS"; }; then
  # Pinned for this server (or by an older provision.sh, which didn't record the id): every key it shows must be pinned.
  unexpected="$(comm -13 <(key_set <"$KNOWN_HOSTS") <(key_set <<<"$keys"))"
  [[ -z "$unexpected" ]] || die "$ipv4 answers with host keys that aren't pinned in deploy/ansible/known_hosts — possibly someone in the middle. Don't deploy. If you rebuilt the server yourself, delete that file and re-run."
  if ! grep -qxF "$pin_marker" "$KNOWN_HOSTS"; then
    { echo "$pin_marker"; grep -v '^#' "$KNOWN_HOSTS"; } >"$KNOWN_HOSTS.tmp" && mv "$KNOWN_HOSTS.tmp" "$KNOWN_HOSTS"
  fi
  info "Host keys match the pin"
else
  { echo "$pin_marker"; printf '%s\n' "$keys"; } >"$KNOWN_HOSTS"
  info "Pinned the new server's host keys"
fi

info "Server $name is at $ipv4 (ssh -i $SSH_KEY $user@$ipv4) — next: scripts/deploy.sh (docs/deployment-hetzner.md)"
warn "It costs money while it exists (server + IPv4, billed by Hetzner — see docs/deployment-hetzner.md); scripts/provision.sh --destroy removes it"
