# Get a server

Rent a small Linux server, add your SSH key and connect to it. Most of it is copy and paste, and it is easier than it looks.

A VPS (virtual private server) is a Linux machine you rent by the month from a hosting company. It is always on and has its own public IP address, so you can reach your brain from anywhere.

## Pick a host

| Host | Notes |
|---|---|
| [Contabo](https://contabo.com/en/) | Our recommendation. Affordable, and it also sells domains and runs DNS, so the server, the domain and its record sit in one control panel. |
| [Hetzner](https://www.hetzner.com/cloud) | Data centres in Europe and the US. |
| [DigitalOcean](https://www.digitalocean.com/products/droplets) | Simple control panel, many regions. |
| [Vultr](https://www.vultr.com/products/cloud-compute/) | Many regions. |
| [OVHcloud](https://www.ovhcloud.com/en/vps/) | Data centres in Europe, North America and Asia. |

Any host that gives you a Linux server with root access works.

## Choose the size

| Shape | Memory | CPU | Disk |
|---|---|---|---|
| Full stack | 8 GB or more | 4 vCPU | 40 GB or more |
| [Small server](06-small-server.md) | 4 GB | 2 vCPU | 40 GB |

Pick **Ubuntu** (the latest LTS) as the operating system.

## Make an SSH key

An SSH key lets you sign in to the server without a password. You make it once, on your own computer.

1. Open Terminal (macOS, Linux) or PowerShell (Windows) and run:

   ```bash
   ssh-keygen -t ed25519
   ```

   Press Enter to accept each default.

2. Show the public half of the key and copy the whole line:

   ```bash
   cat ~/.ssh/id_ed25519.pub
   ```

   In PowerShell, use `type $env:USERPROFILE\.ssh\id_ed25519.pub`.

Never share the other file, `id_ed25519`. It is the private half.

## Order and connect

1. Order the server. Paste the public key where the host asks for an SSH key. At Contabo you set a password on the order, then add the key in the Customer Control Panel or when you install the operating system.
2. Wait for the email or panel page with the server's IP address.
3. Connect:

   ```bash
   ssh root@<ip>
   ```

   Type `yes` the first time, to trust the server.

4. Install Docker, which Mantle runs in:

   ```bash
   curl -fsSL https://get.docker.com | sh
   ```

## Check it worked

On the server, `docker compose version` prints a version number.

## Next

- [Add a domain](05-domain-https.md#get-a-domain), so the brain has a name and HTTPS.
- [Install on a server](03-server.md), or let an AI assistant do it: [Install with an AI assistant](04-ai-assistant.md).
