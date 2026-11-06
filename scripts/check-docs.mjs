#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS_PATH = 'AGENTS.md';
const README_PATH = 'README.md';
const RELEASE_CHECKLIST_PATH = 'RELEASE_CHECKLIST.md';
const DOCS_INDEX_PATH = 'docs/README.md';
const POST_REMEDIATION_PLAN_PATH = 'docs/POST_REMEDIATION_PLAN.md';
const RELEASE_PLAN_PATH = 'docs/RELEASE_PLAN.md';
const WORK_PLAN_PATH = 'docs/STATUS.md';

export const AGENTS_MAX_LINES = 250;
export const AGENTS_MAX_BYTES = 16 * 1024;
export const EXPECTED_WORKSTREAM_PATHS = Object.freeze([
  'docs/workstreams/A_BASELINE_AND_CONTAINMENT.md',
  'docs/workstreams/B_NETWORK_AND_WEBVIEW.md',
  'docs/workstreams/C_NATIVE_FOUNDATION_AND_FILES.md',
  'docs/workstreams/D_HEADLESS_AND_REALTIME.md',
  'docs/workstreams/E_SESSION_AND_NOTIFICATIONS.md',
  'docs/workstreams/F_PRIVACY_POLICY_AND_RELEASE_TRUTH.md',
  'docs/workstreams/G_DATABASE_OWNERSHIP.md',
  'docs/workstreams/H_UI_THEME_AND_ACCESSIBILITY.md',
  'docs/workstreams/I_RECOVERY_SCALE_AND_BACKUP.md',
  'docs/workstreams/J_PACKAGE_AND_ANDROID_FIT.md',
  'docs/workstreams/K_ARCHITECTURE_AND_DOCUMENTATION.md',
  'docs/workstreams/L_PRODUCT_BREADTH.md',
  'docs/workstreams/M_CANDIDATE_AND_RELEASE.md',
]);

const EXPECTED_INDEX_TARGETS = Object.freeze([
  README_PATH,
  AGENTS_PATH,
  RELEASE_CHECKLIST_PATH,
  RELEASE_PLAN_PATH,
  WORK_PLAN_PATH,
  POST_REMEDIATION_PLAN_PATH,
  'docs/DEVICE_VERIFICATION_CHECKLIST.md',
  'docs/STORE_01G_INTERNAL_TESTING_RUNBOOK.md',
  'docs/PUBLIC_RELEASE_LICENSING.md',
  'docs/APP_STACK_ADR.md',
  'docs/PHASE-DEPENDENCIES.md',
  'docs/APP_SERVER_PARITY.md',
  'docs/DB_02A_CURRENT.md',
  'docs/REL_004_LATE_RESULT_INVENTORY.md',
  'docs/REL_005A_TEARDOWN_INVENTORY.md',
  'docs/SESSION_SCOPED_STATE_INVENTORY.md',
  'docs/PUSH_DELIVERY.md',
  'docs/CACHE_ARCHITECTURE.md',
  'docs/UPLOAD_PROGRESS.md',
  'docs/SHARE_INTENT_RELIABILITY.md',
  'docs/RCS_BRIDGE_PLAN.md',
  'docs/RCS_SEND_RELIABILITY.md',
  'docs/RCS_FORWARD_RECONCILE_PLAN.md',
  'docs/UGC_SAFETY_CONTRACT.md',
  ...EXPECTED_WORKSTREAM_PATHS,
]);

const EXPECTED_ROOT_README_TARGETS = Object.freeze([
  AGENTS_PATH,
  RELEASE_CHECKLIST_PATH,
  DOCS_INDEX_PATH,
  RELEASE_PLAN_PATH,
  WORK_PLAN_PATH,
]);

function normalizedProjectPath(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join('/');
}

function pathEscapesRoot(root, absolutePath) {
  const pathFromRoot = relative(root, absolutePath);
  return pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot);
}

function exactPathError(root, projectPath) {
  const absolute = resolve(root, projectPath);
  if (pathEscapesRoot(root, absolute)) return 'escapes the repository root';

  const pathFromRoot = relative(root, absolute);
  const segments = pathFromRoot ? pathFromRoot.split(sep) : [];
  let current = root;
  for (const segment of segments) {
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      return 'does not exist';
    }
    if (!entries.includes(segment)) {
      const caseInsensitiveMatch = entries.find(
        (entry) => entry.toLocaleLowerCase('en-US') === segment.toLocaleLowerCase('en-US'),
      );
      return caseInsensitiveMatch
        ? `has incorrect casing; found ${caseInsensitiveMatch}`
        : 'does not exist';
    }
    current = join(current, segment);
  }
  return null;
}

function destinationFromMarkdown(rawDestination) {
  const trimmed = rawDestination.trim();
  if (trimmed.startsWith('<')) {
    const closing = trimmed.indexOf('>');
    return closing >= 0 ? trimmed.slice(1, closing) : trimmed;
  }
  return trimmed.split(/\s+/, 1)[0] ?? '';
}

function isExternalDestination(destination) {
  return /^[a-z][a-z0-9+.-]*:/i.test(destination) || destination.startsWith('//');
}

export function extractMarkdownLinks(source) {
  const links = [];
  const inlinePattern = /!?\[[^\]\r\n]*\]\(([^)\r\n]+)\)/g;
  for (const match of source.matchAll(inlinePattern)) {
    const destination = destinationFromMarkdown(match[1]);
    links.push({
      destination,
      line: source.slice(0, match.index).split('\n').length,
    });
  }
  const referencePattern = /^[ \t]{0,3}\[([^\]\r\n]+)\]:[ \t]*(<[^>\r\n]+>|[^\s\r\n]+)/gm;
  for (const match of source.matchAll(referencePattern)) {
    if (match[1].startsWith('^')) continue;
    links.push({
      destination: destinationFromMarkdown(match[2]),
      line: source.slice(0, match.index).split('\n').length,
    });
  }
  return links;
}

