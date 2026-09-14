import fs from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const dataPath = (name) => new URL(`../docs/data/${name}`, import.meta.url);
const owner = process.env.GITHUB_REPOSITORY_OWNER || 'Garhy-tech';
const token = process.env.GITHUB_TOKEN || '';
const now = new Date().toISOString();
const ghHeaders = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'garhy-mission-control-observer',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

async function readJson(url, fallback) {
  try { return JSON.parse(await fs.readFile(url, 'utf8')); } catch { return fallback; }
}

async function writeJson(url, value) {
  await fs.mkdir(new URL('../docs/data/', import.meta.url), { recursive: true });
  await fs.writeFile(url, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function probe(url) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
      headers: { 'User-Agent': 'GARHY-TECH-Mission-Control/1.0' },
      signal: controller.signal,
    });
    return {
      reachable: response.status < 500,
      status: response.status,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      reachable: false,
      status: 0,
      latencyMs: Date.now() - started,
      error: error?.name === 'AbortError' ? 'timeout' : 'network-error',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function trendFor(history, id) {
  const points = history
    .map((sample) => sample.systems?.[id])
    .filter((point) => point && Number.isFinite(point.latencyMs));
  if (points.length < 8) return { state: 'warming-up', confidence: 0, note: 'Collecting historical telemetry.' };
  const recent = points.slice(-4).map((p) => p.latencyMs);
  const previous = points.slice(-8, -4).map((p) => p.latencyMs);
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const recentAvg = avg(recent);
  const previousAvg = avg(previous);
  const ratio = previousAvg > 0 ? recentAvg / previousAvg : 1;
  if (ratio >= 1.5 && recentAvg >= 500) return { state: 'degrading', confidence: Math.min(95, Math.round((ratio - 1) * 100)), note: `Recent latency is ${Math.round((ratio - 1) * 100)}% above the prior window.` };
  if (ratio <= 0.72) return { state: 'improving', confidence: Math.min(90, Math.round((1 - ratio) * 100)), note: 'Recent latency improved versus the prior window.' };
  return { state: 'stable', confidence: 70, note: 'No material latency trend detected.' };
}

async function githubJson(url) {
  const response = await fetch(url, { headers: ghHeaders });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${url}`);
  return response.json();
}

function changeRisk(commit) {
  const files = Array.isArray(commit.files) ? commit.files : [];
  const names = files.map((f) => f.filename || '');
  const sensitive = names.filter((name) => /(auth|security|secret|payment|billing|bybit|api|supabase|database|migration|workflow|\.github\/workflows)/i.test(name));
  const migrations = names.filter((name) => /(migration|migrations|schema|database)/i.test(name));
  const workflows = names.filter((name) => /\.github\/workflows/i.test(name));
  const churn = Number(commit.stats?.additions || 0) + Number(commit.stats?.deletions || 0);
  let score = 0;
  score += Math.min(25, files.length * 2);
  score += Math.min(25, Math.ceil(churn / 50));
  if (sensitive.length) score += 20;
  if (migrations.length) score += 20;
  if (workflows.length) score += 10;
  score = Math.min(100, score);
  const level = score >= 75 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'elevated' : 'low';
  return { score, level, sensitivePaths: sensitive.slice(0, 12) };
}

const registry = await readJson(dataPath('registry.json'), { systems: [] });
const historyDoc = await readJson(dataPath('history.json'), { schemaVersion: 1, samples: [] });
const incidentsDoc = await readJson(dataPath('incidents.json'), { schemaVersion: 1, incidents: [] });
const probeSystems = (registry.systems || []).filter((system) => system.probe === true && system.url);

const currentSystems = {};
await Promise.all(probeSystems.map(async (system) => {
  currentSystems[system.id] = await probe(system.url);
}));

const sample = { timestamp: now, systems: currentSystems };
const history = [...(historyDoc.samples || []), sample].slice(-168);

const incidents = [...(incidentsDoc.incidents || [])];
const previous = history.length > 1 ? history[history.length - 2] : null;
for (const system of probeSystems) {
  const current = currentSystems[system.id];
  const before = previous?.systems?.[system.id];
  const openIndex = incidents.findIndex((incident) => incident.systemId === system.id && incident.status === 'open');
  if (before?.reachable === true && current.reachable === false && openIndex === -1) {
    incidents.push({
      id: `${system.id}-${Date.now()}`,
      systemId: system.id,
      systemName: system.name,
      status: 'open',
      severity: 'public-edge-degraded',
      openedAt: now,
      summary: `${system.name} public reachability changed from reachable to unavailable.`,
      source: 'public-observer',
    });
  }
  if (current.reachable === true && openIndex !== -1) {
    incidents[openIndex] = {
      ...incidents[openIndex],
      status: 'resolved',
      resolvedAt: now,
      resolution: 'Public reachability recovered.',
    };
  }
}

const summaries = {};
for (const system of probeSystems) {
  const id = system.id;
  const points = history.map((s) => s.systems?.[id]).filter(Boolean);
  const validLatencies = points.filter((p) => Number.isFinite(p.latencyMs) && p.reachable).map((p) => p.latencyMs);
  const reachableCount = points.filter((p) => p.reachable).length;
  summaries[id] = {
    reachable: currentSystems[id]?.reachable ?? null,
    status: currentSystems[id]?.status ?? null,
    latencyMs: currentSystems[id]?.latencyMs ?? null,
    samples: points.length,
    availabilityPct: points.length ? Number(((reachableCount / points.length) * 100).toFixed(2)) : null,
    latencyP50Ms: percentile(validLatencies, 50),
    latencyP95Ms: percentile(validLatencies, 95),
    trend: trendFor(history, id),
  };
}

let changeIntelligence = {
  schemaVersion: 1,
  generatedAt: now,
  repository: `${owner}/garhy-gpt-oss-cloud`,
  status: 'unavailable',
};
try {
  const commits = await githubJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/garhy-gpt-oss-cloud/commits?per_page=1`);
  const sha = commits?.[0]?.sha;
  if (sha) {
    const commit = await githubJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/garhy-gpt-oss-cloud/commits/${encodeURIComponent(sha)}`);
    const risk = changeRisk(commit);
    changeIntelligence = {
      schemaVersion: 1,
      generatedAt: now,
      repository: `${owner}/garhy-gpt-oss-cloud`,
      status: 'ready',
      latestChange: {
        sha: sha.slice(0, 12),
        message: String(commit.commit?.message || '').split('\n')[0].slice(0, 180),
        authoredAt: commit.commit?.author?.date || null,
        verified: Boolean(commit.commit?.verification?.verified),
        filesChanged: Array.isArray(commit.files) ? commit.files.length : 0,
        additions: Number(commit.stats?.additions || 0),
        deletions: Number(commit.stats?.deletions || 0),
        riskScore: risk.score,
        riskLevel: risk.level,
        sensitivePaths: risk.sensitivePaths,
      },
    };
  }
} catch (error) {
  changeIntelligence.note = 'Public change intelligence could not be refreshed during this observation cycle.';
}

const observer = {
  schemaVersion: 1,
  generatedAt: now,
  source: 'GitHub Actions public observer',
  mode: 'advisory-only',
  systems: summaries,
  openIncidents: incidents.filter((incident) => incident.status === 'open').length,
  historyWindowSamples: history.length,
};

const forecast = {
  schemaVersion: 1,
  generatedAt: now,
  method: 'bounded moving-window trend analysis over public reachability latency',
  note: 'Forecasts are advisory signals, not outage predictions or guarantees.',
  systems: Object.fromEntries(Object.entries(summaries).map(([id, summary]) => [id, summary.trend])),
};

await writeJson(dataPath('history.json'), { schemaVersion: 1, updatedAt: now, maxSamples: 168, samples: history });
await writeJson(dataPath('incidents.json'), { schemaVersion: 1, updatedAt: now, incidents: incidents.slice(-50) });
await writeJson(dataPath('observer.json'), observer);
await writeJson(dataPath('forecast.json'), forecast);
await writeJson(dataPath('change-intelligence.json'), changeIntelligence);

console.log(`Mission Control observer refreshed ${probeSystems.length} public systems at ${now}.`);
