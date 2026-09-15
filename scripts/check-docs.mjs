#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
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
const WORK_PLAN_PATH = 'docs/WORK_PLAN_2026-08-03.md';

export const AGENTS_MAX_LINES = 250;
export const AGENTS_MAX_BYTES = 16 * 1024;
export const EXPECTED_PRIMARY_TASK_COUNT = 109;
export const EXPECTED_RELEASE_TASK_COUNT = 4;
export const EXPECTED_COMBINED_TASK_COUNT = 113;
export const EXPECTED_IMPLEMENTATION_MAPPING_COUNT = 107;
export const EXPECTED_RELEASE_IMPLEMENTATION_MAPPING_COUNT = 4;
export const EXPECTED_IMPLEMENTATION_MAPPING_SHA256 =
  '3c1a462408760270f54a13c3031f4381691b2a5ab3f9aa3659bbbd9afc1a45f7';
export const EXPECTED_RELEASE_MAPPING_SHA256 =
  'c994bda34e659f551aa10906b15c0e980381ca996bf94ed9af3f0d4baa850a71';
export const EXPECTED_RELEASE_TASK_IDS = Object.freeze([
  'RELEASE-01',
  'STORE-01',
  'RELEASE-02',
  'RELEASE-GATE-01',
]);

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

function taskHeadings(planSource) {
  return [...planSource.matchAll(/^(#{3,4}) \[([ x])\] `([^`]+)`/gm)].map((match) => ({
    checked: match[2] === 'x',
    id: match[3],
    index: match.index,
  }));
}

