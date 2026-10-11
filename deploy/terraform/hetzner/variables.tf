variable "name" {
  description = "Server name (also the firewall and SSH key name prefix)."
  type        = string
  default     = "cipheroom"
}

variable "server_type" {
  description = "Hetzner server type: cx23 = smallest shared x86 (2 vCPU, 4 GB). The images are linux/amd64 only, so no CAX (Arm)."
  type        = string
  default     = "cx23"
}

variable "location" {
  description = "Hetzner location (nbg1, fsn1, hel1, ...)."
  type        = string
  default     = "nbg1"
}

variable "image" {
  description = "OS image. The Ansible roles target Ubuntu 24.04."
  type        = string
  default     = "ubuntu-24.04"
}

variable "ssh_public_key_path" {
  description = "Public key that may log in as the admin user."
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
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

variable "protection" {
  description = "Delete + rebuild protection (Hetzner requires both to match). Set false and apply before destroying."
  type        = bool
  default     = true
}
