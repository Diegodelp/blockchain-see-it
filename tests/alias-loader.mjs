import fs from 'fs';
import { readFile } from 'fs/promises';
import { pathToFileURL } from 'url';

export async function resolve(specifier, context, defaultResolve) {
  if (specifier === 'next/server') {
    return { url: pathToFileURL(`${process.cwd()}/node_modules/next/server.js`).href, shortCircuit: true };
  }

  if (specifier === 'next/cache') {
    return { url: pathToFileURL(`${process.cwd()}/node_modules/next/cache.js`).href, shortCircuit: true };
  }

  if (specifier.startsWith('@/')) {
    const basePath = `${process.cwd()}/${specifier.slice(2)}`;
    if (fs.existsSync(basePath)) {
      return { url: pathToFileURL(basePath).href, shortCircuit: true };
    }
    if (fs.existsSync(`${basePath}.js`)) {
      return { url: pathToFileURL(`${basePath}.js`).href, shortCircuit: true };
    }
    if (fs.existsSync(`${basePath}.json`)) {
      return { url: pathToFileURL(`${basePath}.json`).href, shortCircuit: true };
    }
  }

  return defaultResolve(specifier, context, defaultResolve);
}

export async function load(url, context, defaultLoad) {
  if (url.endsWith('.json')) {
    const source = await readFile(new URL(url), 'utf8');
    return {
      format: 'module',
      source: `export default ${source};`,
      shortCircuit: true,
    };
  }

  return defaultLoad(url, context, defaultLoad);
}
