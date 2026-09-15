const state = {
  registry: null, telemetry: null, observer: null, forecast: null, change: null,
  incidents: null, topology: null, policies: null, slo: null, impact: null,
  fabric: null, observability: null, remediation: null, recommendations: null
};

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function json(path, fallback) {
  try {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) throw new Error(String(response.status));
    return await response.json();
  } catch {
    return fallback;
  }
}

function cls(value) {
  const text = String(value || '');
  if (/ready|healthy|stable|improving|within-objective|bounded|nominal|contract-ready/i.test(text)) return 'ok';
  if (/warn|elevated|warming|moderate|at-risk|review-required/i.test(text)) return 'warn';
  if (/bad|fail|degrad|critical|high|unavailable|active-impact/i.test(text)) return 'bad';
  return '';
}

function ageMs(iso) {
  const time = Date.parse(iso || '');
  return Number.isFinite(time) ? Math.max(0, Date.now() - time) : null;
}

function age(iso) {
  const ms = ageMs(iso);
  if (ms === null) return 'not yet';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

function freshness() {
  const candidates = [state.telemetry?.verifiedAt, state.observer?.generatedAt, state.slo?.generatedAt, state.impact?.generatedAt]
    .map(ageMs).filter(Number.isFinite);
  if (!candidates.length) return { level: 'stale', label: 'NO LIVE SNAPSHOT', detail: 'Engineering intelligence has not been published yet.' };
  const ms = Math.min(...candidates);
  if (ms > 86400000) return { level: 'stale', label: 'STALE DATA', detail: `Latest engineering signal is ${Math.round(ms / 3600000)}h old.` };
  if (ms > 7200000) return { level: 'degraded', label: 'AGING DATA', detail: `Latest engineering signal is ${Math.round(ms / 3600000)}h old.` };
  return { level: 'healthy', label: 'CURRENT DATA', detail: `Latest engineering signal refreshed ${age(new Date(Date.now() - ms).toISOString())}.` };
}

function health() {
  const systems = state.registry?.systems || [];
  const verified = state.telemetry?.systems || {};
  const open = Number(state.observer?.openIncidents || 0);
  const failed = Object.values(verified).filter(v => v?.deployment && v.deployment !== 'READY').length;
  const unreachable = Object.values(state.observer?.systems || {}).filter(v => v?.reachable === false).length;
  const atRisk = Object.values(state.slo?.systems || {}).filter(v => v?.state === 'at-risk').length;
  const fresh = freshness();
  if (fresh.level === 'stale') return { level: 'stale', label: 'SIGNAL STALE', detail: fresh.detail };
  if (open || failed || unreachable || atRisk) return { level: 'degraded', label: 'ATTENTION', detail: `${open} incidents · ${failed} non-ready · ${unreachable} unreachable · ${atRisk} SLO at-risk` };
  if (!systems.length) return { level: 'stale', label: 'REGISTRY UNAVAILABLE', detail: 'System registry could not be loaded.' };
  return { level: 'healthy', label: 'NOMINAL', detail: `${systems.length} systems registered · no material public anomaly detected.` };
}

function renderHealth() {
  const result = health();
  const bar = $('platformHealth')?.closest('.healthbar');
  if (bar) {
    bar.classList.remove('degraded', 'stale');
    if (result.level !== 'healthy') bar.classList.add(result.level);
  }
  $('platformHealth').textContent = result.label;
  $('freshnessState').textContent = result.detail;
}

function nameFor(id) {
  return state.registry?.systems?.find(s => s.id === id)?.name || state.topology?.nodes?.find(n => n.id === id)?.label || id;
}

function renderSlo() {
  const entries = Object.entries(state.slo?.systems || {});
  $('kpiSlo').textContent = entries.length ? `${entries.filter(([, v]) => v.state === 'within-objective').length}/${entries.length}` : '—';
  $('sloGrid').innerHTML = entries.length ? entries.map(([id, v]) => `
    <article class="card">
      <div class="label">${esc(nameFor(id))}</div>
      <h3 class="${cls(v.state)}">${esc(String(v.state).toUpperCase())}</h3>
      <div class="metricrow"><span>Availability</span><strong>${v.observedAvailabilityPct ?? '—'}%</strong></div>
      <div class="metricrow"><span>Objective</span><strong>${v.objectivePct ?? '—'}%</strong></div>
      <div class="metricrow"><span>Error budget remaining</span><strong>${v.errorBudgetRemainingPct ?? '—'}%</strong></div>
      <div class="metricrow"><span>Burn rate</span><strong>${v.burnRate ?? '—'}x</strong></div>
      <div class="metricrow"><span>P95 / target</span><strong>${v.latencyP95Ms ?? '—'} / ${v.latencyP95TargetMs ?? '—'} ms</strong></div>
      <div class="budget"><i style="width:${Math.max(0, Math.min(100, Number(v.errorBudgetRemainingPct ?? 0)))}%"></i></div>
      <div class="meta">${esc(v.sampleBasis ?? 0)} bounded public samples</div>
    </article>`).join('') : '<article class="card"><div class="label">SLO ENGINE</div><h3 class="warn">WARMING UP</h3><p class="muted">The observer will publish bounded SLO proxies after the first telemetry cycle.</p></article>';
}

function renderImpact() {
  const ranked = Object.entries(state.impact?.systems || {})
    .sort((a, b) => (b[1].blastRadius || 0) - (a[1].blastRadius || 0)).slice(0, 6);
  $('impactGrid').innerHTML = ranked.length ? ranked.map(([id, v]) => `
    <article class="card">
      <div class="label">${esc(nameFor(id))}</div>
      <h3 class="${cls(v.state)}">${esc(String(v.state || 'nominal').toUpperCase())}</h3>
      <div class="metricrow"><span>Represented blast radius</span><strong>${esc(v.blastRadius ?? 0)}</strong></div>
      <p class="muted">${v.affectedNodes?.length ? `Affected: ${esc(v.affectedNodes.map(nameFor).join(' · '))}` : 'No downstream public dependency represented.'}</p>
    </article>`).join('') : '<article class="card"><div class="label">IMPACT ENGINE</div><h3 class="warn">WARMING UP</h3><p class="muted">The public dependency graph will be evaluated on the next observer cycle.</p></article>';
}

function renderFabric() {
  const fabric = state.fabric || {};
  const obs = state.observability || {};
  const remediation = state.remediation || {};
  $('fabricCard').innerHTML = `
    <div class="label">${esc(fabric.standard || obs.futureIngestion?.standard || 'TELEMETRY FABRIC')}</div>
    <h3 class="${cls(fabric.status)}">${esc(String(fabric.status || 'contract-ready').toUpperCase())}</h3>
    <p class="muted">Signals: ${esc((fabric.signals || Object.keys(obs.signals || {})).join(' · ') || 'none')}</p>
    <div class="metricrow"><span>Public observer</span><strong>${esc(fabric.ingestion?.publicObserver || 'active')}</strong></div>
    <div class="metricrow"><span>OpenTelemetry adapter</span><strong>${esc(fabric.ingestion?.openTelemetry || 'adapter-ready')}</strong></div>
    <div class="metricrow"><span>Private logs / traces</span><strong>${obs.signals?.logs?.public === false && obs.signals?.traces?.public === false ? 'ENFORCED' : 'UNVERIFIED'}</strong></div>
    <div class="metricrow"><span>Public remediation</span><strong>${remediation.publicExecution === false ? 'DENIED' : 'UNDEFINED'}</strong></div>
    <p class="meta">${esc(fabric.note || obs.description || '')}</p>`;

  const links = ['registry','telemetry','observer','slo','slo-policy','impact','forecast','incidents','topology','policies','runbooks','telemetry-fabric','observability','remediation-policy','recommendations','change-intelligence'];
  $('machineData').innerHTML = links.map(x => `<a class="chip" href="./data/${x}.json">${esc(x.toUpperCase())}</a>`).join('');
}

function render() {
  const systems = state.registry?.systems || [];
  const observed = state.observer?.systems || {};
  const verified = state.telemetry?.systems || {};
  $('kpiSystems').textContent = systems.length || '—';
  $('kpiIncidents').textContent = state.observer?.openIncidents ?? 0;
  $('kpiSamples').textContent = state.observer?.historyWindowSamples ?? 0;
  $('verifiedAt').textContent = `Verified deployment snapshot: ${state.telemetry?.verifiedAt ? age(state.telemetry.verifiedAt) : 'unavailable'} · Observer: ${state.observer?.generatedAt ? age(state.observer.generatedAt) : 'warming up'} · SLO: ${state.slo?.generatedAt ? age(state.slo.generatedAt) : 'warming up'}`;

  $('systems').innerHTML = systems.map(s => {
    const o = observed[s.id], v = verified[s.telemetryKey || s.id];
    const reach = o?.reachable === true ? 'REACHABLE' : o?.reachable === false ? 'UNREACHABLE' : 'PENDING';
    const deploy = v?.deployment || 'UNVERIFIED';
    return `<article class="system"><div class="systemtop"><div><div class="label">${esc(s.category || s.provider)}</div><h3>${esc(s.name)}</h3></div><span class="pill"><span class="dot"></span>${esc(deploy)}</span></div><p class="muted">${esc(s.detail)}</p><div class="meta">${esc(s.role)} · ${esc(s.provider)} · ${reach}${o?.latencyMs ? ` · ${o.latencyMs} ms` : ''}</div><div class="stack"><a class="chip" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">OPEN</a>${s.github ? `<a class="chip" href="${esc(s.github)}" target="_blank" rel="noopener noreferrer">SOURCE</a>` : ''}</div></article>`;
  }).join('');

  $('telemetryGrid').innerHTML = Object.entries(verified).map(([id, v]) => `<article class="card"><div class="label">${esc(nameFor(id))}</div><h3 class="${cls(v.deployment)}">${esc(v.deployment)}</h3><div class="meta">runtime: ${esc(v.runtimeSignal || 'n/a')} · target: ${esc(v.target || 'n/a')}</div>${v.note ? `<p class="muted">${esc(v.note)}</p>` : ''}</article>`).join('') || '<article class="card">No verified telemetry.</article>';

  const forecasts = state.forecast?.systems || {};
  $('forecastGrid').innerHTML = systems.filter(s => s.probe).map(s => {
    const f = forecasts[s.id] || { state: 'warming-up', confidence: 0, note: 'Collecting telemetry.' };
    return `<article class="card"><div class="label">${esc(s.name)}</div><h3 class="${cls(f.state)}">${esc(String(f.state).toUpperCase())}</h3><div class="meta">confidence: ${esc(f.confidence)}%</div><p class="muted">${esc(f.note)}</p></article>`;
  }).join('');

  const c = state.change?.latestChange;
  $('changeCard').innerHTML = c ? `<div class="label">LATEST PUBLIC CHANGE</div><h3>${esc(c.message)}</h3><p class="muted"><code>${esc(c.sha)}</code> · +${esc(c.additions)} / -${esc(c.deletions)}</p><div class="statusbar"><span class="pill">verified: ${c.verified ? 'YES' : 'NO'}</span><span class="pill risk ${esc(c.riskLevel)}">risk ${esc(c.riskScore)}/100 · ${esc(String(c.riskLevel).toUpperCase())}</span><span class="pill">blast: ${esc(c.blastRadius || 'unknown')}</span></div>${c.sensitivePaths?.length ? `<p class="meta">Sensitive paths: ${esc(c.sensitivePaths.join(', '))}</p>` : ''}${c.factors ? `<p class="meta">Factors: files=${esc(c.factors.filesChanged)} · churn=${esc(c.factors.churn)} · migrations=${esc(c.factors.migrations)} · workflows=${esc(c.factors.workflows)} · tests=${esc(c.factors.tests)}</p>` : ''}` : '<div class="label">CHANGE INTELLIGENCE</div><h3>WARMING UP</h3><p class="muted">The observer will calculate the next public change-risk snapshot.</p>';

  const recent = (state.incidents?.incidents || []).slice(-6).reverse();
  $('incidentGrid').innerHTML = recent.length ? recent.map(i => `<article class="card"><div class="label">${esc(i.status)} · ${esc(i.systemName)}</div><h3 class="${i.status === 'open' ? 'bad' : 'ok'}">${esc(i.severity)}</h3><p class="muted">${esc(i.summary)}</p><div class="meta">opened ${esc(age(i.openedAt))}${i.resolvedAt ? ` · resolved ${esc(age(i.resolvedAt))}` : ''}</div></article>`).join('') : '<article class="card"><div class="label">INCIDENT MEMORY</div><h3 class="ok">NO RECORDED PUBLIC INCIDENTS</h3><p class="muted">Transitions detected by the observer will appear here.</p></article>';

  const edges = state.topology?.edges || [];
  $('topologyMeta').textContent = `${state.topology?.nodes?.length || 0} nodes · ${edges.length} edges`;
  $('policyMode').textContent = (state.policies?.mode || 'advisory-only').toUpperCase();
  renderSlo(); renderImpact(); renderFabric(); renderHealth();
}

function diagnostics() {
  const lines = [];
  const observed = state.observer?.systems || {};
  for (const s of state.registry?.systems || []) {
    const o = observed[s.id], v = state.telemetry?.systems?.[s.telemetryKey || s.id], sl = state.slo?.systems?.[s.id];
    if (v?.runtimeSignal === 'warning-observed') lines.push(`${s.name}: runtime warning observed; correlate route and latest deployment.`);
    if (o?.reachable === false) lines.push(`${s.name}: public edge currently unreachable from observer.`);
    if (state.forecast?.systems?.[s.id]?.state === 'degrading') lines.push(`${s.name}: latency trend is degrading.`);
    if (sl?.state === 'at-risk') lines.push(`${s.name}: public SLO proxy is at risk (${sl.errorBudgetRemainingPct}% budget remaining, burn ${sl.burnRate}x).`);
  }
  if (state.change?.latestChange?.riskScore >= 50) lines.push(`Latest public change risk is ${state.change.latestChange.riskScore}/100 (${state.change.latestChange.riskLevel}).`);
  for (const rec of state.recommendations?.recommendations || []) lines.push(`Recommendation [${rec.severity}]: ${rec.recommendation}`);
  const fresh = freshness();
  if (fresh.level !== 'healthy') lines.push(`Freshness: ${fresh.label} — ${fresh.detail}`);
  return lines.length ? lines.join('\n') : 'No material public anomaly detected by the bounded observer.';
}

function systemsText() { return (state.registry?.systems || []).map(s => `${s.id.padEnd(10)} ${s.name}`).join('\n') || 'Registry unavailable.'; }
function deploymentsText() { return Object.entries(state.telemetry?.systems || {}).map(([k,v]) => `${k.padEnd(10)} ${v.deployment} · ${v.runtimeSignal}`).join('\n') || 'Verified snapshot unavailable.'; }
function sloText() { return Object.entries(state.slo?.systems || {}).map(([k,v]) => `${k.padEnd(10)} ${v.state} · availability=${v.observedAvailabilityPct ?? '—'}% · objective=${v.objectivePct ?? '—'}% · budget=${v.errorBudgetRemainingPct ?? '—'}% · burn=${v.burnRate ?? '—'}x`).join('\n') || 'SLO intelligence warming up.'; }
function impactText() { return Object.entries(state.impact?.systems || {}).sort((a,b)=>(b[1].blastRadius||0)-(a[1].blastRadius||0)).map(([k,v]) => `${k.padEnd(10)} ${v.state} · blast=${v.blastRadius ?? 0} · ${v.affectedNodes?.join(', ') || 'none'}`).join('\n') || 'Impact intelligence warming up.'; }
function dataText() { return ['registry.json','telemetry.json','observer.json','slo.json','slo-policy.json','impact.json','forecast.json','incidents.json','topology.json','policies.json','runbooks.json','telemetry-fabric.json','observability.json','remediation-policy.json','recommendations.json','change-intelligence.json'].map(x => `./data/${x}`).join('\n'); }

function copilot(question) {
  if (question === 'health') return diagnostics();
  if (question === 'risk') {
    const c = state.change?.latestChange;
    return c ? `Latest public change risk: ${c.riskScore}/100 (${c.riskLevel}). Blast radius: ${c.blastRadius || 'unknown'}. ${c.message}` : 'Change intelligence is still warming up.';
  }
  if (question === 'impact') {
    const ranked = Object.entries(state.impact?.systems || {}).sort((a,b)=>(b[1].blastRadius||0)-(a[1].blastRadius||0));
    if (!ranked.length) return 'Impact intelligence is still warming up.';
    const [id, v] = ranked[0];
    return `${nameFor(id)} has the highest represented public blast radius: ${v.blastRadius ?? 0} downstream nodes. ${v.affectedNodes?.length ? `Affected: ${v.affectedNodes.map(nameFor).join(', ')}.` : 'No downstream nodes represented.'}`;
  }
  if (question === 'budget') {
    const risky = Object.entries(state.slo?.systems || {}).filter(([,v]) => v.state === 'at-risk').sort((a,b)=>(a[1].errorBudgetRemainingPct??100)-(b[1].errorBudgetRemainingPct??100));
    if (!risky.length) return 'No public SLO proxy is currently classified as at-risk.';
    return risky.map(([id,v]) => `${nameFor(id)}: ${v.errorBudgetRemainingPct}% budget remaining, burn rate ${v.burnRate}x, P95 ${v.latencyP95Ms ?? '—'}ms.`).join('\n');
  }
  return 'Unsupported grounded question.';
}

const input = $('cmd'), history = $('history');
function line(cmd, text) {
  const el = document.createElement('div');
  el.innerHTML = `<div><span class="prompt">garhy@engineering-os:~$</span> <span>${esc(cmd)}</span></div><pre class="muted pre answer">${esc(text)}</pre>`;
  history.appendChild(el);
  el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
}

function command(commandName) {
  if (commandName === 'clear') { history.innerHTML = ''; return; }
  const map = {
    help: 'help, status, diagnose, systems, deployments, slo, impact, forecast, incidents, change, topology, policy, fabric, recommendations, freshness, data, hana, store, bybit, api, id, github, company, clear',
    status: () => { const h = health(); return `health=${h.label}\nsystems=${state.registry?.systems?.length||0}\nslo_within_objective=${Object.values(state.slo?.systems||{}).filter(v=>v.state==='within-objective').length}\nopen_incidents=${state.observer?.openIncidents??0}\nhistory_samples=${state.observer?.historyWindowSamples??0}\nmode=${state.policies?.mode||'advisory-only'}`; },
    diagnose: diagnostics,
    systems: systemsText,
    deployments: deploymentsText,
    slo: sloText,
    impact: impactText,
    forecast: () => Object.entries(state.forecast?.systems||{}).map(([k,v])=>`${k.padEnd(10)} ${v.state} (${v.confidence}%)`).join('\n') || 'Forecast warming up.',
    incidents: () => `${state.observer?.openIncidents??0} open public incidents`,
    change: () => state.change?.latestChange ? `${state.change.latestChange.sha} · risk ${state.change.latestChange.riskScore}/100 ${state.change.latestChange.riskLevel} · blast=${state.change.latestChange.blastRadius||'unknown'}\n${state.change.latestChange.message}` : 'Change intelligence warming up.',
    topology: () => $('topologyMeta').textContent,
    policy: () => `mode=${state.policies?.mode||'advisory-only'}\npublic_mutation=DENIED\nsafe_remediation=PRIVATE_POLICY_APPROVAL_REQUIRED\nfinancial_or_destructive=EXPLICIT_HUMAN_APPROVAL_REQUIRED`,
    fabric: () => `${state.fabric?.standard||state.observability?.futureIngestion?.standard||'Telemetry fabric'}\nstatus=${state.fabric?.status||'contract-ready'}\nserver_side_only=${Boolean(state.fabric?.ingestion?.serverSideOnly)}\nlogs_public=${state.observability?.signals?.logs?.public}\ntraces_public=${state.observability?.signals?.traces?.public}`,
    recommendations: () => (state.recommendations?.recommendations||[]).map(r=>`[${r.severity}] ${r.systemId}: ${r.recommendation}`).join('\n') || 'No evidence-grounded recommendation is currently active.',
    freshness: () => { const f=freshness(); return `${f.label}\n${f.detail}\nverified=${state.telemetry?.verifiedAt||'unavailable'}\nobserver=${state.observer?.generatedAt||'unavailable'}\nslo=${state.slo?.generatedAt||'unavailable'}`; },
    data: dataText
  };
  if (['hana','store','bybit','api','id'].includes(commandName)) {
    const s = state.registry?.systems?.find(x => x.id === commandName || (x.id === 'identity' && commandName === 'id'));
    line(commandName, s ? `${s.name}\n${s.url}\n${s.detail}` : 'Unknown system.');
    return;
  }
  if (commandName === 'github') { location.href = 'https://github.com/Garhy-tech'; return; }
  if (commandName === 'company') { location.href = 'https://garhy.tech'; return; }
  const value = map[commandName];
  line(commandName, typeof value === 'function' ? value() : value || 'Unknown command. Type help.');
}

input?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    const commandName = input.value.trim().toLowerCase();
    input.value = '';
    if (commandName) command(commandName);
  }
});

