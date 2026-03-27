import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { createSelfHostedBundle } from '../lib/install-bundle.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactsDir = path.join(projectRoot, 'artifacts');
const outputPath = path.join(artifactsDir, 'streamchain-self-hosted-kit.tar.gz');

await fs.mkdir(artifactsDir, { recursive: true });

const bundle = await createSelfHostedBundle(projectRoot);
await fs.writeFile(outputPath, bundle);

console.log(JSON.stringify({ ok: true, output: path.relative(projectRoot, outputPath), bytes: bundle.length }));
