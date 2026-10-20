#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isLegalFileName } from './legal-file-name.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY_PATH = 'legal/generated/legal-inventory.json';
const REPORT_PATH = 'legal/generated/THIRD_PARTY_NOTICES.generated.md';
const RUNTIME_PATH = 'src/generated/legalNotices.ts';
const ASSET_EXTENSION =
  /\.(?:png|jpe?g|gif|webp|svg|ttf|otf|woff2?|mp3|wav|ogg|m4a|mp4|webm|tflite)$/i;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0'))
    throw new Error('invalid project path');
  const clean = value.replaceAll('\\', '/');
  if (
    isAbsolute(clean) ||
    /^[A-Za-z]:\//.test(clean) ||
    clean.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`project path escapes root: ${value}`);
  }
  return clean;
}

function pathState(root, projectPath) {
  const clean = normalizedPath(projectPath);
  let cursor = root;
  for (const segment of clean.split('/')) {
    cursor = resolve(cursor, segment);
    const fromRoot = relative(root, cursor);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
      return { error: 'path escapes root' };
    if (!existsSync(cursor)) return { error: 'path is missing' };
    const state = lstatSync(cursor);
    if (state.isSymbolicLink()) return { error: `symbolic link is not followed: ${clean}` };
  }
  return { path: cursor, state: lstatSync(cursor) };
}

function packageNameFromPath(projectPath) {
  const tail = projectPath.slice(projectPath.lastIndexOf('node_modules/') + 13).split('/');
  return tail[0]?.startsWith('@') ? `${tail[0]}/${tail[1]}` : tail[0];
}

function scanLegalFiles(packageRoot) {
  const documents = [];
  const issues = [];
  function walk(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      const child = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        issues.push(`symbolic link skipped: ${childPrefix}`);
      } else if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          /^(?:android|ios)\/build(?:\/|$)|(?:^|\/)\.(?:cxx|gradle|kotlin)(?:\/|$)/.test(
            childPrefix,
          )
        )
          continue;
        walk(child, childPrefix);
      } else if (entry.isFile() && isLegalFileName(entry.name)) {
        const bytes = readFileSync(child);
        const text = bytes.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(bytes))
          issues.push(`legal text is not UTF-8: ${childPrefix}`);
        documents.push({ path: childPrefix, bytes: bytes.length, sha256: sha256(bytes), text });
      }
    }
  }
  walk(packageRoot);
  return { documents, issues };
}

/**
 * Fingerprint of the locked dependency set: package-lock.json without the app's own version (the
 * top-level and root-package `version` fields). A release version bump changes only those, so it
 * must not make the generated notices, or their in-app copy, stale.
 */
export function dependencyLockSha256(packageLockSource) {
  const lock = JSON.parse(packageLockSource);
  delete lock.version;
  if (lock.packages?.['']) delete lock.packages[''].version;
  return sha256(JSON.stringify(lock));
}

export function collectProductionPackages(root, packageLock) {
  if (packageLock?.lockfileVersion !== 3 || !packageLock.packages)
    throw new Error('package-lock.json must use lockfileVersion 3');
  const records = [];
  const texts = new Map();
  const entries = Object.entries(packageLock.packages)
    .filter(([projectPath, entry]) => projectPath.includes('node_modules/') && entry?.dev !== true)
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [installPath, entry] of entries) {
    const issues = [];
    const state = pathState(root, installPath);
    let installed = null;
    let documents = [];
    if (state.error || !state.state?.isDirectory()) {
      issues.push(state.error ?? 'package path is not a directory');
    } else {
      try {
        installed = JSON.parse(readFileSync(resolve(state.path, 'package.json'), 'utf8'));
      } catch {
        issues.push('installed package.json is missing or invalid');
      }
      const scanned = scanLegalFiles(state.path);
      documents = scanned.documents;
      issues.push(...scanned.issues);
    }
    if (typeof entry.license !== 'string' || entry.license.length === 0)
      issues.push('lockfile license is missing');
    if (typeof entry.license === 'string' && /(?:^|[ (])OR(?:[ )]|$)/.test(entry.license))
      issues.push('license choice requires review');
    if (installed?.version !== entry.version)
      issues.push('installed version does not match lockfile');
    if (documents.length === 0) issues.push('no legal text file found');
    const legalDocuments = documents.map(({ path, bytes, sha256: hash, text }) => {
      const source = `${installPath}/${path}`;
      const prior = texts.get(hash) ?? { sha256: hash, bytes, text, sources: [] };
      prior.sources.push(source);
      texts.set(hash, prior);
      return { path, bytes, sha256: hash };
    });
    records.push({
      installPath,
      name: installed?.name ?? packageNameFromPath(installPath),
      version: entry.version ?? null,
      spdx: typeof entry.license === 'string' ? entry.license : null,
      resolved: entry.resolved ?? null,
      integrity: entry.integrity ?? null,
      optional: entry.optional === true,
      legalDocuments,
      issues: [...new Set(issues)].sort(),
    });
  }
  const legalTexts = [...texts.values()]
    .map((item) => ({ ...item, sources: item.sources.sort() }))
    .sort((a, b) => a.sha256.localeCompare(b.sha256));
  return { records, legalTexts };
}