document.addEventListener('keydown', event => {
  if (event.key === '/' && document.activeElement !== input) { event.preventDefault(); input.focus(); }
});

document.querySelectorAll('[data-question]').forEach(button => button.addEventListener('click', () => {
  $('copilotAnswer').textContent = copilot(button.dataset.question);
}));

(async () => {
  [state.registry,state.telemetry,state.observer,state.forecast,state.change,state.incidents,state.topology,state.policies,state.slo,state.impact,state.fabric,state.observability,state.remediation,state.recommendations] = await Promise.all([
    json('./data/registry.json',{systems:[]}), json('./data/telemetry.json',{systems:{}}), json('./data/observer.json',{systems:{}}),
    json('./data/forecast.json',{systems:{}}), json('./data/change-intelligence.json',{}), json('./data/incidents.json',{incidents:[]}),
    json('./data/topology.json',{nodes:[],edges:[]}), json('./data/policies.json',{mode:'advisory-only'}), json('./data/slo.json',{systems:{}}),
    json('./data/impact.json',{systems:{}}), json('./data/telemetry-fabric.json',{}), json('./data/observability.json',{}),
    json('./data/remediation-policy.json',{publicExecution:false}), json('./data/recommendations.json',{recommendations:[]})
  ]);
  render();
})();
