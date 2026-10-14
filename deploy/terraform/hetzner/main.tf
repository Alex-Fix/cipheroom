# One VM running Cipheroom (docs/deployment-hetzner.md). The website and signaling need no inbound ports — the
# Cloudflare tunnel dials out — so the firewall lets SSH in from allowed_ssh_cidrs only; in LiveKit mode also the
# media server's ports and TURN, from anywhere (browsers connect to them directly). With ingress_mode = direct the
# server answers HTTPS itself on its IP (80 for the certificate check, 443 shared with TURN over TLS), and that IP is
# a separate Primary IP so a rebuilt server keeps it — the IP is the site's address and its browsers' origin.

# Looked up first so a wrong or unavailable image name fails at plan time, before anything is created.
data "hcloud_image" "os" {
  name              = var.image
  with_architecture = "x86"
  most_recent       = true
}

resource "hcloud_ssh_key" "admin" {
  name       = "${local.name}-admin"
  public_key = file(pathexpand(var.ssh_public_key_path))
}

resource "hcloud_firewall" "server" {
  name = "${local.name}-server"

  rule {
    description = "SSH from the operator"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.allowed_ssh_cidrs
  }

  dynamic "rule" {
    for_each = concat(var.media_mode == "livekit" ? local.livekit_ports : [], local.direct_ports)
    content {
      description = rule.value.description
      direction   = "in"
      protocol    = rule.value.protocol
      port        = rule.value.port
      source_ips  = ["0.0.0.0/0", "::/0"]
    }
  }
}

locals {
  # One server per Terraform workspace (scripts/provision.sh --server <name>): `default` keeps the plain name.
  name = terraform.workspace == "default" ? var.name : "${var.name}-${terraform.workspace}"

  # LiveKit single-port media and its built-in TURN (deploy/livekit/livekit.yaml).
  livekit_ports = [
    { description = "LiveKit media (UDP)", protocol = "udp", port = "7882" },
    { description = "LiveKit media (TCP fallback)", protocol = "tcp", port = "7881" },
    { description = "TURN (UDP)", protocol = "udp", port = "3478" },
    { description = local.direct ? "HTTPS + TURN over TLS (edge)" : "TURN over TLS", protocol = "tcp", port = "443" },
    { description = "TURN relay ports", protocol = "udp", port = "30000-30100" },
  ]

  # Direct ingress: the edge proxy also answers HTTP; 443 (above) is then shared by HTTPS and TURN over TLS.
  direct = var.ingress_mode == "direct"
  direct_ports = local.direct ? [
    { description = "HTTP (certificate check, redirect to HTTPS)", protocol = "tcp", port = "80" },
  ] : []
}

resource "hcloud_primary_ip" "ipv4" {
  count    = local.direct ? 1 : 0
  name     = "${local.name}-ipv4"
  type     = "ipv4"
  location = var.location
  # Outlives the server (a rebuild keeps the address and so the origin); provision.sh --destroy removes it too.
  auto_delete       = false
  delete_protection = var.protection

  labels = {
    app = "cipheroom"
  }
}

resource "hcloud_server" "server" {
  name         = local.name
  server_type  = var.server_type
  location     = var.location
  image        = data.hcloud_image.os.id
  ssh_keys     = [hcloud_ssh_key.admin.id]
  firewall_ids = [hcloud_firewall.server.id]
  # A server_type change resizes in place (powered off for a minute or two). Keeping the disk keeps it reversible:
  # Hetzner never shrinks a disk, so a grown one would rule out going back to a smaller type.
  keep_disk = var.keep_disk
  user_data = templatefile("${path.module}/cloud-init.yaml", {
    admin_user = var.admin_user
    public_key = trimspace(file(pathexpand(var.ssh_public_key_path)))
  })

  # IPv4 stays on: GHCR (GitHub) has no IPv6, so image pulls need it.
  public_net {
    ipv4_enabled = true
    ipv4         = local.direct ? hcloud_primary_ip.ipv4[0].id : null
    ipv6_enabled = true
  }

  # No Hetzner backups: the server keeps no data worth restoring (amnesiac api; only the usage-guard estimate).
  backups            = false
  delete_protection  = var.protection
  rebuild_protection = var.protection

  labels = {
    app = "cipheroom"
  }

  lifecycle {
    # These only apply at creation; changing them later would replace the server. Ansible manages it from then on.
    ignore_changes = [user_data, ssh_keys, image]
  }
}
