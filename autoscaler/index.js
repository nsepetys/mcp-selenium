'use strict';

const { execSync } = require('child_process');

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

// selenium-1 and selenium-2 are permanent compose services — autoscaler never touches them.
// selenium-3 through selenium-10 are dynamic — created/removed by the autoscaler.
const PERMANENT = Array.from({ length: MIN_WORKERS },              (_, i) => `selenium-${i + 1}`);
const DYNAMIC   = Array.from({ length: MAX_WORKERS - MIN_WORKERS }, (_, i) => `selenium-${i + MIN_WORKERS + 1}`);
const ALL       = [...PERMANENT, ...DYNAMIC];

// Workers the autoscaler started but whose health check hasn't passed yet
const starting = new Set();
// When each idle running worker first became idle
const idleSince = {};

async function checkWorker(name) {
  try {
    const res = await fetch(`http://${name}:3000/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { running: false, sessions: 0 };
    const data = await res.json();
    return { running: true, sessions: data.sessions || 0 };
  } catch {
    return { running: false, sessions: 0 };
  }
}

function startWorker(name) {
  const containerName = `${PROJECT}-${name}-1`;
  // Remove any stale container with this name (e.g. from a previous crashed autoscaler run)
  try { execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' }); } catch {}
  const cmd = [
    'docker run -d',
    `--name ${containerName}`,
    `--hostname ${name}`,
    `--network ${NETWORK}`,
    `--network-alias ${name}`,
    `--memory ${WORKER_MEMORY}`,
    `--memory-swap ${WORKER_MEMORY_SWAP}`,
    '--shm-size 512m',
    '-e MCP_TRANSPORT=http',
    '-e MCP_PORT=3000',
    '-e LOCALHOST_FORWARD_PORTS=""',
    `-v ${VOLUME}:/data`,
    IMAGE,
  ].join(' ');
  try {
    execSync(cmd, { stdio: 'inherit' });
    return true;
  } catch (e) {
    console.error(`Failed to start ${name}: ${e.message}`);
    return false;
  }
}

function removeWorker(name) {
  const containerName = `${PROJECT}-${name}-1`;
  try {
    execSync(`docker stop ${containerName} && docker rm ${containerName}`, { stdio: 'inherit' });
    return true;
  } catch (e) {
    console.error(`Failed to remove ${name}: ${e.message}`);
    return false;
  }
}

async function tick() {
  const statuses = await Promise.all(ALL.map(async (name) => ({ name, ...(await checkWorker(name)) })));

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

  for (const w of candidates) {
    const secs = Math.round((now - idleSince[w.name]) / 1000);
    console.log(`Scale down: removing ${w.name} (idle ${secs}s)`);
    if (removeWorker(w.name)) delete idleSince[w.name];
  }
}

console.log(
  `Selenium MCP autoscaler starting — ` +
  `permanent=${MIN_WORKERS} max=${MAX_WORKERS} ` +
  `memory=${WORKER_MEMORY} idle_timeout=${IDLE_TIMEOUT / 1000}s poll=${POLL_MS / 1000}s`
);

tick();
setInterval(tick, POLL_MS);
