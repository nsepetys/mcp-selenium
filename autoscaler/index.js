'use strict';

const { execFileSync } = require('child_process');
const net = require('net');

const PROJECT        = process.env.COMPOSE_PROJECT        || 'selenium-mcp';
const NETWORK        = process.env.DOCKER_NETWORK         || `${PROJECT}_default`;
const VOLUME         = process.env.DOCKER_VOLUME          || `${PROJECT}_selenium-data`;
const IMAGE          = process.env.WORKER_IMAGE           || 'selenium-mcp';
const MIN_WORKERS    = parseInt(process.env.MIN_WORKERS    || '2',      10);
const MAX_WORKERS    = parseInt(process.env.MAX_WORKERS    || '10',     10);
const IDLE_TIMEOUT   = parseInt(process.env.SCALE_DOWN_IDLE_MS || '120000', 10);
const POLL_MS        = parseInt(process.env.POLL_INTERVAL_MS   || '30000',  10);
const WORKER_MEMORY  = process.env.WORKER_MEMORY          || '2g';
const WORKER_MEMORY_SWAP = process.env.WORKER_MEMORY_SWAP || WORKER_MEMORY;
// HAProxy runtime API (stats socket in haproxy.cfg) and the backend it serves.
const [HAPROXY_HOST, HAPROXY_PORT] = (process.env.HAPROXY_ADMIN || 'haproxy:9999').split(':');
const BACKEND        = process.env.HAPROXY_BACKEND        || 'selenium_fleet';
const SERVER_OPTS    = 'check inter 10s rise 2 fall 2';

// selenium-1 and selenium-2 are permanent compose services — autoscaler never starts/stops them.
// selenium-3 and up are dynamic — created/removed by the autoscaler, and registered in
// HAProxy through its runtime API.
//
// Nothing here resolves worker names through DNS: worker IPs come from docker inspect.
// On 2026-10-22 HAProxy polling Docker DNS every second for absent selenium-N names
// flooded dockerd's error log until its stderr pipe filled and the engine deadlocked.
const PERMANENT = Array.from({ length: MIN_WORKERS },              (_, i) => `selenium-${i + 1}`);
const DYNAMIC   = Array.from({ length: MAX_WORKERS - MIN_WORKERS }, (_, i) => `selenium-${i + MIN_WORKERS + 1}`);
const ALL       = [...PERMANENT, ...DYNAMIC];

const containerName = (name) => `${PROJECT}-${name}-1`;

// Workers the autoscaler started but whose health check hasn't passed yet
const starting = new Set();
// When each idle running worker first became idle
const idleSince = {};

