# Add a domain and HTTPS

Point a domain at your server and Mantle gets a free Let's Encrypt certificate by itself.

## Get a domain

Buy a domain from a registrar. Its DNS service then points a name at your server.

| Registrar and DNS | Notes |
|---|---|
| [Contabo](https://contabo.com/en/domains/) | Our recommendation when your server is at Contabo: domain, DNS and server in one panel. |
| [Cloudflare](https://www.cloudflare.com/products/registrar/) | Registrar and DNS. Set the record to **DNS only** (grey cloud), so the installer sees your server's IP. |
| [Namecheap](https://www.namecheap.com/) | Registrar with built-in DNS. |
| [Porkbun](https://porkbun.com/) | Registrar with built-in DNS. |

Create one record in the DNS settings:

| Type | Name | Value |
|---|---|---|
| A | `brain` (for `brain.example.com`), or `@` for `example.com` itself | Your server's IP address |

A new record can take a few minutes to reach everyone. `ping brain.example.com` shows the server's IP when it has.

## Before you start

- A DNS A record (or AAAA) for your domain, for example `brain.example.com`, pointing at the server's public address.
- Ports 80 and 443 open to the internet and not used by another web server. The certificate can only be issued on those two ports.

## At install

Run the [server install](03-server.md), choose **1, a domain with HTTPS**, and type the domain.

For a silent install, pass the domain as a variable. Use the `bash -c` form: in `curl ... | bash` the variable never reaches the installer.

```bash
MANTLE_YES=1 MANTLE_DOMAIN=brain.example.com \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/crossworks-engineering/mantle/main/install.sh)"
```

## Add it later

On a server installed without a domain:

1. Point the DNS record at the server and open ports 80 and 443.
2. Run the configurator from the install directory:

   ```bash
   cd mantle && bash scripts/install.sh --domain brain.example.com -y
   ```

The installer checks that the domain points at this server before it asks for a certificate, so a DNS typo cannot use up your Let's Encrypt attempts. Your secrets and data stay as they are. Later runs of the installer keep the domain, so you do not pass `--domain` again to change a component.

## Check it worked

Open `https://brain.example.com`. The certificate is issued on the first request, so the first load can take a few seconds.

## If it fails

- **The domain points somewhere else, or nowhere yet**: the installer offers to re-check, start on plain HTTP for now, or stop. A silent install falls back to HTTP. Fix the DNS record, then run the `--domain` command above again.
- **Port 80 or 443 is taken by nginx or Apache**: free the ports, or keep your web server in front of Mantle:

  ```bash
  bash scripts/install.sh --behind-proxy --domain brain.example.com
  ```

  Mantle then serves plain HTTP on `127.0.0.1:8080` (or the next free port). Point your web server at that address, forward the `Host` header, and let it handle HTTPS.
- **You want to drop the domain**: run `bash scripts/install.sh --lan -y` for HTTP on the network, or `--localhost` for this machine only.

## Next

- [Create your account](../02-first-steps/01-create-account.md)
