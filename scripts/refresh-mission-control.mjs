import fs from 'node:fs/promises';

const dataPath = (name) => new URL(`../docs/data/${name}`, import.meta.url);
const owner = process.env.GITHUB_REPOSITORY_OWNER || 'Garhy-tech';
const token = process.env.GITHUB_TOKEN || '';
const now = new Date().toISOString();
const ghHeaders = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'garhy-engineering-os-observer',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

async function readJson(url, fallback) { try { return JSON.parse(await fs.readFile(url, 'utf8')); } catch { return fallback; } }
async function writeJson(name, value) { await fs.writeFile(dataPath(name), `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
async function probe(url) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'follow', cache: 'no-store', headers: { 'User-Agent': 'GARHY-Engineering-OS/2.0' }, signal: controller.signal });
    return { reachable: response.status < 500, status: response.status, latencyMs: Date.now() - started };
  } catch (error) {
    return { reachable: false, status: 0, latencyMs: Date.now() - started, error: error?.name === 'AbortError' ? 'timeout' : 'network-error' };
  } finally { clearTimeout(timeout); }
}
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
function trendFor(history, id) {
  const points = history.map(s => s.systems?.[id]).filter(p => p && Number.isFinite(p.latencyMs));
  if (points.length < 8) return { state: 'warming-up', confidence: 0, note: 'Collecting historical telemetry.' };
  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const recent = avg(points.slice(-4).map(p => p.latencyMs));
  const previous = avg(points.slice(-8, -4).map(p => p.latencyMs));
  const ratio = previous > 0 ? recent / previous : 1;
  if (ratio >= 1.5 && recent >= 500) return { state: 'degrading', confidence: Math.min(95, Math.round((ratio - 1) * 100)), note: `Recent latency is ${Math.round((ratio - 1) * 100)}% above the prior window.` };
  if (ratio <= 0.72) return { state: 'improving', confidence: Math.min(90, Math.round((1 - ratio) * 100)), note: 'Recent latency improved versus the prior window.' };
  return { state: 'stable', confidence: 70, note: 'No material latency trend detected.' };
}
async function githubJson(url) {
  const response = await fetch(url, { headers: ghHeaders });
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  return response.json();
}
function changeRisk(commit) {
  const files = Array.isArray(commit.files) ? commit.files : [];
  const names = files.map(f => f.filename || '');
  const sensitive = names.filter(name => /(auth|security|secret|payment|billing|bybit|api|supabase|database|migration|workflow|\.github\/workflows)/i.test(name));
  const migrations = names.filter(name => /(migration|migrations|schema|database)/i.test(name));
  const workflows = names.filter(name => /\.github\/workflows/i.test(name));
  const tests = names.filter(name => /(test|spec|e2e|playwright|vitest|jest)/i.test(name));
  const churn = Number(commit.stats?.additions || 0) + Number(commit.stats?.deletions || 0);
  let score = Math.min(25, files.length * 2) + Math.min(25, Math.ceil(churn / 50));
  if (sensitive.length) score += 20;
  if (migrations.length) score += 20;
  if (workflows.length) score += 10;
  if (tests.length) score = Math.max(0, score - Math.min(15, tests.length * 3));
  score = Math.min(100, score);
  return {
    score,
    level: score >= 75 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'elevated' : 'low',
    sensitivePaths: sensitive.slice(0, 12),
    migrationPaths: migrations.slice(0, 8),
    workflowPaths: workflows.slice(0, 8),
    testPaths: tests.slice(0, 8),
    blastRadius: sensitive.length || migrations.length ? 'elevated' : files.length > 20 ? 'moderate' : 'bounded',
  };
}
function impactFor(topology, systemId) {
  const reverse = new Map();
  for (const edge of topology.edges || []) {
    if (!reverse.has(edge.to)) reverse.set(edge.to, []);
    reverse.get(edge.to).push(edge.from);
  }
  const seen = new Set([systemId]);
  const queue = [systemId];
  const affected = [];
  while (queue.length) {
    const current = queue.shift();
    for (const node of reverse.get(current) || []) {
      if (!seen.has(node)) { seen.add(node); affected.push(node); queue.push(node); }
    }
  }
  return affected;
}

const registry = await readJson(dataPath('registry.json'), { systems: [] });
const topology = await readJson(dataPath('topology.json'), { nodes: [], edges: [] });
const historyDoc = await readJson(dataPath('history.json'), { samples: [] });
const incidentsDoc = await readJson(dataPath('incidents.json'), { incidents: [] });
const probeSystems = (registry.systems || []).filter(system => system.probe === true && system.url);
const currentSystems = {};
await Promise.all(probeSystems.map(async system => { currentSystems[system.id] = await probe(system.url); }));

const history = [...(historyDoc.samples || []), { timestamp: now, systems: currentSystems }].slice(-168);
const previous = history.length > 1 ? history[history.length - 2] : null;
const incidents = [...(incidentsDoc.incidents || [])];
for (const system of probeSystems) {
  const current = currentSystems[system.id];
  const before = previous?.systems?.[system.id];
  const openIndex = incidents.findIndex(i => i.systemId === system.id && i.status === 'open');
  if (before?.reachable === true && current.reachable === false && openIndex === -1) incidents.push({ id: `${system.id}-${Date.now()}`, systemId: system.id, systemName: system.name, status: 'open', severity: 'public-edge-degraded', openedAt: now, summary: `${system.name} public reachability changed from reachable to unavailable.`, source: 'public-observer' });
  if (current.reachable === true && openIndex !== -1) incidents[openIndex] = { ...incidents[openIndex], status: 'resolved', resolvedAt: now, resolution: 'Public reachability recovered.' };
}

const summaries = {};
const sloSystems = {};
for (const system of probeSystems) {
  const points = history.map(s => s.systems?.[system.id]).filter(Boolean);
  const validLatencies = points.filter(p => Number.isFinite(p.latencyMs) && p.reachable).map(p => p.latencyMs);
  const reachableCount = points.filter(p => p.reachable).length;
  const availabilityPct = points.length ? Number(((reachableCount / points.length) * 100).toFixed(3)) : null;
  const objective = 99.9;
  const allowedFailurePct = 100 - objective;
  const consumed = availabilityPct == null ? null : Math.max(0, (100 - availabilityPct) / allowedFailurePct);
  summaries[system.id] = {
    reachable: currentSystems[system.id]?.reachable ?? null,
    status: currentSystems[system.id]?.status ?? null,
    latencyMs: currentSystems[system.id]?.latencyMs ?? null,
    samples: points.length,
    availabilityPct,
    latencyP50Ms: percentile(validLatencies, 50),
    latencyP95Ms: percentile(validLatencies, 95),
    latencyP99Ms: percentile(validLatencies, 99),
    trend: trendFor(history, system.id),
  };
  sloSystems[system.id] = {
    objectivePct: objective,
    observedAvailabilityPct: availabilityPct,
    errorBudgetRemainingPct: consumed == null ? null : Number(Math.max(0, 100 - consumed * 100).toFixed(2)),
    burnRate: consumed == null ? null : Number(consumed.toFixed(2)),
    latencyP95Ms: percentile(validLatencies, 95),
    samples: points.length,
    state: availabilityPct == null ? 'warming-up' : availabilityPct >= objective ? 'within-objective' : 'budget-burning'
  };
}

let changeIntelligence = { schemaVersion: 2, generatedAt: now, repository: `${owner}/garhy-gpt-oss-cloud`, status: 'unavailable' };
try {
  const commits = await githubJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/garhy-gpt-oss-cloud/commits?per_page=1`);
  const sha = commits?.[0]?.sha;
  if (sha) {
    const commit = await githubJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/garhy-gpt-oss-cloud/commits/${encodeURIComponent(sha)}`);
    const risk = changeRisk(commit);
    changeIntelligence = { schemaVersion: 2, generatedAt: now, repository: `${owner}/garhy-gpt-oss-cloud`, status: 'ready', latestChange: { sha: sha.slice(0, 12), message: String(commit.commit?.message || '').split('\n')[0].slice(0, 180), authoredAt: commit.commit?.author?.date || null, verified: Boolean(commit.commit?.verification?.verified), filesChanged: Array.isArray(commit.files) ? commit.files.length : 0, additions: Number(commit.stats?.additions || 0), deletions: Number(commit.stats?.deletions || 0), riskScore: risk.score, riskLevel: risk.level, blastRadius: risk.blastRadius, sensitivePaths: risk.sensitivePaths, migrationPaths: risk.migrationPaths, workflowPaths: risk.workflowPaths, testPaths: risk.testPaths } };
  }
} catch { changeIntelligence.note = 'Public change intelligence could not be refreshed during this observation cycle.'; }

const impactSystems = {};
for (const system of registry.systems || []) {
  const affectedIds = impactFor(topology, system.id);
  impactSystems[system.id] = {
    affectedIds,
    affectedCount: affectedIds.length,
    severity: affectedIds.length >= 4 ? 'high' : affectedIds.length >= 2 ? 'elevated' : affectedIds.length === 1 ? 'moderate' : 'bounded',
    recommendedRunbook: currentSystems[system.id]?.reachable === false ? 'public-edge-unreachable' : null,
  };
}

const observer = { schemaVersion: 2, generatedAt: now, source: 'GitHub Actions public observer', mode: 'advisory-only', systems: summaries, openIncidents: incidents.filter(i => i.status === 'open').length, historyWindowSamples: history.length };
const forecast = { schemaVersion: 2, generatedAt: now, method: 'bounded moving-window trend analysis over public reachability latency', note: 'Forecasts are advisory signals, not outage predictions or guarantees.', systems: Object.fromEntries(Object.entries(summaries).map(([id, summary]) => [id, summary.trend])) };

await writeJson('history.json', { schemaVersion: 2, updatedAt: now, maxSamples: 168, samples: history });
await writeJson('incidents.json', { schemaVersion: 2, updatedAt: now, incidents: incidents.slice(-50) });
await writeJson('observer.json', observer);
await writeJson('forecast.json', forecast);
await writeJson('change-intelligence.json', changeIntelligence);
await writeJson('slo.json', { schemaVersion: 1, generatedAt: now, method: 'public observer availability over bounded sample window', objective: 99.9, systems: sloSystems, note: 'Public SLO proxy only; private OpenTelemetry SLOs require server-side aggregation.' });
await writeJson('impact.json', { schemaVersion: 1, generatedAt: now, systems: impactSystems, note: 'Impact analysis is derived from the public digital twin dependency graph and excludes private topology.' });

console.log(`GARHY Engineering OS observer refreshed ${probeSystems.length} public systems at ${now}.`);
