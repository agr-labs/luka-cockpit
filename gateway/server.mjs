#!/usr/bin/env node
// CLI entry for the Steadwell Robot Gateway.
//
//   node gateway/server.mjs
//   node gateway/server.mjs --port 8788 --allow-physical   (never do this yet)
//
// The console is served at /. The API is under /api/v1/.

import { createGateway } from './lib/gateway.mjs';

const args = process.argv.slice(2);

function arg(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Steadwell Robot Gateway

  --port <n>             listen port              (GATEWAY_PORT, default 8788)
  --host <addr>          bind address             (GATEWAY_HOST, default 127.0.0.1)
  --config <path>        robot config             (GATEWAY_CONFIG)
  --token <token>        require bearer auth      (GATEWAY_TOKEN)
  --telemetry-hz <n>     telemetry broadcast rate (default from config, 10)
  --allow-physical       permit verified physical writes (GATEWAY_ALLOW_PHYSICAL=1)

  Physical writes additionally require a verified adapter write path per
  capability. No adapter currently declares one.
`);
  process.exit(0);
}

const port = Number(arg('port', process.env.GATEWAY_PORT ?? 8788));
const host = arg('host', process.env.GATEWAY_HOST ?? '127.0.0.1');
const token = arg('token', process.env.GATEWAY_TOKEN ?? null);
const configPath = arg('config', process.env.GATEWAY_CONFIG);
const telemetryHz = Number(arg('telemetry-hz', process.env.GATEWAY_TELEMETRY_HZ ?? 10));
const allowPhysical = args.includes('--allow-physical') || process.env.GATEWAY_ALLOW_PHYSICAL === '1';

const gateway = await createGateway({
  ...(configPath ? { config: await loadConfigAt(configPath) } : {}),
  token: token || null,
  physicalEnabled: allowPhysical,
  telemetryHz,
});

const { url } = await gateway.listen(port, host);

// Give polling adapters one cycle before printing the table: an AimDK robot that
// is online should not be announced as offline just because the banner won a race.
await new Promise((resolve) => setTimeout(resolve, 1200));

console.log(`
  Steadwell Robot Gateway
  -----------------------
  console     ${url}/
  api         ${url}/api/v1
  telemetry   ws://${host}:${port}/api/v1/robots/<id>/telemetry
  auth        ${gateway.token ? 'bearer token required' : 'open (local development)'}
  physical    ${allowPhysical ? 'ENABLED at the gateway (still gated per capability)' : 'disabled'}

  robots:`);
for (const robot of gateway.registry.list()) {
  const status = gateway.registry.status(robot);
  const caps = gateway.registry.capabilityList(robot);
  console.log(`    ${robot.id.padEnd(12)} ${robot.adapterName.padEnd(10)} ${status.online ? 'online ' : 'offline'}  ` +
    `${caps.filter((c) => c.observable).length} observable · ${caps.filter((c) => c.commandable).length} commandable · ${robot.configuration}`);
}
console.log('');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('\n  shutting down…');
    await gateway.close();
    process.exit(0);
  });
}

async function loadConfigAt(path) {
  const { loadConfig } = await import('./lib/registry.mjs');
  return loadConfig(path);
}
