#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_WORKFLOW = '.github/workflows/ci.yml';
const DEFAULT_DEPENDABOT = '.github/dependabot.yml';
const FULL_COMMIT_SHA = /^[a-f0-9]{40}$/i;
const READABLE_VERSION = /^v\d+\.\d+\.\d+(?:\s|$)/;

function linesOf(source) {
  return source.replace(/\r\n/g, '\n').split('\n');
}

function indentation(line) {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function extractIndentedBlock(source, startPattern) {
  const lines = linesOf(source);
  const start = lines.findIndex((line) => startPattern.test(line));
  if (start < 0) return undefined;

  const baseIndent = indentation(lines[start]);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && !line.trimStart().startsWith('#') && indentation(line) <= baseIndent) break;
    end += 1;
  }
  return { source: lines.slice(start, end).join('\n'), start };
}

function extractJob(workflow, name) {
  return extractIndentedBlock(workflow, new RegExp(`^  ${name}:\\s*$`));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasStandaloneLine(block, value) {
  return new RegExp(`^\\s*${escapeRegExp(value)}\\s*$`, 'm').test(block ?? '');
}

function extractNamedStep(job, name) {
  return extractIndentedBlock(job, new RegExp(`^      - name: ${escapeRegExp(name)}\\s*$`))?.source;
}

function requireBlockingUnconditionalStep(step, name, errors) {
  if (/^\s*if\s*:/m.test(step ?? '')) {
    errors.push(`"${name}" must run unconditionally; do not add a step-level if condition.`);
  }
  if (/^\s*continue-on-error\s*:/m.test(step ?? '')) {
    errors.push(`"${name}" must fail the Android job when the diagnostic scan fails.`);
  }
}

function validateActionPins(workflow, errors) {
  const declarations = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*([^\r\n]+)$/gm)];
  if (declarations.length === 0) errors.push('CI must use at least one reviewed GitHub Action.');

  for (const declaration of declarations) {
    const raw = declaration[1].trim();
    const commentIndex = raw.indexOf('#');
    const target = (commentIndex >= 0 ? raw.slice(0, commentIndex) : raw).trim();
    const comment = commentIndex >= 0 ? raw.slice(commentIndex + 1).trim() : '';

    if (target.startsWith('./')) continue;

    const at = target.lastIndexOf('@');
    const action = at > 0 ? target.slice(0, at) : target;
    const ref = at > 0 ? target.slice(at + 1) : '';
    if (!action.includes('/') || !FULL_COMMIT_SHA.test(ref)) {
      errors.push(`${target} must be pinned to a full 40-character commit SHA.`);
    }
    if (!READABLE_VERSION.test(comment)) {
      errors.push(`${target} must include a readable version comment such as "# v4.4.0".`);
    }
  }
}

