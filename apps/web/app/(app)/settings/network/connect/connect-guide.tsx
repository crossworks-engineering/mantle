'use client';

import Link from 'next/link';
import { ArrowLeft, ExternalLink, Network, Server, Plug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CopyBlock } from '@/components/ui/copy-button';

const TS_KEYS_URL = 'https://login.tailscale.com/admin/settings/keys';
const TS_DOWNLOAD_URL = 'https://tailscale.com/download';
const TS_MACHINES_URL = 'https://login.tailscale.com/admin/machines';

/** External link with a trailing icon. */
function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 underline underline-offset-2"
    >
      {children}
      <ExternalLink className="size-3" />
    </a>
  );
}

/** A numbered step with a heading + body. */
function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="relative pl-9">
      <span className="absolute left-0 top-0 flex size-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
        {n}
      </span>
      <div className="space-y-2">
        <p className="font-medium leading-6">{title}</p>
        <div className="space-y-2 text-sm text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

export function ConnectGuide() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-1">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2 gap-1.5 text-muted-foreground">
          <Link href="/settings/network">
            <ArrowLeft className="size-4" />
            Local network
          </Link>
        </Button>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Network className="size-5 text-muted-foreground" />
          Connect a device
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Put a machine you own — a home GPU box, a LAN server running Ollama or LM Studio — on the
          same private network as Mantle, so a chat or vision route can reach it by name even when
          it&apos;s behind NAT. No port-forwarding, no public IPs.
        </p>
      </div>

      {/* ── Mental model ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">How it works</CardTitle>
          <CardDescription>
            A <strong>tailnet</strong> is your own private mesh. Each machine on it is a{' '}
            <strong>node</strong> and they reach each other by name (MagicDNS), wherever they
            physically are. You connect two nodes:
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-start gap-3 rounded-md border border-border p-3">
            <Server className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="space-y-0.5 text-sm">
              <p className="font-medium">The Mantle host</p>
              <p className="text-muted-foreground">
                Joins via the bundled <code className="font-mono">tailscale</code> sidecar (an auth
                key in <code className="font-mono">.env</code>).
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-md border border-border p-3">
            <Plug className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="space-y-0.5 text-sm">
              <p className="font-medium">Your model box</p>
              <p className="text-muted-foreground">
                Joins via the normal Tailscale app/CLI. Runs Ollama / LM Studio.
              </p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            They&apos;re linked by being signed into the <strong>same Tailscale account</strong>. The
            free tier covers up to 100 devices.
          </p>
        </CardContent>
      </Card>

      {/* ── Step 1: the model box, per platform ──────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">1 · Put your model box on the tailnet</CardTitle>
            <Badge variant="outline">on the box</Badge>
          </div>
          <CardDescription>
            Install Tailscale and sign in. Pick the box&apos;s OS — first, create a free account at{' '}
            <Ext href="https://tailscale.com">tailscale.com</Ext> if you don&apos;t have one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="linux">
            <TabsList>
              <TabsTrigger value="linux">Linux</TabsTrigger>
              <TabsTrigger value="macos">macOS</TabsTrigger>
              <TabsTrigger value="windows">Windows</TabsTrigger>
            </TabsList>

            <TabsContent value="linux" className="space-y-3">
              <p className="text-sm text-muted-foreground">Install, then bring it up and sign in:</p>
              <CopyBlock
                code={`curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up        # prints a URL — open it, sign in
tailscale status         # confirm it joined`}
              />
              <p className="text-xs text-muted-foreground">
                Headless server? Skip the browser login with an auth key:{' '}
                <code className="font-mono">sudo tailscale up --authkey tskey-...</code> (generate
                one — see step 2).
              </p>
              <p className="text-xs text-muted-foreground">
                If the box runs a firewall (<code className="font-mono">ufw</code> /{' '}
                <code className="font-mono">firewalld</code>), trust the tailnet interface:{' '}
                <code className="font-mono">sudo ufw allow in on tailscale0</code>.
              </p>
            </TabsContent>

            <TabsContent value="macos" className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Install the menu-bar app — it runs the background service for you — then sign in from
                its icon:
              </p>
              <CopyBlock
                code={`brew install --cask tailscale   # the menu-bar app (recommended)
open -a Tailscale                # then click the icon → Log in`}
              />
              <p className="text-xs text-muted-foreground">
                No Homebrew? Download the app from the{' '}
                <Ext href={TS_DOWNLOAD_URL}>Tailscale site</Ext> or the Mac App Store — same thing.
              </p>
              <p className="text-xs text-muted-foreground">
                Heads-up: the CLI-only formula (<code className="font-mono">brew install tailscale</code>){' '}
                does <strong>not</strong> start the background daemon, so{' '}
                <code className="font-mono">tailscale up</code> fails with “is Tailscale running?”. If
                you hit that, switch to the app:
              </p>
              <CopyBlock
                code={`brew uninstall tailscale
brew install --cask tailscale
open -a Tailscale`}
              />
            </TabsContent>

            <TabsContent value="windows" className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Download the installer from the{' '}
                <Ext href={TS_DOWNLOAD_URL}>Tailscale site</Ext>, run it, then sign in from the
                system-tray icon. That&apos;s the whole join.
              </p>
              <p className="text-xs text-muted-foreground">
                If Windows Defender Firewall is on, allow inbound on your model server&apos;s port
                (e.g. TCP 1234 for LM Studio, 11434 for Ollama) so the tailnet can reach it.
              </p>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* ── Step 2: serve + auth key ─────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">2 · Serve the model + grab an auth key</CardTitle>
            <Badge variant="outline">on the box + console</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="space-y-1.5">
            <p className="font-medium">Make the model server listen on all interfaces</p>
            <p className="text-muted-foreground">
              Bind it to <code className="font-mono">0.0.0.0</code>, not{' '}
              <code className="font-mono">127.0.0.1</code> — otherwise it only answers the box
              itself and the tailnet can&apos;t reach it. Ollama does this by default; in LM
              Studio, enable <em>serve on local network</em>. Note the port (
              <code className="font-mono">11434</code> Ollama, <code className="font-mono">1234</code>{' '}
              LM Studio).
            </p>
          </div>
          <div className="space-y-1.5">
            <p className="font-medium">Generate an auth key for the Mantle host</p>
            <p className="text-muted-foreground">
              In the <Ext href={TS_KEYS_URL}>Tailscale admin console → Keys</Ext>, generate an{' '}
              <strong>auth key</strong>. Make it <strong>Reusable</strong> (survives redeploys) and
              leave <strong>Ephemeral off</strong> (the host should be a stable node). Copy the{' '}
              <code className="font-mono">tskey-auth-…</code> value for the next step.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ── Step 3: the Mantle host ──────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">3 · Bring up the Mantle sidecar</CardTitle>
            <Badge variant="outline">on the Mantle host</Badge>
          </div>
          <CardDescription>
            Put the auth key in <code className="font-mono">.env</code> (next to{' '}
            <code className="font-mono">docker-compose.yml</code>) and start the optional{' '}
            <code className="font-mono">tailnet</code> profile.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <CopyBlock
            code={`# .env
TS_AUTHKEY=tskey-auth-xxxxxxxxxxxx
TS_HOSTNAME=mantle-host          # this node's name on your tailnet

# start just the tailnet sidecar (or include it in your normal up):
docker compose --profile tailnet up -d`}
          />
          <p className="text-xs text-muted-foreground">
            The <code className="font-mono">tailnet</code> profile is off by default — a normal{' '}
            <code className="font-mono">docker compose up</code> never touches it. The node&apos;s
            identity persists in a volume, so the key only matters on first join / fresh redeploy.
          </p>
        </CardContent>
      </Card>

      {/* ── Step 4: wire it up in Mantle ─────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">4 · Point a route at it</CardTitle>
            <Badge variant="outline">in Mantle</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <ol className="space-y-3">
            <Step n={1} title="Check the connection">
              <p>
                Open <Link href="/settings/network" className="underline">Local network</Link>. It
                should read <strong>Running</strong>, with your model box listed under{' '}
                <strong>Reachable devices</strong> (green dot = online). Names also appear in the{' '}
                <Ext href={TS_MACHINES_URL}>admin console</Ext>.
              </p>
            </Step>
            <Step n={2} title="Set the route">
              <p>
                On{' '}
                <Link href="/settings/ai-workers" className="underline">
                  AI workers
                </Link>{' '}
                or{' '}
                <Link href="/settings/agents" className="underline">
                  Agents
                </Link>
                , edit a route, set its provider to <code className="font-mono">local</code>, and in{' '}
                <strong>Base URL</strong> pick your box from the dropdown (e.g.{' '}
                <code className="font-mono">http://my-box.tailXXXX.ts.net:11434/v1</code>).
              </p>
            </Step>
            <Step n={3} title="Flip “Reach via Tailscale” on">
              <p>
                This routes the request through the tailnet — required when the Mantle host
                can&apos;t reach the box on the local LAN (e.g. a cloud VPS reaching your home box).
                On the same LAN, you can leave it off and use the box&apos;s LAN IP directly. Save —
                done.
              </p>
            </Step>
          </ol>
        </CardContent>
      </Card>

      <p className="px-1 text-xs text-muted-foreground">
        Device, key, and ACL management all live in the{' '}
        <Ext href={TS_MACHINES_URL}>Tailscale console</Ext> — Mantle just reads the connection and
        never stores your auth key in its database.
      </p>
    </div>
  );
}
