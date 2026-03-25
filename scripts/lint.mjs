import fs from 'fs/promises';
import path from 'path';
import babelParser from 'next/dist/compiled/babel/parser.js';

const { parse } = babelParser;

const ROOT_DIR = process.cwd();
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs']);
const RESOLVABLE_EXTENSIONS = ['', '.js', '.jsx', '.mjs', '.json', '.css'];
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', '.next', 'storage', 'videos', '.cache']);
const IGNORED_PREFIXES = ['blockchain/'];

function shouldIgnore(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  if (!normalized) {
    return false;
  }

  if (IGNORED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }

  return normalized.split('/').some((segment) => IGNORED_DIRECTORIES.has(segment));
}

async function collectSourceFiles(currentDir = ROOT_DIR, files = []) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(ROOT_DIR, absolutePath).replace(/\\/g, '/');

    if (shouldIgnore(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      await collectSourceFiles(absolutePath, files);
      continue;
    }

    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push({ absolutePath, relativePath });
    }
  }

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') {
    return;
  }

  visit(node);

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, visit);
      }
      continue;
    }

    walk(value, visit);
  }
}

function resolveImport(fromFile, specifier) {
  if (!(specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('@/'))) {
    return true;
  }

  const basePath = specifier.startsWith('@/')
    ? path.join(ROOT_DIR, specifier.slice(2))
    : path.resolve(path.dirname(fromFile), specifier);

  const candidates = [];
  for (const extension of RESOLVABLE_EXTENSIONS) {
    candidates.push(`${basePath}${extension}`);
  }
  for (const extension of RESOLVABLE_EXTENSIONS.filter(Boolean)) {
    candidates.push(path.join(basePath, `index${extension}`));
  }

  return candidates;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function lintFile(file) {
  const source = await fs.readFile(file.absolutePath, 'utf8');
  const errors = [];

  try {
    const ast = parse(source, {
      sourceType: 'unambiguous',
      plugins: [
        'jsx',
        'importAttributes',
        'dynamicImport',
        'classProperties',
        'objectRestSpread',
        'topLevelAwait',
        'optionalChaining',
        'nullishCoalescingOperator',
      ],
    });

    const imports = [];
    walk(ast, (node) => {
      if ((node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') && node.source?.value) {
        imports.push(String(node.source.value));
      }
      if (node.type === 'CallExpression' && node.callee?.type === 'Import' && node.arguments?.[0]?.type === 'StringLiteral') {
        imports.push(String(node.arguments[0].value));
      }
    });

    for (const specifier of imports) {
      const resolution = resolveImport(file.absolutePath, specifier);
      if (resolution === true) {
        continue;
      }

      let found = false;
      for (const candidate of resolution) {
        if (await pathExists(candidate)) {
          found = true;
          break;
        }
      }

      if (!found) {
        errors.push(`Unresolved import '${specifier}'`);
      }
    }
  } catch (error) {
    errors.push(error.message);
  }

  return errors;
}

const files = await collectSourceFiles();
const failures = [];

for (const file of files) {
  const errors = await lintFile(file);
  if (errors.length > 0) {
    failures.push({ file: file.relativePath, errors });
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[lint] ${failure.file}`);
    for (const error of failure.errors) {
      console.error(`  - ${error}`);
    }
  }
  process.exit(1);
}

console.log(`[lint] OK - checked ${files.length} source files.`);
