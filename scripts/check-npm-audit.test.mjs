import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { advisoriesFromAuditReport, evaluateAudit } from './check-npm-audit.mjs';

const root = resolve(import.meta.dirname, '..');
const TODAY = '2026-10-09';

function advisory(id, name, severity, title = `${name} advisory`) {
  return { source: id.length, name, severity, title, url: `https://github.com/advisories/${id}` };
}

/** A minimal `npm audit --json` (v2) report: one vulnerable package per advisory. */
function reportWith(...advisories) {
  const vulnerabilities = {};
  for (const entry of advisories) {
    vulnerabilities[entry.name] = { name: entry.name, severity: entry.severity, via: [entry] };
  }
  return { auditReportVersion: 2, vulnerabilities };
}

const braces = advisory('GHSA-vfj7-8cjw-p6xm', 'braces', 'high');
const braceException = {
  id: 'GHSA-vfj7-8cjw-p6xm',
  package: 'braces',
  reason: 'build-only and patched',
  expires: '2027-01-31',
};

test('passes when every high advisory has a current reviewed exception', () => {
  const result = evaluateAudit({
    report: reportWith(braces),
    allowlist: { exceptions: [braceException] },
    today: TODAY,
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('fails on a high or critical advisory with no reviewed exception', () => {
  const result = evaluateAudit({
    report: reportWith(braces, advisory('GHSA-pqg4-j6r4-53mv', 'shell-quote', 'critical')),
    allowlist: { exceptions: [braceException] },
    today: TODAY,
  });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /critical advisory GHSA-pqg4-j6r4-53mv in shell-quote/);
});

test('ignores moderate and low advisories', () => {
  const result = evaluateAudit({
    report: reportWith(
      advisory('GHSA-vcc3-ghjq-m6fr', 'decode-uri-component', 'moderate'),
      advisory('GHSA-0000-0000-0001', 'tiny', 'low'),
    ),
    allowlist: { exceptions: [] },
    today: TODAY,
  });
  assert.deepEqual(result.errors, []);
});

test('fails when a reviewed exception has expired, but not on its expiry day', () => {
  const allowlist = { exceptions: [{ ...braceException, expires: '2026-10-09' }] };
  const onExpiryDay = evaluateAudit({ report: reportWith(braces), allowlist, today: TODAY });
  assert.deepEqual(onExpiryDay.errors, []);
  const dayAfter = evaluateAudit({ report: reportWith(braces), allowlist, today: '2026-10-10' });
  assert.equal(dayAfter.errors.length, 1);
  assert.match(dayAfter.errors[0], /expired on 2026-10-09; re-review it/);
});

test('rejects incomplete exception entries', () => {
  for (const broken of [
    { ...braceException, reason: '  ' },
    { ...braceException, expires: 'soon' },
    { id: 'GHSA-vfj7-8cjw-p6xm', package: 'braces', expires: '2027-01-31' },
  ]) {
    const result = evaluateAudit({
      report: reportWith(braces),
      allowlist: { exceptions: [broken] },
      today: TODAY,
    });
    assert.ok(result.errors.some((error) => error.includes('needs id, package, reason')));
    // An unusable entry must not excuse the advisory it names.
    assert.ok(result.errors.some((error) => error.includes('high advisory GHSA-vfj7-8cjw-p6xm')));
  }
});

test('warns about exceptions that no longer match any advisory', () => {
  const result = evaluateAudit({
    report: reportWith(),
    allowlist: { exceptions: [braceException] },
    today: TODAY,
  });
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings[0], /GHSA-vfj7-8cjw-p6xm \(braces\) no longer matches/);
});

test('counts each advisory once and skips inherited package references', () => {
  const report = reportWith(braces);
  report.vulnerabilities.micromatch = { name: 'micromatch', severity: 'high', via: ['braces'] };
  report.vulnerabilities['braces-copy'] = { name: 'braces', severity: 'high', via: [braces] };
  assert.deepEqual(
    advisoriesFromAuditReport(report).map((entry) => entry.id),
    ['GHSA-vfj7-8cjw-p6xm'],
  );
});

/** A report where one advisory affects the given install paths (`nodes` in `npm audit --json`). */
function zodReportAt(nodes) {
  const zod = advisory('GHSA-mrhx-c7xc-m3w5', 'zod', 'high');
  return {
    auditReportVersion: 2,
    vulnerabilities: { zod: { name: 'zod', severity: 'high', via: [zod], nodes } },
  };
}

const zodBuildToolException = {
  id: 'GHSA-mrhx-c7xc-m3w5',
  package: 'zod',
  paths: ['node_modules/expo/node_modules/zod'],
  reason: 'build-only copy',
  expires: '2027-01-31',
};

test('a path-scoped exception excuses only the install paths it lists', () => {
  const allowlist = { exceptions: [zodBuildToolException] };
  const buildToolOnly = evaluateAudit({
    report: zodReportAt(['node_modules/expo/node_modules/zod']),
    allowlist,
    today: TODAY,
  });
  assert.deepEqual(buildToolOnly.errors, []);

  const shippedCopyToo = evaluateAudit({
    report: zodReportAt(['node_modules/expo/node_modules/zod', 'node_modules/zod']),
    allowlist,
    today: TODAY,
  });
  assert.equal(shippedCopyToo.errors.length, 1);
  assert.match(
    shippedCopyToo.errors[0],
    /high advisory GHSA-mrhx-c7xc-m3w5 in zod also affects node_modules\/zod, which/,
  );
});

test('a path-scoped exception fails closed when the report names no install paths', () => {
  const result = evaluateAudit({
    report: zodReportAt(undefined),
    allowlist: { exceptions: [zodBuildToolException] },
    today: TODAY,
  });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /no install paths for GHSA-mrhx-c7xc-m3w5 \(zod\)/);
});

test('rejects malformed exception paths', () => {
  for (const paths of [[], ['  '], 'node_modules/expo/node_modules/zod', [3]]) {
    const result = evaluateAudit({
      report: zodReportAt(['node_modules/expo/node_modules/zod']),
      allowlist: { exceptions: [{ ...zodBuildToolException, paths }] },
      today: TODAY,
    });
    assert.ok(result.errors.some((error) => error.includes('optional paths must be')));
    assert.ok(result.errors.some((error) => error.includes('high advisory GHSA-mrhx-c7xc-m3w5')));
  }
});

test('collects install paths from every report entry for the same advisory', () => {
  const report = zodReportAt(['node_modules/zod']);
  report.vulnerabilities['zod-copy'] = {
    name: 'zod',
    severity: 'high',
    via: [advisory('GHSA-mrhx-c7xc-m3w5', 'zod', 'high')],
    nodes: ['node_modules/expo/node_modules/zod'],
  };
  const [only] = advisoriesFromAuditReport(report);
  assert.deepEqual(only.nodes.toSorted(), [
    'node_modules/expo/node_modules/zod',
    'node_modules/zod',
  ]);
});

test('the committed allowlist entries are complete and unexpired', () => {
  const allowlist = JSON.parse(
    readFileSync(resolve(root, 'scripts/npm-audit-allowlist.json'), 'utf8'),
  );
  assert.ok(Array.isArray(allowlist.exceptions));
  for (const entry of allowlist.exceptions) {
    assert.match(entry.id, /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
    assert.ok(entry.package && entry.reason.length > 40, `${entry.id} needs a real reason`);
    assert.match(entry.expires, /^\d{4}-\d{2}-\d{2}$/);
  }
  const { errors } = evaluateAudit({ report: reportWith(), allowlist, today: TODAY });
  assert.deepEqual(errors, []);
});