function sourceFiles(root) {
  // Inventory the actual checkout, not only the index. New active plugins/assets must not be
  // invisible before git add. Keep missing tracked paths so reconciliation reports their absence;
  // staged deletions disappear unless a nonignored working-tree file still exists at that path.
  const paths = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      'assets',
      'store-assets',
      'modules',
      'plugins',
    ],
    { cwd: root },
  )
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  return [...new Set(paths)].sort();
}

function hashedFile(root, projectPath) {
  const state = pathState(root, projectPath);
  if (state.error || !state.state?.isFile())
    return {
      path: projectPath,
      sha256: null,
      bytes: null,
      issue: state.error ?? 'not a regular file',
    };
  const bytes = readFileSync(state.path);
  return { path: projectPath, sha256: sha256(bytes), bytes: bytes.length };
}

function indexedRecords(records, label) {
  const indexed = new Map();
  for (const item of records ?? []) {
    const path = normalizedPath(item.path);
    if (indexed.has(path)) throw new Error(`duplicate ${label} provenance: ${path}`);
    indexed.set(path, item);
  }
  return indexed;
}

export function collectAssetsAndComponents(root, provenance, sourcePaths) {
  const filesInScope = [...new Set(sourcePaths)].sort();
  const declaredAssets = indexedRecords(provenance.assets, 'asset');
  const assets = filesInScope
    .filter((path) => /^(?:assets|store-assets)\//.test(path) && ASSET_EXTENSION.test(path))
    .map((path) => ({
      ...hashedFile(root, path),
      provenanceStatus: declaredAssets.get(path)?.provenanceStatus ?? 'missing',
    }));
  const staleAssets = [...declaredAssets.keys()].filter(
    (path) => !assets.some((asset) => asset.path === path),
  );
  const declaredComponents = indexedRecords(provenance.localComponents, 'local-component');
  const discoveredComponents = new Set();
  for (const path of filesInScope) {
    // Git lists a module-root symlink without a trailing slash. Keep it in the inventory so
    // hashedFile reports it as unreadable rather than silently omitting the component.
    const module = /^(modules\/gator-[^/]+)(?:\/|$)/.exec(path)?.[1];
    if (module) discoveredComponents.add(module);
    if (/^plugins\/[^/]+\.js$/.test(path)) discoveredComponents.add(path);
  }
  const localComponents = [...discoveredComponents].sort().map((path) => {
    const item = declaredComponents.get(path);
    const files = filesInScope
      .filter((file) => file === path || file.startsWith(`${path}/`))
      .map((file) => hashedFile(root, file));
    const digest = files.length
      ? sha256(files.map((file) => `${file.path}\0${file.sha256}\n`).join(''))
      : null;
    return {
      path,
      provenanceStatus: item?.provenanceStatus ?? 'missing',
      files: files.length,
      sha256: digest,
      issue: files.some((file) => file.issue)
        ? 'component contains an unreadable source file'
        : null,
    };
  });
  const staleComponents = [...declaredComponents.keys()].filter(
    (path) => !discoveredComponents.has(path),
  );
  return { assets, staleAssets, localComponents, staleComponents };
}

function renderMarkdown(inventory) {
  const out = [
    '# Generated conservative dependency and asset inventory',
    '',
    '> Generated from the current lockfile and tracked/nonignored working-tree source assets. This is not legal approval and does not prove exact AAB coverage.',
    '',
    `- Dependency lock SHA-256 (package-lock.json without the app's own version): \`${inventory.inputs.dependencyLockSha256}\``,
    `- Production package records: ${inventory.summary.productionPackageRecords}`,
    `- Unique package versions: ${inventory.summary.uniquePackageVersions}`,
    `- Source assets: ${inventory.summary.assetFiles}`,
    `- Pending asset provenance: ${inventory.summary.pendingAssetProvenance}`,
    `- Local components: ${inventory.summary.localComponents}`,
    `- Package records needing review: ${inventory.summary.unresolvedPackageRecords}`,
    '- Exact AAB coverage: **absent**',
    '',
    '## Assets',
    '',
    '| Path | Bytes | SHA-256 | Provenance |',
    '| --- | ---: | --- | --- |',
    ...inventory.assets.map(
      (a) =>
        `| \`${a.path}\` | ${a.bytes ?? '—'} | \`${a.sha256 ?? 'unavailable'}\` | ${a.provenanceStatus} |`,
    ),
    '',
    '## Local components',
    '',
    '| Path | Files | Aggregate SHA-256 | Provenance |',
    '| --- | ---: | --- | --- |',
    ...inventory.localComponents.map(
      (c) =>
        `| \`${c.path}\` | ${c.files} | \`${c.sha256 ?? 'unavailable'}\` | ${c.provenanceStatus} |`,
    ),
    '',
    '## Conservative package closure',
    '',
    '| Package | Version | SPDX | Optional | Legal-text hashes | Open issues |',
    '| --- | --- | --- | --- | --- | --- |',
    ...inventory.productionPackages.map(
      (p) =>
        `| \`${p.name}\` | \`${p.version ?? 'unknown'}\` | ${p.spdx ?? '**missing**'} | ${p.optional ? 'yes' : 'no'} | ${p.legalDocuments.map((d) => `\`${d.sha256}\``).join('<br>') || 'none'} | ${p.issues.join('; ') || 'none'} |`,
    ),
    '',
    '## Deduplicated legal-text index',
    '',
    '| SHA-256 | Bytes | Source files |',
    '| --- | ---: | ---: |',
    ...inventory.legalTexts.map(
      (text) => `| \`${text.sha256}\` | ${text.bytes} | ${text.sources.length} |`,
    ),
    '',
  ];
  // `out` deliberately ends with one empty item, so joining already emits the conventional
  // single trailing newline. Appending another one makes the generated file fail `git diff
  // --check` when it is first added to a repository.
  return out.join('\n');
}

