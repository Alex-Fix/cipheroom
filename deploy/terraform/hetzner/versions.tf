terraform {
  required_version = ">= 1.9"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.70"
    }
  }
}

# The API token comes only from the HCLOUD_TOKEN environment variable — never from tfvars or state.
provider "hcloud" {}