// Every docker call is bounded: a wedged daemon must not freeze the autoscaler.
function docker(args, timeout = 15000) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Map of worker name -> container IP for every worker container that is running.
// Returns null when docker can't be queried, so the caller skips the tick.
function workerAddresses() {
  try {
    const wanted = new Map(ALL.map((name) => [containerName(name), name]));
    const present = docker(['ps', '--format', '{{.Names}}']).split('\n').filter((n) => wanted.has(n));
    const ips = new Map();
    if (present.length === 0) return ips;
    const out = docker(['inspect', '-f', `{{.Name}} {{with index .NetworkSettings.Networks "${NETWORK}"}}{{.IPAddress}}{{end}}`, ...present]);
    for (const line of out.split('\n')) {
      const [cname, ip] = line.trim().replace(/^\//, '').split(' ');
      if (ip && wanted.has(cname)) ips.set(wanted.get(cname), ip);
    }
    return ips;
  } catch (e) {
    console.error(`docker query failed: ${e.message.split('\n')[0]}`);
    return null;
  }
}

async function checkWorker(ip) {
  if (!ip) return { running: false, sessions: 0 };
  try {
    const res = await fetch(`http://${ip}:3000/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { running: false, sessions: 0 };
    const data = await res.json();
    return { running: true, sessions: data.sessions || 0 };
  } catch {
    return { running: false, sessions: 0 };
  }
}

// One command on the HAProxy runtime API; resolves with its text reply.
function haproxy(cmd) {
  return new Promise((resolve, reject) => {
    let out = '';
    const sock = net.connect({ host: HAPROXY_HOST, port: Number(HAPROXY_PORT) }, () => sock.end(`${cmd}\n`));
    sock.setTimeout(5000, () => sock.destroy(new Error(`haproxy timeout: ${cmd}`)));
    sock.on('data', (d) => { out += d; });
    sock.on('end', () => resolve(out.trim()));
    sock.on('error', reject);
  });
}

// Servers currently in the backend: name -> address.
async function haproxyServers() {
  const out = await haproxy(`show servers state ${BACKEND}`);
  const servers = new Map();
  for (const line of out.split('\n')) {
    if (!line || line.startsWith('#') || /^\d+$/.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols[1] === BACKEND) servers.set(cols[3], cols[4]);
  }
  return servers;
}

async function haproxyAdd(name, ip) {
  const reply = await haproxy(`add server ${BACKEND}/${name} ${ip}:3000 ${SERVER_OPTS}`);
  if (!/New server registered/i.test(reply)) throw new Error(`add server ${name}: ${reply}`);
  await haproxy(`enable health ${BACKEND}/${name}`);
  await haproxy(`enable server ${BACKEND}/${name}`);
  console.log(`HAProxy: added ${name} (${ip})`);
}

async function haproxyDrop(name) {
  await haproxy(`disable server ${BACKEND}/${name}`);
  await haproxy(`shutdown sessions server ${BACKEND}/${name}`);
  const reply = await haproxy(`del server ${BACKEND}/${name}`);
  if (!/Server deleted/i.test(reply)) throw new Error(`del server ${name}: ${reply}`);
  console.log(`HAProxy: removed ${name}`);
}

// Make HAProxy's backend match reality: healthy dynamic workers registered, gone ones
// removed, and every registered worker pointing at its current container IP.
async function reconcile(ips, healthy) {
  let servers;
  try {
    servers = await haproxyServers();
  } catch (e) {
    console.error(`HAProxy runtime API unreachable: ${e.message}`);
    return;
  }
  for (const name of ALL) {
    const ip = ips.get(name);
    const registered = servers.get(name);
    try {
      if (DYNAMIC.includes(name)) {
        if (!registered && ip && healthy.has(name)) await haproxyAdd(name, ip);
        else if (registered && !ip) await haproxyDrop(name);
      }
      if (registered && ip && registered !== ip) {
        await haproxy(`set server ${BACKEND}/${name} addr ${ip} port 3000`);
        console.log(`HAProxy: ${name} address ${registered} -> ${ip}`);
      }
    } catch (e) {
      console.error(`HAProxy sync for ${name} failed: ${e.message}`);
    }
  }
}

function startWorker(name) {
  // Remove any stale container with this name (e.g. from a previous crashed autoscaler run)
  try { docker(['rm', '-f', containerName(name)]); } catch {}
  try {
    docker([
      'run', '-d',
      '--name', containerName(name),
      '--hostname', name,
      '--network', NETWORK,
      '--network-alias', name,
      '--memory', WORKER_MEMORY,
      '--memory-swap', WORKER_MEMORY_SWAP,
      '--shm-size', '512m',
      '-e', 'MCP_TRANSPORT=http',
      '-e', 'MCP_PORT=3000',
      '-e', 'LOCALHOST_FORWARD_PORTS=',
      '-v', `${VOLUME}:/data`,
      IMAGE,
    ], 120000);
    return true;
  } catch (e) {
    console.error(`Failed to start ${name}: ${e.message.split('\n')[0]}`);
    return false;
  }
}

async function removeWorker(name) {
  // Take it out of rotation first so HAProxy never routes to a stopping container.
  try { await haproxyDrop(name); } catch (e) { console.error(`HAProxy drop ${name}: ${e.message}`); }
  try {
    docker(['stop', containerName(name)], 60000);
    docker(['rm', containerName(name)]);
    return true;
  } catch (e) {
    console.error(`Failed to remove ${name}: ${e.message.split('\n')[0]}`);
    return false;
  }
}

async function tick() {
  const ips = workerAddresses();
  if (!ips) return; // docker unreachable — change nothing this round

  const statuses = await Promise.all(ALL.map(async (name) => ({ name, ...(await checkWorker(ips.get(name))) })));

  const running = statuses.filter((s) => s.running);
  const busy    = running.filter((s) => s.sessions > 0);
  const idle    = running.filter((s) => s.sessions === 0);

  // Clear starting set for workers now confirmed healthy
  for (const w of running) starting.delete(w.name);

  const runningDynamic = running.filter((s) => DYNAMIC.includes(s.name));
  const usedSlots      = runningDynamic.length + starting.size;
  const freeSlots      = (MAX_WORKERS - MIN_WORKERS) - usedSlots;

  console.log(
    `[${new Date().toISOString()}] ` +
    `running=${running.length} busy=${busy.length} idle=${idle.length} ` +
    `dynamic=${runningDynamic.length}/${MAX_WORKERS - MIN_WORKERS} ` +
    `starting=${[...starting].join(',') || 'none'}`
  );

  // ── Scale up ──────────────────────────────────────────────────────────────
  // All current workers are busy, we have room, nothing is already spinning up.
  if (idle.length === 0 && freeSlots > 0 && starting.size === 0) {
    const occupied = new Set([...runningDynamic.map((w) => w.name), ...starting]);
    const next = DYNAMIC.find((name) => !occupied.has(name));
    if (next) {
      console.log(`Scale up: creating ${next} (${usedSlots + 1}/${MAX_WORKERS - MIN_WORKERS} dynamic slots used)`);
      if (startWorker(next)) starting.add(next);
    }
  }

  // ── Idle timer bookkeeping ────────────────────────────────────────────────
  const now = Date.now();
  for (const w of idle)                       { if (!idleSince[w.name]) idleSince[w.name] = now; }
  for (const w of busy)                        { delete idleSince[w.name]; }
  for (const w of statuses.filter((s) => !s.running)) { delete idleSince[w.name]; }

  // ── Scale down ────────────────────────────────────────────────────────────
  // Only remove dynamic workers that have been idle past the grace period.
  // Permanent workers (selenium-1, selenium-2) are never touched.
  const candidates = idle
    .filter((w) => DYNAMIC.includes(w.name))
    .filter((w) => idleSince[w.name] && now - idleSince[w.name] > IDLE_TIMEOUT)
    .sort((a, b) => idleSince[b.name] - idleSince[a.name]); // most-recently-idled first

  const removed = new Set();
  for (const w of candidates) {
    const secs = Math.round((now - idleSince[w.name]) / 1000);
    console.log(`Scale down: removing ${w.name} (idle ${secs}s)`);
    if (await removeWorker(w.name)) { delete idleSince[w.name]; removed.add(w.name); ips.delete(w.name); }
  }

  // ── HAProxy sync ──────────────────────────────────────────────────────────
  const healthy = new Set(running.map((w) => w.name).filter((n) => !removed.has(n)));
  await reconcile(ips, healthy);
}

console.log(
  `Selenium MCP autoscaler starting — ` +
  `permanent=${MIN_WORKERS} max=${MAX_WORKERS} ` +
  `memory=${WORKER_MEMORY} idle_timeout=${IDLE_TIMEOUT / 1000}s poll=${POLL_MS / 1000}s ` +
  `haproxy=${HAPROXY_HOST}:${HAPROXY_PORT}/${BACKEND}`
);

// Never let two ticks overlap (a slow docker call could otherwise stack them up).
let ticking = false;
async function guardedTick() {
  if (ticking) return;
  ticking = true;
  try { await tick(); } catch (e) { console.error(`tick failed: ${e.message}`); } finally { ticking = false; }
}
guardedTick();
setInterval(guardedTick, POLL_MS);
