#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const CORE_DIRECTORY = 'src/core';
const FORBIDDEN_SOURCE_DIRECTORIES = ['db', 'features', 'native', 'services', 'state', 'ui'];
const FORBIDDEN_ALIASES = ['@db', '@features', '@native', '@services', '@state', '@ui'];

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

function literalText(node) {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

export function importSpecifiers(source, fileName = 'source.ts') {
  const scriptKind = extname(fileName).toLowerCase().includes('x')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const specifiers = [];

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier) specifiers.push(specifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    ) {
      const specifier = literalText(node.moduleReference.expression);
      if (specifier) specifiers.push(specifier);
    } else if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) {
        const argument = node.arguments[0];
        const specifier = argument ? literalText(argument) : undefined;
        specifiers.push(specifier ?? '<non-literal>');
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(file);
  return specifiers;
}

function isForbiddenPackage(specifier) {
  return (
    specifier === 'react' ||
    specifier.startsWith('react/') ||
    specifier === 'react-native' ||
    specifier.startsWith('react-native/') ||
    specifier === 'zustand' ||
    specifier.startsWith('zustand/') ||
    specifier === 'expo' ||
    specifier.startsWith('expo/') ||
    specifier.startsWith('expo-') ||
    specifier.startsWith('@expo/')
  );
}

function isForbiddenAlias(specifier) {
  return FORBIDDEN_ALIASES.some(
    (alias) => specifier === alias || specifier.startsWith(`${alias}/`),
  ) || FORBIDDEN_SOURCE_DIRECTORIES.some(
    (directory) =>
      specifier === `@/${directory}` || specifier.startsWith(`@/${directory}/`),
  );
}

function isInside(candidate, directory) {
  const path = relative(directory, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
}

function isForbiddenRelativeImport({ root, file, specifier }) {
  if (!specifier.startsWith('.')) return false;
  const target = resolve(file, '..', specifier);
  return FORBIDDEN_SOURCE_DIRECTORIES.some((directory) =>
    isInside(target, resolve(root, 'src', directory)),
  );
}

export function validateCoreImports({ root, files }) {
  const errors = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of importSpecifiers(source, file)) {
      if (specifier === '<non-literal>') {
        errors.push(`${relative(root, file)} uses a non-literal require/import.`);
      } else if (
        isForbiddenPackage(specifier) ||
        isForbiddenAlias(specifier) ||
        isForbiddenRelativeImport({ root, file, specifier })
      ) {
        errors.push(`${relative(root, file)} imports forbidden boundary "${specifier}".`);
      }
    }
  }

  return errors.sort();
}

export function runCoreBoundaryCheck({ root = process.cwd() } = {}) {
  const core = resolve(root, CORE_DIRECTORY);
  const files = sourceFiles(core);
  const errors = validateCoreImports({ root, files });
  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  return { files: files.length };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    const result = runCoreBoundaryCheck();
    console.log(`Core boundary guard passed: ${result.files} platform-free source files.`);
  } catch (error) {
    console.error(
      `Core boundary guard failed:\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
