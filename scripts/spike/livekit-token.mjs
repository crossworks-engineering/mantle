#!/usr/bin/env node
// Mints a LiveKit join token for the P0 calls spike (plan page section 15).
//
//   LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... node scripts/spike/livekit-token.mjs <room> <identity> [name]
//
// With LIVEKIT_SITE=<host> set it also prints the full spike-page URL. The
// key and secret come from the spike's livekit.yaml on the box and never go
// into a file in this repo. Grants: join, publish the microphone only,
// subscribe. One hour. No admin, no data, no recording.
import { AccessToken, TrackSource } from 'livekit-server-sdk';

const key = process.env.LIVEKIT_API_KEY;
const secret = process.env.LIVEKIT_API_SECRET;
const site = process.env.LIVEKIT_SITE;
const [
  room = 'spike',
  identity = `user-${Math.random().toString(36).slice(2, 8)}`,
  name = identity,
] = process.argv.slice(2);

if (!key || !secret) {
  console.error('set LIVEKIT_API_KEY and LIVEKIT_API_SECRET');
  process.exit(2);
}

const at = new AccessToken(key, secret, { identity, name, ttl: '1h' });
at.addGrant({
  room,
  roomJoin: true,
  canPublish: true,
  canSubscribe: true,
  canPublishData: false,
  canPublishSources: [TrackSource.MICROPHONE], // the SDK wants the enum, not the string 'microphone'
});
const jwt = await at.toJwt();

if (site) {
  const url = `wss://${site}/livekit`;
  const page = new URL(`https://${site}/calls-spike/`);
  page.searchParams.set('url', url);
  page.searchParams.set('token', jwt);
  console.log(page.toString());
} else {
  console.log(jwt);
}