function validatePermissions(workflow, errors) {
  const lines = linesOf(workflow);
  const blocks = [];

  lines.forEach((line, index) => {
    const match = line.match(/^(\s*)permissions:\s*(.*)$/);
    if (!match) return;
    const indent = match[1].length;
    const inline = match[2].trim();
    const entries = [];

    let cursor = index + 1;
    while (cursor < lines.length) {
      const child = lines[cursor];
      if (child.trim() && !child.trimStart().startsWith('#') && indentation(child) <= indent) break;
      const entry = child.match(/^\s+([A-Za-z-]+):\s*([^#\s]+)\s*(?:#.*)?$/);
      if (entry) entries.push([entry[1], entry[2]]);
      cursor += 1;
    }
    blocks.push({ indent, inline, entries });
  });

  const root = blocks.find((block) => block.indent === 0);
  if (!root) {
    errors.push('CI needs a top-level permissions block.');
  }

  for (const block of blocks) {
    const isContentsRead =
      block.inline === '' &&
      block.entries.length === 1 &&
      block.entries[0][0] === 'contents' &&
      block.entries[0][1] === 'read';
    if (!isContentsRead) {
      errors.push('Every permissions block must grant only "contents: read".');
    }
  }
}

function requireSafeAuditStep(checkJob, name, command, errors) {
  const step = extractNamedStep(checkJob, name);
  if (!step) {
    errors.push(`CI check job is missing the "${name}" step.`);
    return;
  }
  if (!step.includes(`run: ${command}`)) {
    errors.push(`"${name}" must run exactly: ${command}`);
  }
  if (/continue-on-error:\s*true|\|\|\s*true/.test(step)) {
    errors.push(`"${name}" must fail the job when npm reports a vulnerability.`);
  }
}

function validateCheckJob(workflow, errors) {
  const check = extractJob(workflow, 'check');
  if (!check) {
    errors.push('CI is missing the check job.');
    return;
  }

  const checkout = extractIndentedBlock(
    check.source,
    /^      - uses: actions\/checkout@[a-f0-9]{40}/i,
  )?.source;
  if (!checkout || !/^          fetch-depth:\s*0\s*$/m.test(checkout)) {
    errors.push('The check job checkout must use fetch-depth: 0 so history scanning is complete.');
  }

  const guard = extractNamedStep(check.source, 'Workflow supply-chain guard');
  if (
    !guard?.includes('node --test scripts/check-workflow-security.test.mjs') ||
    !guard.includes('node scripts/check-workflow-security.mjs')
  ) {
    errors.push('The dependency-free workflow guard and its mutation tests must run in CI.');
  }

  const installIndex = check.source.indexOf('run: npm ci');
  const fullAuditIndex = check.source.indexOf('run: npm audit --audit-level=high');
  const productionAuditIndex = check.source.indexOf('run: npm audit --omit=dev --audit-level=high');
  if (installIndex < 0 || fullAuditIndex < installIndex || productionAuditIndex < installIndex) {
    errors.push('Both high-severity npm audits must run after the clean npm ci install.');
  }

  requireSafeAuditStep(
    check.source,
    'Audit clean lockfile (all dependencies)',
    'npm audit --audit-level=high',
    errors,
  );
  requireSafeAuditStep(
    check.source,
    'Audit production dependencies',
    'npm audit --omit=dev --audit-level=high',
    errors,
  );
}

function validateAndroidJob(workflow, errors) {
  const android = extractJob(workflow, 'android');
  if (!android) {
    errors.push('CI is missing the Android build job.');
    return;
  }

  const prebuild = extractNamedStep(android.source, 'Clean Expo prebuild');
  const prebuildCommand =
    './node_modules/.bin/expo prebuild --platform android --clean --no-install';
  if (!hasStandaloneLine(prebuild, `run: ${prebuildCommand}`)) {
    errors.push(`The Android job must run a clean Expo prebuild: ${prebuildCommand}`);
  }

  const generatedDiagnosticGuard = extractNamedStep(
    android.source,
    'Scan generated Android diagnostics',
  );
  if (!hasStandaloneLine(generatedDiagnosticGuard, 'run: npm run check:error-diagnostics')) {
    errors.push('The Android job must scan generated Android diagnostics after prebuild.');
  } else if (
    android.source.indexOf('      - name: Scan generated Android diagnostics') <
    android.source.indexOf('      - name: Clean Expo prebuild')
  ) {
    errors.push('The generated Android diagnostic scan must run after the clean Expo prebuild.');
  }
  requireBlockingUnconditionalStep(
    generatedDiagnosticGuard,
    'Scan generated Android diagnostics',
    errors,
  );

  const nativeBuild = extractNamedStep(android.source, 'Compile local native modules');
  for (const task of [
    ':gator-paste-input:compileDebugKotlin',
    ':gator-share-shortcuts:compileDebugKotlin',
    ':gator-bounded-download:compileDebugKotlin',
  ]) {
    if (!hasStandaloneLine(nativeBuild, task)) {
      errors.push(`The Android job must run the native build task ${task}.`);
    }
  }

  const debugBuild = extractNamedStep(android.source, 'Assemble debug APK');
  if (!debugBuild?.includes('./gradlew :app:assembleDebug --no-daemon')) {
    errors.push('The Android job must assemble the debug APK in its own Gradle invocation.');
  }

  const releaseBuild = extractNamedStep(android.source, 'Bundle release AAB');
  if (!releaseBuild?.includes('./gradlew :app:bundleRelease --no-daemon')) {
    errors.push('The Android job must bundle the release AAB in its own Gradle invocation.');
  }

  const packagedArtifactGuard = extractNamedStep(
    android.source,
    'Verify debug/release manifests, release AAB, and headless entry',
  );
  if (!hasStandaloneLine(packagedArtifactGuard, 'run: npm run check:android-build')) {
    errors.push('The Android job must run npm run check:android-build.');
  }
}

function validateDependencyReview(workflow, errors) {
  if (/^\s*pull_request_target\s*:/m.test(workflow)) {
    errors.push('CI must not use pull_request_target for dependency review.');
  }

  const job = extractJob(workflow, 'dependency-review');
  if (!job) {
    errors.push('CI is missing the pull-request dependency-review job.');
    return;
  }
  if (!/^    if: github\.event_name == 'pull_request'\s*$/m.test(job.source)) {
    errors.push('The dependency-review job must run only for pull_request events.');
  }
  if (
    !/uses:\s*actions\/dependency-review-action@[a-f0-9]{40}\s+#\s+v\d+\.\d+\.\d+/i.test(job.source)
  ) {
    errors.push('The dependency-review job must use the SHA-pinned dependency review action.');
  }
  if (!/^          fail-on-severity:\s*high\s*$/m.test(job.source)) {
    errors.push('Dependency review must block newly introduced high and critical dependencies.');
  }
  if (/continue-on-error:\s*true/.test(job.source)) {
    errors.push('Dependency review must fail the job when it finds a blocked dependency.');
  }
}

function dependabotSection(source, ecosystem) {
  const pattern = new RegExp(`^  - package-ecosystem: ["']?${ecosystem}["']?\\s*$`, 'm');
  return extractIndentedBlock(source, pattern)?.source;
}

function validateDependabot(dependabot, errors) {
  if (!/^version:\s*2\s*$/m.test(dependabot)) {
    errors.push('Dependabot configuration must use version 2.');
  }

  for (const ecosystem of ['npm', 'github-actions']) {
    const matches = [
      ...dependabot.matchAll(
        new RegExp(`^  - package-ecosystem: ["']?${ecosystem}["']?\\s*$`, 'gm'),
      ),
    ];
    const section = dependabotSection(dependabot, ecosystem);
    if (matches.length !== 1 || !section) {
      errors.push(`Dependabot must contain exactly one ${ecosystem} update entry.`);
      continue;
    }
    if (!/^    directory:\s*["']?\/["']?\s*$/m.test(section)) {
      errors.push(`Dependabot ${ecosystem} updates must target the repository root.`);
    }
    if (!/^      interval:\s*weekly\s*$/m.test(section)) {
      errors.push(`Dependabot ${ecosystem} updates must run weekly.`);
    }
  }

  const npm = dependabotSection(dependabot, 'npm');
  if (npm && !/^    versioning-strategy:\s*increase-if-necessary\s*$/m.test(npm)) {
    errors.push('Dependabot npm updates must preserve exact pins unless an update is necessary.');
  }
}

export function validateWorkflowSecurity({ workflow, dependabot }) {
  const errors = [];
  validateActionPins(workflow, errors);
  validatePermissions(workflow, errors);
  validateCheckJob(workflow, errors);
  validateAndroidJob(workflow, errors);
  validateDependencyReview(workflow, errors);
  validateDependabot(dependabot, errors);
  return errors;
}

export function runWorkflowSecurityCheck({ root = process.cwd() } = {}) {
  const workflow = readFileSync(resolve(root, DEFAULT_WORKFLOW), 'utf8');
  const dependabot = readFileSync(resolve(root, DEFAULT_DEPENDABOT), 'utf8');
  const errors = validateWorkflowSecurity({ workflow, dependabot });
  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));

  const actionCount = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*/gm)].length;
  return { actionCount };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    const result = runWorkflowSecurityCheck();
    console.log(
      `Workflow security guard passed: ${result.actionCount} action uses are immutable; audits, dependency review, and Android release verification are enforced.`,
    );
  } catch (error) {
    console.error(
      `Workflow security guard failed:\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
