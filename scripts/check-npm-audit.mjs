#!/usr/bin/env node

// Dependency audit gate with reviewed exceptions.
//
// A plain `npm audit --audit-level=high` fails whenever any package in the tree has a high or
// critical advisory, including build-only tools that were already reviewed and patched locally.
// That kept CI red for weeks and hid real typecheck/test failures behind the same red X. This
// check still fails on every high or critical advisory, except the ones listed in
// scripts/npm-audit-allowlist.json, each of which needs a written reason and an expiry date.
// An exception may also list `paths`: the install paths it covers (for example
// node_modules/expo/node_modules/zod). The advisory then still fails for any other copy, so a
// build-tool exception cannot hide the same advisory in a copy the app ships.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ALLOWLIST = 'scripts/npm-audit-allowlist.json';
const BLOCKING_SEVERITIES = new Set(['high', 'critical']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Unique advisories in an `npm audit --json` report, keyed by their GHSA id. */
export function advisoriesFromAuditReport(report) {
  const advisories = new Map();
  for (const vulnerability of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of vulnerability?.via ?? []) {
      // A string entry only names another vulnerable package this one depends on.
      if (typeof via !== 'object' || via === null) continue;
      const id = String(via.url ?? '')
        .split('/')
        .pop();
      if (!id) continue;
      // `nodes` are the install paths of the affected copies of the package.
      const reported = Array.isArray(vulnerability.nodes) ? vulnerability.nodes : [];
      const nodes = new Set([...(advisories.get(id)?.nodes ?? []), ...reported]);
      advisories.set(id, {
        id,
        package: via.name,
        severity: via.severity,
        title: via.title,
        nodes: [...nodes],
      });
    }
  }
  return [...advisories.values()];
}

/**
 * Compares an audit report with the reviewed exceptions. `today` is a YYYY-MM-DD string; an
 * exception expires at the end of its `expires` day.
 */
export function evaluateAudit({ report, allowlist, today }) {
  const errors = [];
  const warnings = [];
  const exceptions = new Map();

  for (const entry of allowlist?.exceptions ?? []) {
    const complete =
      typeof entry?.id === 'string' &&
      typeof entry.package === 'string' &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0 &&
      ISO_DATE.test(entry.expires ?? '') &&
      (entry.paths === undefined ||
        (Array.isArray(entry.paths) &&
          entry.paths.length > 0 &&
          entry.paths.every((path) => typeof path === 'string' && path.trim().length > 0)));
    if (!complete) {
      errors.push(
        `Allowlist entry ${JSON.stringify(entry)} needs id, package, reason and expires (YYYY-MM-DD); optional paths must be a non-empty list of install paths.`,
      );
      continue;
    }
    exceptions.set(entry.id, entry);
  }

  const advisories = advisoriesFromAuditReport(report);
  for (const advisory of advisories) {
    if (!BLOCKING_SEVERITIES.has(advisory.severity)) continue;
    const exception = exceptions.get(advisory.id);
    if (!exception) {
      errors.push(
        `${advisory.severity} advisory ${advisory.id} in ${advisory.package}: ${advisory.title}`,
      );
    } else if (exception.expires < today) {
      errors.push(
        `The reviewed exception for ${advisory.id} (${advisory.package}) expired on ${exception.expires}; re-review it.`,
      );
    } else if (exception.paths && advisory.nodes.length === 0) {
      // Fail closed: without install paths the report cannot show which copies are affected.
      errors.push(
        `npm audit reported no install paths for ${advisory.id} (${advisory.package}), so its path-limited exception cannot be checked.`,
      );
    } else if (exception.paths) {
      const uncovered = advisory.nodes.filter((node) => !exception.paths.includes(node));
      if (uncovered.length > 0) {
        errors.push(
          `${advisory.severity} advisory ${advisory.id} in ${advisory.package} also affects ${uncovered.join(', ')}, which its reviewed exception does not cover.`,
        );
      }
    }
  }

  const presentIds = new Set(advisories.map((advisory) => advisory.id));
  for (const exception of exceptions.values()) {
    if (!presentIds.has(exception.id)) {
      warnings.push(
        `Allowlist entry ${exception.id} (${exception.package}) no longer matches any advisory; remove it.`,
      );
    }
  }

  return { errors, warnings, advisories };
}

function readAuditReport(root) {
  try {
    return execFileSync('npm', ['audit', '--json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // npm audit exits non-zero whenever it finds an advisory; its JSON report is still on stdout.
    if (typeof error?.stdout === 'string' && error.stdout.trimStart().startsWith('{')) {
      return error.stdout;
    }
    throw error;
  }
}

export function runNpmAuditCheck({
  root = process.cwd(),
  today = new Date().toISOString().slice(0, 10),
} = {}) {
  const allowlist = JSON.parse(readFileSync(resolve(root, DEFAULT_ALLOWLIST), 'utf8'));
  const report = JSON.parse(readAuditReport(root));
  if (report.error) {
    throw new Error(`npm audit did not produce a report: ${JSON.stringify(report.error)}`);
  }
  return evaluateAudit({ report, allowlist, today });
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    const { errors, warnings, advisories } = runNpmAuditCheck();
    for (const warning of warnings) console.warn(`warning: ${warning}`);
    if (errors.length > 0) {
      console.error(`Dependency audit failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
      process.exitCode = 1;
    } else {
      const counts = {};
      for (const advisory of advisories) {
        counts[advisory.severity] = (counts[advisory.severity] ?? 0) + 1;
      }
      console.log(
        `Dependency audit passed: no unreviewed high or critical advisories (advisories by severity: ${JSON.stringify(counts)}).`,
      );
    }
  } catch (error) {
    console.error(
      `Dependency audit failed to run:\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
