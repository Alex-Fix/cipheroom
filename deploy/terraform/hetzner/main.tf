# One VM running Cipheroom (docs/deployment-hetzner.md). The website and signaling need no inbound ports — the
# Cloudflare tunnel dials out — so the firewall lets SSH in from allowed_ssh_cidrs only; in LiveKit mode also the
# media server's ports and TURN, from anywhere (browsers connect to them directly).

# Looked up first so a wrong or unavailable image name fails at plan time, before anything is created.
data "hcloud_image" "os" {
  name              = var.image
  with_architecture = "x86"
  most_recent       = true
}

resource "hcloud_ssh_key" "admin" {
  name       = "${var.name}-admin"
  public_key = file(pathexpand(var.ssh_public_key_path))
}

resource "hcloud_firewall" "server" {
  name = "${var.name}-ssh-only"

  rule {
    description = "SSH from the operator"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.allowed_ssh_cidrs
  }

  dynamic "rule" {
    for_each = var.media_mode == "livekit" ? local.livekit_ports : []
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
  # LiveKit single-port media and its built-in TURN (deploy/livekit/livekit.yaml).
  livekit_ports = [
    { description = "LiveKit media (UDP)", protocol = "udp", port = "7882" },
    { description = "LiveKit media (TCP fallback)", protocol = "tcp", port = "7881" },
    { description = "TURN (UDP)", protocol = "udp", port = "3478" },
    { description = "TURN over TLS", protocol = "tcp", port = "443" },
    { description = "TURN relay ports", protocol = "udp", port = "30000-30100" },
  ]
}

resource "hcloud_server" "server" {
  name         = var.name
  server_type  = var.server_type
  location     = var.location
  image        = data.hcloud_image.os.id
  ssh_keys     = [hcloud_ssh_key.admin.id]
  firewall_ids = [hcloud_firewall.server.id]
  user_data = templatefile("${path.module}/cloud-init.yaml", {
    admin_user = var.admin_user
    public_key = trimspace(file(pathexpand(var.ssh_public_key_path)))
  })

  # IPv4 stays on: GHCR (GitHub) has no IPv6, so image pulls need it.
  public_net {
    ipv4_enabled = true
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
