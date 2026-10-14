variable "name" {
  description = "Server name (also the firewall and SSH key name prefix); a named server (Terraform workspace) appends -<name>."
  type        = string
  default     = "cipheroom"
}

variable "server_type" {
  description = "Hetzner server type (x86; the images are linux/amd64 only, so no CAX/Arm): cpx42 = 8 AMD vCPU, 16 GB. Cheaper when Hetzner has capacity: cx23 (2 vCPU, 4 GB), cx33 (4, 8 GB), cx43 (8, 16 GB). scripts/provision.sh checks availability before a resize."
  type        = string
  default     = "cpx42"
}

variable "keep_disk" {
  description = "Keep the disk size when server_type changes, so the server can be resized back down later."
  type        = bool
  default     = true
}

variable "location" {
  description = "Hetzner location (nbg1, fsn1, hel1, ...)."
  type        = string
  default     = "nbg1"
}

variable "image" {
  description = "OS image name. The Ansible roles target Ubuntu 26.04 LTS (24.04 works too)."
  type        = string
  default     = "ubuntu-26.04"
}

variable "ssh_public_key_path" {
  description = "Public key that may log in as the admin user — a key used only for this server (scripts/provision.sh passes it)."
  type        = string
  default     = "~/.ssh/id_cipheroom.pub"
}

variable "admin_user" {
  description = "Login user created by cloud-init (root login is disabled)."
  type        = string
  default     = "cipheroom"
}

variable "allowed_ssh_cidrs" {
  description = "Source ranges allowed to reach SSH (22/tcp) — nothing else is open. scripts/provision.sh fills in your current IP."
  type        = list(string)

  validation {
    condition     = length(var.allowed_ssh_cidrs) > 0 && alltrue([for c in var.allowed_ssh_cidrs : can(cidrhost(c, 0))])
    error_message = "Give at least one CIDR, e.g. [\"203.0.113.7/32\"]."
  }

  validation {
    condition     = !anytrue([for c in var.allowed_ssh_cidrs : contains(["0.0.0.0/0", "::/0"], c)])
    error_message = "SSH must not be open to the whole internet; list your own address(es)."
  }
}

variable "media_mode" {
  description = "cloudflare (only SSH is open) or livekit (also LiveKit's media ports and TURN, from anywhere). scripts/provision.sh passes MEDIA_MODE."
  type        = string
  default     = "cloudflare"

  validation {
    condition     = contains(["cloudflare", "livekit"], var.media_mode)
    error_message = "media_mode is cloudflare or livekit."
  }
}

variable "protection" {
  description = "Delete + rebuild protection (Hetzner requires both to match). Set false and apply before destroying."
  type        = bool
  default     = true
}