function parseStatusGroup(registerSource, status) {
  const headingPattern = new RegExp(
    `^- \\*\\*${status} — (\\d+):\\*\\*([\\s\\S]*?)(?=\\n- \\*\\*|(?![\\s\\S]))`,
    'm',
  );
  const match = headingPattern.exec(registerSource);
  if (!match) return null;
  return {
    declaredCount: Number(match[1]),
    ids: [...match[2].matchAll(/`([^`]+)`/g)].map((idMatch) => idMatch[1]),
  };
}

function implementationMappings(planSource, headings) {
  const mappings = [];
  const missing = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const nextIndex = headings[index + 1]?.index ?? planSource.length;
    const body = planSource.slice(heading.index, nextIndex);
    const links = [...body.matchAll(/\*\*Implementation spec:\*\* \[[^\]]+\]\(([^)]+)\)/g)];
    if (links.length === 0) {
      missing.push(heading.id);
      continue;
    }
    if (links.length === 1) mappings.push({ id: heading.id, target: links[0][1] });
    else mappings.push({ id: heading.id, target: null, duplicateCount: links.length });
  }
  return { mappings, missing };
}

export function validatePlanContract({ root, planSource }) {
  const errors = [];
  const headings = taskHeadings(planSource);
  const headingIds = headings.map((heading) => heading.id);
  const uniqueHeadingIds = new Set(headingIds);
  if (headings.length !== EXPECTED_PRIMARY_TASK_COUNT) {
    errors.push(
      `work plan has ${headings.length} primary task headings; expected ${EXPECTED_PRIMARY_TASK_COUNT}`,
    );
  }
  if (uniqueHeadingIds.size !== headings.length) {
    errors.push('work plan primary task headings must have unique ids');
  }

  const registerStart = planSource.indexOf('### Primary-task status register');
  const registerEnd = planSource.indexOf(
    '### Active, blocked, and historical evidence ledger',
    registerStart,
  );
  if (registerStart < 0 || registerEnd < 0) {
    errors.push('work plan status register boundaries are missing');
  }

  const statusById = new Map();
  if (registerStart >= 0 && registerEnd >= 0) {
    const registerSource = planSource.slice(registerStart, registerEnd);
    for (const status of ['DONE', 'IN_PROGRESS', 'BLOCKED', 'TODO']) {
      const group = parseStatusGroup(registerSource, status);
      if (!group) {
        errors.push(`work plan status register is missing ${status}`);
        continue;
      }
      if (group.declaredCount !== group.ids.length) {
        errors.push(
          `${status} declares ${group.declaredCount} tasks but lists ${group.ids.length}`,
        );
      }
      for (const id of group.ids) {
        if (statusById.has(id)) errors.push(`work plan status register repeats ${id}`);
        statusById.set(id, status);
      }
    }

    const waived = /^- \*\*WAIVED\/DROPPED — (\d+)\.\*\*/m.exec(registerSource);
    if (!waived) errors.push('work plan status register is missing WAIVED/DROPPED');
    else if (Number(waived[1]) !== 0) {
      errors.push('nonzero WAIVED/DROPPED tasks require an explicit checker representation');
    }
  }

  for (const heading of headings) {
    const status = statusById.get(heading.id);
    if (!status) errors.push(`primary task ${heading.id} is missing from the status register`);
    if ((status === 'DONE') !== heading.checked) {
      errors.push(
        `primary task ${heading.id} checkbox does not agree with register status ${String(status)}`,
      );
    }
  }
  for (const id of statusById.keys()) {
    if (!uniqueHeadingIds.has(id))
      errors.push(`status register id ${id} has no primary task heading`);
  }
  if (statusById.size !== EXPECTED_PRIMARY_TASK_COUNT) {
    errors.push(
      `work plan status register has ${statusById.size} unique ids; expected ${EXPECTED_PRIMARY_TASK_COUNT}`,
    );
  }

  const { mappings, missing } = implementationMappings(planSource, headings);
  const duplicateMappings = mappings.filter((mapping) => mapping.duplicateCount);
  for (const mapping of duplicateMappings) {
    errors.push(
      `primary task ${mapping.id} has ${mapping.duplicateCount} implementation-spec links; expected one`,
    );
  }
  const completeMappings = mappings.filter((mapping) => typeof mapping.target === 'string');
  if (completeMappings.length !== EXPECTED_IMPLEMENTATION_MAPPING_COUNT) {
    errors.push(
      `work plan has ${completeMappings.length} implementation-spec mappings; expected ${EXPECTED_IMPLEMENTATION_MAPPING_COUNT}`,
    );
  }
  const expectedMissing = ['LEGACY-01', 'LEGACY-02'];
  if (
    missing.length !== expectedMissing.length ||
    missing.some((id, index) => id !== expectedMissing[index])
  ) {
    errors.push(`tasks without implementation specs are ${missing.join(', ') || 'none'}`);
  }

  const mappingPayload = completeMappings
    .map((mapping) => `${mapping.id}\t${mapping.target}`)
    .join('\n');
  const mappingSha256 = createHash('sha256').update(`${mappingPayload}\n`).digest('hex');
  if (mappingSha256 !== EXPECTED_IMPLEMENTATION_MAPPING_SHA256) {
    errors.push(
      `implementation-spec mapping checksum is ${mappingSha256}; expected ${EXPECTED_IMPLEMENTATION_MAPPING_SHA256}`,
    );
  }

  const mappedWorkstreams = new Set();
  for (const mapping of completeMappings) {
    const [relativePath, encodedFragment] = mapping.target.split('#', 2);
    const absoluteTarget = resolve(root, dirname(WORK_PLAN_PATH), relativePath);
    const targetPath = normalizedProjectPath(root, absoluteTarget);
    mappedWorkstreams.add(targetPath);
    const pathError = exactPathError(root, targetPath);
    if (pathError) {
      errors.push(
        `implementation spec for ${mapping.id} targets ${targetPath}, which ${pathError}`,
      );
      continue;
    }
    if (!encodedFragment) {
      errors.push(`implementation spec for ${mapping.id} has no anchor`);
      continue;
    }
    let fragment;
    try {
      fragment = decodeURIComponent(encodedFragment);
    } catch {
      errors.push(`implementation spec for ${mapping.id} has an invalid encoded anchor`);
      continue;
    }
    const targetSource = readFileSync(absoluteTarget, 'utf8');
    if (!targetSource.includes(`<a id="${fragment}"></a>`)) {
      errors.push(`implementation spec for ${mapping.id} has no explicit #${fragment} anchor`);
    }
  }

  const expectedWorkstreamSet = new Set(EXPECTED_WORKSTREAM_PATHS);
  for (const workstreamPath of EXPECTED_WORKSTREAM_PATHS) {
    if (!mappedWorkstreams.has(workstreamPath)) {
      errors.push(`work plan does not map a task to ${workstreamPath}`);
    }
    const source = readFileSync(resolve(root, workstreamPath), 'utf8');
    const backlinkTargets = directLocalTargets(root, workstreamPath, source);
    if (!backlinkTargets.has(WORK_PLAN_PATH)) {
      errors.push(`${workstreamPath} does not link back to ${WORK_PLAN_PATH}`);
    }
    if (!source.includes('> **Document role:**') || !source.includes('completion evidence')) {
      errors.push(`${workstreamPath} does not declare its non-authoritative document role`);
    }
  }
  for (const workstreamPath of mappedWorkstreams) {
    if (!expectedWorkstreamSet.has(workstreamPath)) {
      errors.push(`work plan maps an implementation spec to unreviewed path ${workstreamPath}`);
    }
  }

  return {
    errors,
    implementationMappings: completeMappings,
    mappingCount: completeMappings.length,
    mappingSha256,
    primaryTaskCount: headings.length,
    taskIds: headingIds,
  };
}

