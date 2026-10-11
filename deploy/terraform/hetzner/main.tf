# One VM running the Cloudflare deployment mode (docs/deployment-hetzner.md). The app needs no inbound ports — the
# Cloudflare tunnel dials out — so the firewall only lets SSH in, and only from allowed_ssh_cidrs.

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
}

resource "hcloud_server" "server" {
  name         = var.name
  server_type  = var.server_type
  location     = var.location
  image        = var.image
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
