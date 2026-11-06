#!/usr/bin/env node
// Workflow supply-chain guard: the security properties of every GitHub Actions workflow, and only
// those. Step order, Gradle task lists and other process detail are reviewed in the pull request,
// not pinned here (fix plan D-4, 2026-11-06).
//
//   1. Every `uses:` is pinned to a full commit SHA with a readable version comment.
//   2. Every workflow has a root `permissions:` block and every permissions block grants only
//      `contents: read`.
//   3. No workflow uses `pull_request_target`; a workflow that runs on push or pull_request declares
//      a concurrency group with `cancel-in-progress`.
//   4. Every checkout sets `persist-credentials: false`.
//   5. In every job that runs `npm ci`, the toolchain guard (`node scripts/check-toolchain.mjs`)
//      runs first, and the install step is unconditional.
//   6. ci.yml keeps its gates: dependency review on pull requests failing on high severity, this
//      guard's own test and validator before the install, a full-history checkout for the secret
//      hygiene scan, and a blocking dependency audit as the last step of the check job.
//   7. Dependabot covers npm (preserving exact pins) and github-actions.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKFLOW_DIRECTORY = '.github/workflows';
export const CI_WORKFLOW = 'ci.yml';
const DEFAULT_DEPENDABOT = '.github/dependabot.yml';
const FULL_COMMIT_SHA = /^[a-f0-9]{40}$/i;
const READABLE_VERSION = /^v\d+\.\d+\.\d+(?:\s|$)/;
const TOOLCHAIN_GUARD_COMMAND = 'node scripts/check-toolchain.mjs';
const INSTALL_COMMAND = 'npm ci';
const SUPPLY_CHAIN_GUARD_LINES = [
  'node --test scripts/check-workflow-security.test.mjs',
  'node scripts/check-workflow-security.mjs',
];
export const DEPENDENCY_AUDIT_NAME = 'Dependency audit (reviewed exceptions only)';
const DEPENDENCY_AUDIT_LINES = [
  'node --test scripts/check-npm-audit.test.mjs',
  'node scripts/check-npm-audit.mjs',
];

function linesOf(source) {
  return source.replaceAll('\r\n', '\n').split('\n');
}

