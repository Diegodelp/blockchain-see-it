import fs from 'fs/promises';

const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lockfile = JSON.parse(await fs.readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));

const components = Object.entries(lockfile.packages || {})
  .filter(([name, meta]) => name && meta.version)
  .map(([name, meta]) => ({
    type: 'library',
    name: name.replace(/^node_modules\//, ''),
    version: meta.version,
    purl: `pkg:npm/${name.replace(/^node_modules\//, '')}@${meta.version}`,
  }));

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    component: {
      type: 'application',
      name: packageJson.name,
      version: packageJson.version,
    },
  },
  components,
};

await fs.mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
await fs.writeFile(new URL('../artifacts/sbom.cyclonedx.json', import.meta.url), JSON.stringify(sbom, null, 2), 'utf8');
console.log(JSON.stringify({ ok: true, components: components.length, output: 'artifacts/sbom.cyclonedx.json' }));
