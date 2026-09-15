import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const failures = [];
const required = [
  'README.md','docs/index.html','docs/styles.css','docs/app.js','docs/icon.svg','docs/manifest.webmanifest',
  'docs/data/registry.json','docs/data/telemetry.json','docs/data/observer.json','docs/data/forecast.json',
  'docs/data/incidents.json','docs/data/topology.json','docs/data/policies.json','docs/data/runbooks.json',
  'docs/data/slo.json','docs/data/impact.json','docs/data/telemetry-fabric.json','docs/data/change-intelligence.json'
];
const text = async path => readFile(join(root, path), 'utf8');
const json = async path => JSON.parse(await text(path));
const fail = message => failures.push(message);
for (const path of required) { try { await text(path); } catch { fail(`missing required file: ${path}`); } }

let registry = { systems: [] };
try { registry = await json('docs/data/registry.json'); } catch (error) { fail(`registry JSON invalid: ${error.message}`); }
if (!Array.isArray(registry.systems) || registry.systems.length < 1) fail('registry must contain at least one system');
const ids = new Set();
for (const system of registry.systems || []) {
  if (!system?.id || !system?.name || !system?.url) fail('every registry system requires id, name and url');
  if (ids.has(system.id)) fail(`duplicate registry id: ${system.id}`);
  ids.add(system.id);
  try { const url = new URL(system.url); if (url.protocol !== 'https:') fail(`registry URL must use HTTPS: ${system.url}`); }
  catch { fail(`invalid registry URL: ${system.url}`); }
}

for (const path of required.filter(p=>p.endsWith('.json')||p.endsWith('.webmanifest'))) {
  try { await json(path); } catch (error) { fail(`${path} JSON invalid: ${error.message}`); }
}

try {
  const topology = await json('docs/data/topology.json');
  const nodeIds = new Set((topology.nodes||[]).map(n=>n.id));
  for (const edge of topology.edges||[]) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) fail(`topology edge references unknown node: ${edge.from}->${edge.to}`);
  }
} catch {}

try {
  const fabric = await json('docs/data/telemetry-fabric.json');
  if (fabric.ingestion?.serverSideOnly !== true) fail('telemetry fabric must require a server-side ingestion boundary');
  if (!Array.isArray(fabric.signals) || fabric.signals.length < 4) fail('telemetry fabric must declare supported signal classes');
} catch {}

try {
  const html = await text('docs/index.html');
  for (const marker of ['GARHY Engineering OS','Content-Security-Policy','rel="canonical"','id="platformHealth"','id="freshnessState"','id="sloGrid"','id="impactGrid"','id="copilotAnswer"','id="machineData"','id="cmd"']) {
    if (!html.includes(marker)) fail(`docs/index.html missing marker: ${marker}`);
  }
} catch {}

try {
  const app = await text('docs/app.js');
  for (const marker of ['slo.json','impact.json','telemetry-fabric.json','public_mutation=DENIED']) if (!app.includes(marker)) fail(`docs/app.js missing intelligence contract: ${marker}`);
} catch {}

try {
  const manifest = await json('docs/manifest.webmanifest');
  if (manifest.start_url !== '/Garhy-tech/') fail('manifest start_url must remain /Garhy-tech/');
  if (manifest.scope !== '/Garhy-tech/') fail('manifest scope must remain /Garhy-tech/');
  if (!Array.isArray(manifest.icons) || manifest.icons.length < 1) fail('manifest must define at least one icon');
} catch {}

try {
  const workflowDir = join(root, '.github', 'workflows');
  const workflows = (await readdir(workflowDir)).filter(name => /\.ya?ml$/i.test(name));
  for (const name of workflows) {
    const body = await readFile(join(workflowDir, name), 'utf8');
    for (const match of body.matchAll(/^\s*uses:\s*([^\s#]+)\s*$/gm)) {
      const ref = match[1];
      if (!/@[0-9a-f]{40}$/i.test(ref)) fail(`${name}: action must be pinned to a full commit SHA: ${ref}`);
    }
  }
} catch (error) { fail(`workflow validation failed: ${error.message}`); }

try {
  const allPublic = [await text('README.md'), await text('docs/index.html'), await text('docs/app.js')].join('\n');
  if (/http:\/\//i.test(allPublic)) fail('public profile surfaces must not contain insecure http:// links');
  if (/(service[_-]?role|secret[_-]?key|private[_-]?key|password\s*=)/i.test(allPublic)) fail('public profile surfaces contain a forbidden sensitive-token pattern');
} catch {}

if (failures.length) {
  console.error('GARHY Engineering OS integrity gate FAILED');
  for (const item of failures) console.error(`- ${item}`);
  process.exit(1);
}
console.log(`GARHY Engineering OS integrity gate PASS — ${registry.systems.length} registered systems, pinned workflows, SLO/impact/fabric contracts valid.`);