function indentation(line) {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function isLive(line) {
  return line.trim() && !line.trimStart().startsWith('#');
}

/** The block starting at the first line matching `startPattern`, through its deeper-indented lines. */
function extractIndentedBlock(source, startPattern) {
  const lines = linesOf(source);
  const start = lines.findIndex((line) => startPattern.test(line));
  if (start < 0) return undefined;
  const baseIndent = indentation(lines[start]);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (isLive(line) && indentation(line) <= baseIndent) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

/** Every child block of `parent` whose header sits exactly at `indent` spaces. */
function childBlocks(parent, indent) {
  const lines = linesOf(parent);
  const blocks = [];
  let current = null;
  for (const line of lines.slice(1)) {
    if (isLive(line) && indentation(line) === indent) {
      if (current) blocks.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current.join('\n'));
  return blocks;
}

function jobsOf(workflow) {
  const jobs = extractIndentedBlock(workflow, /^jobs:\s*$/);
  if (!jobs) return new Map();
  return new Map(
    childBlocks(jobs, 2).map((block) => [linesOf(block)[0].trim().replace(/:\s*$/, ''), block]),
  );
}

function stepsOf(job) {
  const steps = extractIndentedBlock(job, /^    steps:\s*$/);
  return steps ? childBlocks(steps, 6) : [];
}

function stepName(step) {
  return step.match(/^\s*-?\s*name:\s*(.+?)\s*$/m)?.[1];
}

function stepRunLines(step) {
  const lines = linesOf(step);
  const runIndex = lines.findIndex((line) => /^\s*run:/.test(line));
  if (runIndex < 0) return [];
  const inline = lines[runIndex].match(/^\s*run:\s*(.+)$/)?.[1]?.trim();
  if (inline && inline !== '|' && inline !== '>-' && inline !== '>') return [inline];
  return lines
    .slice(runIndex + 1)
    .filter(isLive)
    .map((line) => line.trim());
}

function isConditionalOrSoft(step) {
  return (
    /^\s*if\s*:/m.test(step) || /^\s*continue-on-error\s*:/m.test(step) || /\|\|\s*true/.test(step)
  );
}

export function validateActionPins(workflow, errors, file) {
  for (const match of workflow.matchAll(/^\s*(?:-\s+)?uses:\s*([^\r\n]+)$/gm)) {
    const raw = match[1].trim();
    const commentIndex = raw.indexOf('#');
    const target = (commentIndex >= 0 ? raw.slice(0, commentIndex) : raw).trim();
    const comment = commentIndex >= 0 ? raw.slice(commentIndex + 1).trim() : '';
    if (target.startsWith('./')) continue;
    const at = target.lastIndexOf('@');
    const action = at > 0 ? target.slice(0, at) : target;
    const ref = at > 0 ? target.slice(at + 1) : '';
    if (!action.includes('/') || !FULL_COMMIT_SHA.test(ref)) {
      errors.push(`${file}: ${target} must be pinned to a full 40-character commit SHA.`);
    }
    if (!READABLE_VERSION.test(comment)) {
      errors.push(`${file}: ${target} must carry a readable version comment such as "# v7.0.1".`);
    }
  }
}

export function validatePermissions(workflow, errors, file) {
  const lines = linesOf(workflow);
  let rootSeen = false;
  lines.forEach((line, index) => {
    const match = line.match(/^(\s*)permissions:\s*(.*)$/);
    if (!match) return;
    const indent = match[1].length;
    if (indent === 0) rootSeen = true;
    const inline = match[2].trim();
    const entries = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const child = lines[cursor];
      if (isLive(child) && indentation(child) <= indent) break;
      const entry = child.match(/^\s+([A-Za-z-]+):\s*([^#\s]+)\s*(?:#.*)?$/);
      if (entry) entries.push(entry);
    }
    const contentsReadOnly =
      inline === '' &&
      entries.length === 1 &&
      entries[0][1] === 'contents' &&
      entries[0][2] === 'read';
    if (!contentsReadOnly) {
      errors.push(`${file}: every permissions block must grant only "contents: read".`);
    }
  });
  if (!rootSeen) errors.push(`${file}: a root permissions block is required.`);
}

export function validateTriggers(workflow, errors, file) {
  const triggers = extractIndentedBlock(workflow, /^on:\s*$/);
  if (!triggers) {
    errors.push(`${file}: event triggers must be a block under "on:".`);
    return;
  }
  const events = childBlocks(triggers, 2).map((block) =>
    linesOf(block)[0].trim().replace(/:.*$/, ''),
  );
  if (events.includes('pull_request_target')) {
    errors.push(`${file}: pull_request_target runs fork code with secrets; use pull_request.`);
  }
  if (events.includes('push') || events.includes('pull_request')) {
    const concurrency = extractIndentedBlock(workflow, /^concurrency:\s*$/);
    if (
      !concurrency ||
      !/^\s*group:\s*\S/m.test(concurrency) ||
      !/^\s*cancel-in-progress:\s*\S/m.test(concurrency)
    ) {
      errors.push(
        `${file}: push and pull_request workflows need a concurrency group with cancel-in-progress.`,
      );
    }
  }
}

export function validateCheckouts(workflow, errors, file) {
  for (const job of jobsOf(workflow).values()) {
    for (const step of stepsOf(job)) {
      if (!/^\s*-?\s*uses:\s*actions\/checkout@/m.test(step)) continue;
      if (!/^\s*persist-credentials:\s*false\s*$/m.test(step)) {
        errors.push(`${file}: every actions/checkout step must set persist-credentials: false.`);
      }
    }
  }
}

export function validateInstallOrder(workflow, errors, file) {
  for (const [name, job] of jobsOf(workflow)) {
    const steps = stepsOf(job);
    const installIndex = steps.findIndex((step) => stepRunLines(step).includes(INSTALL_COMMAND));
    if (installIndex < 0) continue;
    const guardIndex = steps.findIndex((step) =>
      stepRunLines(step).includes(TOOLCHAIN_GUARD_COMMAND),
    );
    if (guardIndex < 0 || guardIndex >= installIndex) {
      errors.push(
        `${file}: job "${name}" must run ${TOOLCHAIN_GUARD_COMMAND} before ${INSTALL_COMMAND}.`,
      );
    }
    if (isConditionalOrSoft(steps[installIndex])) {
      errors.push(`${file}: job "${name}" must run ${INSTALL_COMMAND} unconditionally.`);
    }
  }
}

export function validateCiGates(workflow, errors) {
  const jobs = jobsOf(workflow);
  const review = jobs.get('dependency-review');
  if (
    !review ||
    !/^\s*if:\s*github\.event_name == 'pull_request'\s*$/m.test(review) ||
    !/uses:\s*actions\/dependency-review-action@/m.test(review) ||
    !/^\s*fail-on-severity:\s*high\s*$/m.test(review)
  ) {
    errors.push(
      `${CI_WORKFLOW}: a dependency-review job must run on pull requests with actions/dependency-review-action failing on high severity.`,
    );
  }
  const check = jobs.get('check');
  if (!check) {
    errors.push(`${CI_WORKFLOW}: the check job is missing.`);
    return;
  }
  const steps = stepsOf(check);
  const installIndex = steps.findIndex((step) => stepRunLines(step).includes(INSTALL_COMMAND));
  const guardIndex = steps.findIndex((step) => {
    const lines = stepRunLines(step);
    return SUPPLY_CHAIN_GUARD_LINES.every((line) => lines.includes(line));
  });
  if (
    guardIndex < 0 ||
    installIndex < 0 ||
    guardIndex >= installIndex ||
    isConditionalOrSoft(steps[guardIndex])
  ) {
    errors.push(
      `${CI_WORKFLOW}: the check job must run this guard's test and validator unconditionally before ${INSTALL_COMMAND}.`,
    );
  }
  const checkout = steps.find((step) => /uses:\s*actions\/checkout@/m.test(step));
  if (!checkout || !/^\s*fetch-depth:\s*0\s*$/m.test(checkout)) {
    errors.push(
      `${CI_WORKFLOW}: the check job's checkout needs fetch-depth: 0 for the secret-hygiene history scan.`,
    );
  }
  const audit = steps.find((step) => stepName(step) === DEPENDENCY_AUDIT_NAME);
  const auditLines = audit ? stepRunLines(audit) : [];
  if (
    !audit ||
    auditLines.length !== DEPENDENCY_AUDIT_LINES.length ||
    auditLines.some((line, index) => line !== DEPENDENCY_AUDIT_LINES[index]) ||
    isConditionalOrSoft(audit) ||
    steps.at(-1) !== audit
  ) {
    errors.push(
      `${CI_WORKFLOW}: "${DEPENDENCY_AUDIT_NAME}" must be the last step of the check job, run exactly its two reviewed commands, and block on failure.`,
    );
  }
}

export function validateDependabot(dependabot, errors) {
  const updates = extractIndentedBlock(dependabot, /^updates:\s*$/);
  const entries = updates ? childBlocks(updates, 2) : [];
  const ecosystems = entries.map(
    (entry) => entry.match(/package-ecosystem:\s*["']?([a-z-]+)/)?.[1],
  );
  for (const required of ['npm', 'github-actions']) {
    if (!ecosystems.includes(required)) {
      errors.push(`.github/dependabot.yml must cover the ${required} ecosystem.`);
    }
  }
  const npm = entries.find((entry) => /package-ecosystem:\s*["']?npm/.test(entry));
  if (npm && !/^\s*versioning-strategy:\s*increase-if-necessary\s*$/m.test(npm)) {
    errors.push('Dependabot npm updates must preserve exact pins unless an update is necessary.');
  }
}

/** `workflows` maps a file name (e.g. ci.yml) to its source. */
export function validateWorkflowSecurity({ workflows, dependabot }) {
  const errors = [];
  if (!workflows.has(CI_WORKFLOW)) errors.push(`${CI_WORKFLOW} is missing.`);
  for (const [file, workflow] of workflows) {
    validateActionPins(workflow, errors, file);
    validatePermissions(workflow, errors, file);
    validateTriggers(workflow, errors, file);
    validateCheckouts(workflow, errors, file);
    validateInstallOrder(workflow, errors, file);
    if (file === CI_WORKFLOW) validateCiGates(workflow, errors);
  }
  validateDependabot(dependabot, errors);
  return errors;
}

export function readWorkflows(root = process.cwd()) {
  const directory = resolve(root, WORKFLOW_DIRECTORY);
  if (!existsSync(directory)) return new Map();
  return new Map(
    readdirSync(directory)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()
      .map((name) => [name, readFileSync(resolve(directory, name), 'utf8')]),
  );
}

export function runWorkflowSecurityCheck({ root = process.cwd() } = {}) {
  const workflows = readWorkflows(root);
  const dependabot = readFileSync(resolve(root, DEFAULT_DEPENDABOT), 'utf8');
  const errors = validateWorkflowSecurity({ workflows, dependabot });
  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  let actionCount = 0;
  for (const workflow of workflows.values()) {
    actionCount += [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*/gm)].length;
  }
  return { workflowCount: workflows.size, actionCount };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    const result = runWorkflowSecurityCheck();
    console.log(
      `Workflow security guard passed: ${result.workflowCount} workflows, ${result.actionCount} action uses pinned to commits; read-only permissions, credential-free checkouts, toolchain guard before every install, dependency review and audit gates present.`,
    );
  } catch (error) {
    console.error(
      `Workflow security guard failed:\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