function textExport(name, value) {
  const literal = value.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${');
  return `export const ${name} = \`${literal}\`;\n`;
}

export function markdownToPlainText(source) {
  return source
    .split('\n')
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, '')
        .replace(/^>\s?/, '')
        .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1'),
    )
    .join('\n');
}

function renderRuntime(projectNotice, thirdPartyNotices, summary) {
  const summarySource = Object.entries(summary)
    .map(([key, value]) => `  ${key}: ${typeof value === 'string' ? `'${value}'` : String(value)},`)
    .join('\n');
  return `// Generated by scripts/legal-inventory.mjs. Do not edit.\n\n${textExport('PROJECT_NOTICE_TEXT', projectNotice)}\n${textExport('THIRD_PARTY_NOTICES_TEXT', markdownToPlainText(thirdPartyNotices))}\nexport const LEGAL_INVENTORY_SUMMARY = Object.freeze({\n${summarySource}\n} as const);\n`;
}

export function buildInventory(root = ROOT, sourcePaths = sourceFiles(root)) {
  const packageLockSource = readFileSync(resolve(root, 'package-lock.json'));
  const projectNotice = readFileSync(resolve(root, 'LICENSE'), 'utf8');
  const thirdPartyNotices = readFileSync(resolve(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const packageLock = JSON.parse(packageLockSource);
  const provenance = JSON.parse(readFileSync(resolve(root, 'legal/asset-provenance.json'), 'utf8'));
  const packages = collectProductionPackages(root, packageLock);
  const files = collectAssetsAndComponents(root, provenance, sourcePaths);
  const uniquePackageVersions = new Set(
    packages.records.map((item) => `${item.name}@${item.version}`),
  ).size;
  const summary = {
    productionPackageRecords: packages.records.length,
    uniquePackageVersions,
    assetFiles: files.assets.length,
    pendingAssetProvenance: files.assets.filter((item) => item.provenanceStatus !== 'approved')
      .length,
    localComponents: files.localComponents.length,
    dependencyLockSha256: dependencyLockSha256(packageLockSource),
    unresolvedPackageRecords: packages.records.filter((item) => item.issues.length > 0).length,
    exactAabCoverage: false,
  };
  return {
    inventory: {
      schemaVersion: 1,
      coverage: { npm: 'conservative-production-closure', exactAab: false },
      inputs: {
        dependencyLockSha256: summary.dependencyLockSha256,
        projectNoticeSha256: sha256(projectNotice),
        thirdPartyNoticesSha256: sha256(thirdPartyNotices),
        assetProvenanceSha256: sha256(readFileSync(resolve(root, 'legal/asset-provenance.json'))),
      },
      summary,
      inventoryIssues: [
        ...files.assets
          .filter((item) => item.provenanceStatus === 'missing')
          .map((item) => `missing asset provenance: ${item.path}`),
        ...files.assets
          .filter((item) => item.issue)
          .map((item) => `unreadable asset: ${item.path}`),
        ...files.staleAssets.map((path) => `stale asset provenance: ${path}`),
        ...files.localComponents
          .filter((item) => item.provenanceStatus === 'missing')
          .map((item) => `missing local-component provenance: ${item.path}`),
        ...files.localComponents
          .filter((item) => item.issue)
          .map((item) => `unreadable local component: ${item.path}`),
        ...files.staleComponents.map((path) => `stale local-component provenance: ${path}`),
      ],
      productionPackages: packages.records,
      legalTexts: packages.legalTexts,
      assets: files.assets,
      localComponents: files.localComponents,
    },
    projectNotice,
    thirdPartyNotices,
  };
}

export function generatedOutputs(root = ROOT) {
  const built = buildInventory(root);
  const json = `${JSON.stringify(built.inventory, null, 2)}\n`;
  return new Map([
    [INVENTORY_PATH, json],
    [REPORT_PATH, renderMarkdown(built.inventory)],
    [
      RUNTIME_PATH,
      renderRuntime(built.projectNotice, built.thirdPartyNotices, built.inventory.summary),
    ],
  ]);
}

export function releaseCheckErrors(inventory) {
  const errors = [];
  if (!inventory.coverage.exactAab)
    errors.push('exact AAB dependency/font/model/native-library coverage is absent');
  if (inventory.summary.unresolvedPackageRecords)
    errors.push(`${inventory.summary.unresolvedPackageRecords} package records need review`);
  if (inventory.summary.pendingAssetProvenance)
    errors.push(`${inventory.summary.pendingAssetProvenance} assets have unresolved provenance`);
  const pendingComponents = inventory.localComponents.filter(
    (item) => item.provenanceStatus !== 'approved' || item.issue,
  ).length;
  if (pendingComponents)
    errors.push(`${pendingComponents} local components have unresolved provenance`);
  errors.push(...inventory.inventoryIssues);
  return errors;
}

function run(mode) {
  const outputs = generatedOutputs(ROOT);
  if (mode === '--write') {
    for (const [projectPath, source] of outputs) {
      mkdirSync(dirname(resolve(ROOT, projectPath)), { recursive: true });
      writeFileSync(resolve(ROOT, projectPath), source);
    }
  } else {
    const stale = [...outputs]
      .filter(
        ([projectPath, source]) =>
          !existsSync(resolve(ROOT, projectPath)) ||
          readFileSync(resolve(ROOT, projectPath), 'utf8') !== source,
      )
      .map(([path]) => path);
    if (stale.length) throw new Error(`generated legal inventory is stale: ${stale.join(', ')}`);
  }
  const inventory = JSON.parse(outputs.get(INVENTORY_PATH));
  if (mode === '--release-check') {
    const errors = releaseCheckErrors(inventory);
    if (errors.length) throw new Error(`legal release check failed:\n- ${errors.join('\n- ')}`);
  }
  const s = inventory.summary;
  process.stdout.write(
    `Legal inventory ${mode === '--write' ? 'generated' : 'check passed'}: ${s.productionPackageRecords} package records, ${s.uniquePackageVersions} unique package versions, ${s.assetFiles} assets (${s.pendingAssetProvenance} pending), ${s.localComponents} local components, ${s.unresolvedPackageRecords} package records need review; exact AAB coverage absent.\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? '--check';
  if (!['--write', '--check', '--release-check'].includes(mode) || process.argv.length > 3) {
    process.stderr.write(
      'Usage: node scripts/legal-inventory.mjs [--write|--check|--release-check]\n',
    );
    process.exitCode = 2;
  } else {
    try {
      run(mode);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
