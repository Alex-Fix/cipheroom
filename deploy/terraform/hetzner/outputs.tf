output "server_id" {
  description = "For the usage guard in LiveKit mode (Hetzner traffic of this server)."
  value       = hcloud_server.server.id
}

output "server_name" {
  value = hcloud_server.server.name
}

output "ipv4" {
  value = hcloud_server.server.ipv4_address
}

output "ipv6" {
  value = hcloud_server.server.ipv6_address
}

output "admin_user" {
  value = var.admin_user
}

output "ssh_command" {
  value = "ssh ${var.admin_user}@${hcloud_server.server.ipv4_address}"
}
