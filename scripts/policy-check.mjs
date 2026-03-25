import fs from 'fs/promises';

const dockerfile = await fs.readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
const workflow = await fs.readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

const checks = [
  ['Dockerfile uses non-root user', /USER\s+(streamchain|65532(?::65532)?)/.test(dockerfile) || /:nonroot/.test(dockerfile)],
  ['Dockerfile has healthcheck', /HEALTHCHECK/.test(dockerfile)],
  ['Dockerfile uses npm ci', /npm ci/.test(dockerfile)],
  ['CI generates SBOM', /npm run sbom/.test(workflow)],
  ['CI runs policy check', /npm run policy-check/.test(workflow)],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
  console.error(JSON.stringify({ ok: false, failed: failed.map(([label]) => label) }));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, checks: checks.map(([label]) => label) }));