function resolveLocalDestination(root, sourcePath, destination) {
  if (!destination || destination.startsWith('#') || isExternalDestination(destination))
    return null;
  const pathWithoutQueryOrFragment = destination.split(/[?#]/, 1)[0];
  if (!pathWithoutQueryOrFragment) return null;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathWithoutQueryOrFragment);
  } catch {
    return { error: 'contains invalid percent encoding', projectPath: pathWithoutQueryOrFragment };
  }
  const absolute = resolve(root, dirname(sourcePath), decodedPath);
  return { projectPath: normalizedProjectPath(root, absolute) };
}

function directLocalTargets(root, sourcePath, source) {
  const targets = new Set();
  for (const link of extractMarkdownLinks(source)) {
    const resolved = resolveLocalDestination(root, sourcePath, link.destination);
    if (resolved && !resolved.error) targets.add(resolved.projectPath);
  }
  return targets;
}

export function listTrackedMarkdownFiles(root = ROOT) {
  const output = execFileSync('git', ['ls-files', '-z', '--', '*.md'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output.split('\0').filter(Boolean);
}

export function validateMarkdownLinks({ root, markdownFiles }) {
  const errors = [];
  let linkCount = 0;
  for (const sourcePath of markdownFiles) {
    const source = readFileSync(resolve(root, sourcePath), 'utf8');
    for (const link of extractMarkdownLinks(source)) {
      const target = resolveLocalDestination(root, sourcePath, link.destination);
      if (!target) continue;
      linkCount += 1;
      if (target.error) {
        errors.push(`${sourcePath}:${link.line} ${target.error}: ${link.destination}`);
        continue;
      }
      const pathError = exactPathError(root, target.projectPath);
      if (pathError) {
        errors.push(
          `${sourcePath}:${link.line} links to ${target.projectPath}, which ${pathError}`,
        );
      }
    }
  }
  return { errors, linkCount };
}

function validateNavigation({ root, rootReadme, docsIndex }) {
  const errors = [];
  const rootTargets = directLocalTargets(root, README_PATH, rootReadme);
  for (const target of EXPECTED_ROOT_README_TARGETS) {
    if (!rootTargets.has(target)) errors.push(`${README_PATH} does not link directly to ${target}`);
  }

  const indexTargets = directLocalTargets(root, DOCS_INDEX_PATH, docsIndex);
  for (const target of EXPECTED_INDEX_TARGETS) {
    if (!indexTargets.has(target))
      errors.push(`${DOCS_INDEX_PATH} does not link directly to ${target}`);
  }
  return errors;
}

function lineCount(source) {
  if (!source) return 0;
  const normalized = source.replaceAll('\r\n', '\n');
  return normalized.split('\n').length - (normalized.endsWith('\n') ? 1 : 0);
}

export function runDocumentationCheck({ root = ROOT } = {}) {
  const errors = [];
  const markdownFiles = listTrackedMarkdownFiles(root);
  if (!markdownFiles.includes(RELEASE_PLAN_PATH)) markdownFiles.push(RELEASE_PLAN_PATH);
  const linkResult = validateMarkdownLinks({ root, markdownFiles });
  errors.push(...linkResult.errors);

  const agentsSource = readFileSync(resolve(root, AGENTS_PATH), 'utf8');
  const agentsLines = lineCount(agentsSource);
  const agentsBytes = Buffer.byteLength(agentsSource);
  if (agentsLines > AGENTS_MAX_LINES) {
    errors.push(`${AGENTS_PATH} is ${agentsLines} lines; maximum is ${AGENTS_MAX_LINES}`);
  }
  if (agentsBytes > AGENTS_MAX_BYTES) {
    errors.push(`${AGENTS_PATH} is ${agentsBytes} bytes; maximum is ${AGENTS_MAX_BYTES}`);
  }

  const rootReadme = readFileSync(resolve(root, README_PATH), 'utf8');
  const docsIndex = readFileSync(resolve(root, DOCS_INDEX_PATH), 'utf8');
  errors.push(...validateNavigation({ root, rootReadme, docsIndex }));

  const planSource = readFileSync(resolve(root, WORK_PLAN_PATH), 'utf8');
  const releasePlanSource = readFileSync(resolve(root, RELEASE_PLAN_PATH), 'utf8');
  const remediationTargets = directLocalTargets(root, WORK_PLAN_PATH, planSource);
  const releaseTargets = directLocalTargets(root, RELEASE_PLAN_PATH, releasePlanSource);
  if (!remediationTargets.has(RELEASE_PLAN_PATH)) {
    errors.push(`${WORK_PLAN_PATH} does not link directly to ${RELEASE_PLAN_PATH}`);
  }
  if (!releaseTargets.has(WORK_PLAN_PATH)) {
    errors.push(`${RELEASE_PLAN_PATH} does not link directly to ${WORK_PLAN_PATH}`);
  }

  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  return {
    agentsBytes,
    agentsLines,
    localLinkCount: linkResult.linkCount,
    markdownFileCount: markdownFiles.length,
  };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    const result = runDocumentationCheck();
    console.log(
      `Documentation guard passed: ${result.markdownFileCount} tracked Markdown files / ${result.localLinkCount} local links; ${AGENTS_PATH} ${result.agentsLines} lines / ${result.agentsBytes} bytes.`,
    );
  } catch (error) {
    console.error(
      `Documentation guard failed:\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
