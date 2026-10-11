#!/usr/bin/env bash
# Deploy (or update) Cipheroom on the server(s) in deploy/ansible/inventory.ini with images prebuilt in GHCR.
#   --tag <tag>       image tag: sha-<commit> (default: the last commit that changed the images), main, or a release tag
#                     — an older sha-<commit> rolls back
#   --no-observability  without the telemetry stack (on by default: Grafana at /grafana/; needs GRAFANA_ADMIN_PASSWORD)
#   --yes             don't ask before deploying without a separate tunnel
# Secrets: deploy/.env, with keys in deploy/.env.hetzner (optional) taking precedence. Guide: docs/deployment-hetzner.md
source "$(dirname "$0")/_common.sh"
require_env

ANSIBLE_DIR="$DEPLOY_DIR/ansible"
OVERLAY="$DEPLOY_DIR/.env.hetzner"
IMAGE_PREFIX="${CIPHEROOM_IMAGE_PREFIX:-ghcr.io/alex-fix/cipheroom}"
TAG=""
OBSERVABILITY=true
YES=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) [[ $# -ge 2 ]] || die "--tag needs a value"; TAG="$2"; shift ;;
    --no-observability) OBSERVABILITY=false ;;
    --observability) OBSERVABILITY=true ;; # the default; kept so older commands still work
    --yes) YES=true ;;
    *) die "unknown option: $1 (use --tag <tag>, --no-observability, --yes)" ;;
  esac
  shift
done

command -v ansible-playbook >/dev/null || die "ansible missing — brew install ansible"
[[ -f "$ANSIBLE_DIR/inventory.ini" ]] || die "deploy/ansible/inventory.ini missing — run scripts/provision.sh first"
[[ -f "$ANSIBLE_DIR/known_hosts" ]] || die "deploy/ansible/known_hosts missing — run scripts/provision.sh first"

# ── Which images ─────────────────────────────────────────────────────────────────────────────────────────────────────
# The same paths that trigger .github/workflows/images.yml: commits that change none of them get no images.
IMAGE_PATHS=(src web deploy/nginx global.json Directory.Build.props Directory.Packages.props .github/workflows/images.yml)
if [[ -z "$TAG" ]]; then
  commit="$(git -C "$ROOT" log -1 --format=%H -- "${IMAGE_PATHS[@]}")"
  TAG="sha-$commit"
  [[ -z "$(git -C "$ROOT" status --porcelain -- "${IMAGE_PATHS[@]}")" ]] \
    || warn "uncommitted changes in the app aren't in any image — deploying $TAG"
  [[ -n "$(git -C "$ROOT" branch -r --contains "$commit" 2>/dev/null)" ]] \
    || die "commit ${commit:0:12} isn't pushed, so GitHub hasn't built its images — push it and wait for the images workflow"
fi
[[ "$TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "invalid tag: $TAG"

# The server pulls anonymously: check both images exist and are public before touching it.
[[ "$IMAGE_PREFIX" =~ ^ghcr\.io/[a-z0-9._-]+/[a-z0-9._/-]+$ ]] || die "CIPHEROOM_IMAGE_PREFIX must be a lowercase ghcr.io/<owner>/<name> path"
repo="${IMAGE_PREFIX#ghcr.io/}"
for image in api web; do
  token="$(curl -fsS --max-time 15 "https://ghcr.io/token?scope=repository:$repo-$image:pull" 2>/dev/null \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p' || true)"
  # GHCR hands out no anonymous token for a package that is private or doesn't exist yet.
  [[ -n "$token" ]] || die "$IMAGE_PREFIX-$image isn't public or doesn't exist yet — after the images workflow's first
   run: GitHub → your profile → Packages → $(basename "$repo")-$image → Package settings → Change visibility → Public"
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -I \
    -H "Authorization: Bearer ${token:-none}" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json' \
    "https://ghcr.io/v2/$repo-$image/manifests/$TAG")"
  case "$status" in
    200) ;;
    404) die "$IMAGE_PREFIX-$image:$TAG not found — wait for the images workflow on GitHub (Actions), or pick another --tag" ;;
    401|403) die "$IMAGE_PREFIX-$image isn't public — GitHub → your profile → Packages → $(basename "$repo")-$image → Package settings → Change visibility → Public" ;;
    *) die "couldn't check $IMAGE_PREFIX-$image:$TAG on ghcr.io (HTTP $status)" ;;
  esac
done
info "Images $IMAGE_PREFIX-{api,web}:$TAG are in GHCR"

[[ -f "$OVERLAY" ]] && chmod 600 "$OVERLAY"

# ── One tunnel per deployment ────────────────────────────────────────────────────────────────────────────────────────
# Two stacks behind one tunnel token get requests balanced between them, and each keeps its own in-memory rooms, so
# calls break at random. Compared without printing either value.
value_in() { [[ -f "$2" ]] && grep -E "^$1=" "$2" | tail -1 | cut -d= -f2- || true; }
mode="$(value_in MEDIA_MODE "$OVERLAY")"
[[ -n "$mode" ]] || mode="$(value_in MEDIA_MODE "$DEPLOY_DIR/.env")"
info "Media mode: ${mode:-cloudflare}$([[ "$mode" == livekit ]] && echo " (run scripts/provision.sh first if you just switched: it opens LiveKit's ports)")"

home_token="$(value_in TUNNEL_TOKEN "$DEPLOY_DIR/.env")"
server_token="$(value_in TUNNEL_TOKEN "$OVERLAY")"
if [[ -z "$server_token" || "$server_token" == "$home_token" ]]; then
  warn "deploy/.env.hetzner has no TUNNEL_TOKEN of its own: the server would share the tunnel in deploy/.env."
  warn "If that stack is running too, calls break at random. Create a second tunnel and put it in deploy/.env.hetzner
  (cp deploy/.env.hetzner.example deploy/.env.hetzner; docs/deployment-hetzner.md)."
  if [[ "$YES" != true ]]; then
    printf "Type 'shared' to deploy anyway: "
    read -r answer
    [[ "$answer" == "shared" ]] || die "not confirmed"
  fi
fi
unset home_token server_token

if [[ "$OBSERVABILITY" == true ]]; then
  observability_json=true
else
  observability_json=false
  warn "observability off: telemetry services on the server (if any) are removed; their data volumes stay"
fi

# ── Run ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
cd "$ANSIBLE_DIR" || die "cannot enter $ANSIBLE_DIR"
ansible-galaxy collection install -r requirements.yml >/dev/null
ansible-playbook site.yml -e "{\"cipheroom_tag\": \"$TAG\", \"cipheroom_image_prefix\": \"$IMAGE_PREFIX\", \"cipheroom_observability\": $observability_json}"

host="$(value_in PUBLIC_HOST "$OVERLAY")"
[[ -n "$host" ]] || host="$(value_in PUBLIC_HOST "$DEPLOY_DIR/.env")"
info "Deployed $TAG — https://$host"