export function validateReleasePlanContract({ root, planSource }) {
  const errors = [];
  const headings = taskHeadings(planSource);
  const headingIds = headings.map((heading) => heading.id);
  const uniqueHeadingIds = new Set(headingIds);

  if (headings.length !== EXPECTED_RELEASE_TASK_COUNT) {
    errors.push(
      `release plan has ${headings.length} primary task headings; expected ${EXPECTED_RELEASE_TASK_COUNT}`,
    );
  }
  if (uniqueHeadingIds.size !== headings.length) {
    errors.push('release plan primary task headings must have unique ids');
  }
  if (
    headingIds.length !== EXPECTED_RELEASE_TASK_IDS.length ||
    headingIds.some((id, index) => id !== EXPECTED_RELEASE_TASK_IDS[index])
  ) {
    errors.push(
      `release plan task ids are ${headingIds.join(', ') || 'none'}; expected ${EXPECTED_RELEASE_TASK_IDS.join(', ')}`,
    );
  }

  const registerStart = planSource.indexOf('## Status register');
  const registerEnd = planSource.indexOf('## Current candidate', registerStart);
  if (registerStart < 0 || registerEnd < 0) {
    errors.push('release plan status register boundaries are missing');
  }

  const statusById = new Map();
  if (registerStart >= 0 && registerEnd >= 0) {
    const registerSource = planSource.slice(registerStart, registerEnd);
    for (const status of ['DONE', 'IN_PROGRESS', 'BLOCKED', 'TODO']) {
      const group = parseStatusGroup(registerSource, status);
      if (!group) {
        errors.push(`release plan status register is missing ${status}`);
        continue;
      }
      if (group.declaredCount !== group.ids.length) {
        errors.push(
          `release plan ${status} declares ${group.declaredCount} tasks but lists ${group.ids.length}`,
        );
      }
      for (const id of group.ids) {
        if (statusById.has(id)) errors.push(`release plan status register repeats ${id}`);
        statusById.set(id, status);
      }
    }

    const waived = /^- \*\*WAIVED\/DROPPED — (\d+)\.\*\*/m.exec(registerSource);
    if (!waived) errors.push('release plan status register is missing WAIVED/DROPPED');
    else if (Number(waived[1]) !== 0) {
      errors.push(
        'nonzero release WAIVED/DROPPED tasks require an explicit checker representation',
      );
    }
  }

  for (const heading of headings) {
    const status = statusById.get(heading.id);
    if (!status) errors.push(`release task ${heading.id} is missing from the status register`);
    if ((status === 'DONE') !== heading.checked) {
      errors.push(
        `release task ${heading.id} checkbox does not agree with register status ${String(status)}`,
      );
    }
  }
  for (const id of statusById.keys()) {
    if (!uniqueHeadingIds.has(id)) {
      errors.push(`release status register id ${id} has no primary task heading`);
    }
  }
  if (statusById.size !== EXPECTED_RELEASE_TASK_COUNT) {
    errors.push(
      `release plan status register has ${statusById.size} unique ids; expected ${EXPECTED_RELEASE_TASK_COUNT}`,
    );
  }

  const { mappings, missing } = implementationMappings(planSource, headings);
  const duplicateMappings = mappings.filter((mapping) => mapping.duplicateCount);
  for (const mapping of duplicateMappings) {
    errors.push(
      `release task ${mapping.id} has ${mapping.duplicateCount} implementation-spec links; expected one`,
    );
  }
  const completeMappings = mappings.filter((mapping) => typeof mapping.target === 'string');
  if (missing.length > 0) {
    errors.push(`release tasks without implementation specs are ${missing.join(', ')}`);
  }
  if (completeMappings.length !== EXPECTED_RELEASE_IMPLEMENTATION_MAPPING_COUNT) {
    errors.push(
      `release plan has ${completeMappings.length} implementation-spec mappings; expected ${EXPECTED_RELEASE_IMPLEMENTATION_MAPPING_COUNT}`,
    );
  }

  const mappingPayload = completeMappings
    .map((mapping) => `${mapping.id}\t${mapping.target}`)
    .join('\n');
  const mappingSha256 = createHash('sha256').update(`${mappingPayload}\n`).digest('hex');
  if (mappingSha256 !== EXPECTED_RELEASE_MAPPING_SHA256) {
    errors.push(
      `release implementation-spec mapping checksum is ${mappingSha256}; expected ${EXPECTED_RELEASE_MAPPING_SHA256}`,
    );
  }

  const mappedWorkstreams = new Set();
  for (const mapping of completeMappings) {
    const [relativePath, encodedFragment] = mapping.target.split('#', 2);
    const absoluteTarget = resolve(root, dirname(RELEASE_PLAN_PATH), relativePath);
    const targetPath = normalizedProjectPath(root, absoluteTarget);
    mappedWorkstreams.add(targetPath);
    const pathError = exactPathError(root, targetPath);
    if (pathError) {
      errors.push(
        `implementation spec for release task ${mapping.id} targets ${targetPath}, which ${pathError}`,
      );
      continue;
    }
    if (!encodedFragment) {
      errors.push(`implementation spec for release task ${mapping.id} has no anchor`);
      continue;
    }
    let fragment;
    try {
      fragment = decodeURIComponent(encodedFragment);
    } catch {
      errors.push(
        `implementation spec for release task ${mapping.id} has an invalid encoded anchor`,
      );
      continue;
    }
    const targetSource = readFileSync(absoluteTarget, 'utf8');
    if (!targetSource.includes(`<a id="${fragment}"></a>`)) {
      errors.push(
        `implementation spec for release task ${mapping.id} has no explicit #${fragment} anchor`,
      );
    }
  }

  const expectedReleaseWorkstreams = new Set([
    'docs/workstreams/J_PACKAGE_AND_ANDROID_FIT.md',
    'docs/workstreams/M_CANDIDATE_AND_RELEASE.md',
  ]);
  for (const workstreamPath of expectedReleaseWorkstreams) {
    if (!mappedWorkstreams.has(workstreamPath)) {
      errors.push(`release plan does not map a task to ${workstreamPath}`);
    }
    const source = readFileSync(resolve(root, workstreamPath), 'utf8');
    const backlinkTargets = directLocalTargets(root, workstreamPath, source);
    if (!backlinkTargets.has(RELEASE_PLAN_PATH)) {
      errors.push(`${workstreamPath} does not link back to ${RELEASE_PLAN_PATH}`);
    }
  }
  for (const workstreamPath of mappedWorkstreams) {
    if (!expectedReleaseWorkstreams.has(workstreamPath)) {
      errors.push(`release plan maps an implementation spec to unreviewed path ${workstreamPath}`);
    }
  }

  return {
    errors,
    implementationMappings: completeMappings,
    mappingCount: completeMappings.length,
    mappingSha256,
    primaryTaskCount: headings.length,
    taskIds: headingIds,
  };
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

export function validatePlanSeparation({ remediationTaskIds, releaseTaskIds }) {
  const errors = [];
  const remediationIds = new Set(remediationTaskIds);
  const overlappingIds = releaseTaskIds.filter((id) => remediationIds.has(id));
  if (overlappingIds.length > 0) {
    errors.push(`task ids appear in both plans: ${overlappingIds.join(', ')}`);
  }
  const combinedIds = new Set([...remediationTaskIds, ...releaseTaskIds]);
  if (combinedIds.size !== EXPECTED_COMBINED_TASK_COUNT) {
    errors.push(
      `combined plans have ${combinedIds.size} unique task ids; expected ${EXPECTED_COMBINED_TASK_COUNT}`,
    );
  }
  return errors;
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
  const planResult = validatePlanContract({ root, planSource });
  errors.push(...planResult.errors);

  const releasePlanSource = readFileSync(resolve(root, RELEASE_PLAN_PATH), 'utf8');
  const releasePlanResult = validateReleasePlanContract({ root, planSource: releasePlanSource });
  errors.push(...releasePlanResult.errors);

  errors.push(
    ...validatePlanSeparation({
      remediationTaskIds: planResult.taskIds,
      releaseTaskIds: releasePlanResult.taskIds,
    }),
  );

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
    implementationMappingCount: planResult.mappingCount,
    implementationMappingSha256: planResult.mappingSha256,
    localLinkCount: linkResult.linkCount,
    markdownFileCount: markdownFiles.length,
    primaryTaskCount: planResult.primaryTaskCount,
    releaseMappingCount: releasePlanResult.mappingCount,
    releaseMappingSha256: releasePlanResult.mappingSha256,
    releaseTaskCount: releasePlanResult.primaryTaskCount,
    workstreamCount: EXPECTED_WORKSTREAM_PATHS.length,
  };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    const result = runDocumentationCheck();
    console.log(
      `Documentation guard passed: ${result.markdownFileCount} tracked Markdown files / ${result.localLinkCount} local links; ${result.primaryTaskCount} remediation tasks / ${result.releaseTaskCount} release tasks; ${result.implementationMappingCount} remediation mappings / ${result.releaseMappingCount} release mappings across ${result.workstreamCount} workstreams; AGENTS.md ${result.agentsLines} lines / ${result.agentsBytes} bytes; mappings ${result.implementationMappingSha256} / ${result.releaseMappingSha256}.`,
    );
  } catch (error) {
    console.error(
      `Documentation guard failed:\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
