import fs from 'node:fs/promises';

const username = process.env.GITHUB_REPOSITORY_OWNER || 'Garhy-tech';
const token = process.env.GITHUB_TOKEN;
const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'garhy-profile-metrics',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  'X-GitHub-Api-Version': '2022-11-28',
};

const response = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}/repos?type=owner&sort=updated&per_page=100`, { headers });
if (!response.ok) throw new Error(`GitHub API failed: ${response.status} ${response.statusText}`);
const repos = await response.json();

const publicRepos = repos.filter((repo) => !repo.fork && !repo.archived && repo.name.toLowerCase() !== username.toLowerCase());
const stars = publicRepos.reduce((sum, repo) => sum + repo.stargazers_count, 0);
const forks = publicRepos.reduce((sum, repo) => sum + repo.forks_count, 0);
const latest = publicRepos[0];
const updated = latest?.updated_at ? new Date(latest.updated_at).toISOString().slice(0, 10) : 'n/a';
const latestName = latest?.name || 'n/a';

const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[ch]));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="260" viewBox="0 0 1200 260" role="img" aria-labelledby="title desc">
<title id="title">GARHY TECH public GitHub metrics</title>
<desc id="desc">Automatically generated from the public GitHub API.</desc>
<rect width="1200" height="260" rx="18" fill="#070b10"/>
<rect x="1" y="1" width="1198" height="258" rx="17" fill="none" stroke="#153641"/>
<text x="40" y="48" fill="#72f4ff" font-family="monospace" font-size="17" letter-spacing="2">PUBLIC GITHUB SIGNAL // LIVE</text>
<circle cx="1135" cy="43" r="7" fill="#22c55e"/>
<g font-family="Arial, Helvetica, sans-serif">
  <text x="42" y="106" fill="#ffffff" font-size="39" font-weight="700">${publicRepos.length}</text>
  <text x="42" y="134" fill="#94a3b8" font-size="14">PUBLIC REPOS</text>
  <text x="270" y="106" fill="#ffffff" font-size="39" font-weight="700">${stars}</text>
  <text x="270" y="134" fill="#94a3b8" font-size="14">STARS</text>
  <text x="470" y="106" fill="#ffffff" font-size="39" font-weight="700">${forks}</text>
  <text x="470" y="134" fill="#94a3b8" font-size="14">FORKS</text>
</g>
<text x="42" y="192" fill="#94a3b8" font-family="monospace" font-size="14">LATEST PUBLIC UPDATE</text>
<text x="42" y="221" fill="#e2e8f0" font-family="monospace" font-size="17">${esc(latestName)} • ${esc(updated)}</text>
<text x="1120" y="222" text-anchor="end" fill="#64748b" font-family="monospace" font-size="12">AUTO-GENERATED</text>
</svg>`;

await fs.mkdir('assets', { recursive: true });
await fs.writeFile('assets/live-metrics.svg', svg, 'utf8');
console.log(`Generated metrics for ${username}: ${publicRepos.length} repos, ${stars} stars, ${forks} forks.`);
