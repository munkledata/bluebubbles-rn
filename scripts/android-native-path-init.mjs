#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Gradle init script that adds the native path-map flags to every Android app and library CMake
 * build. Android Gradle passes its own CMAKE_*_FLAGS on the command line, so CMake ignores the
 * CFLAGS/CXXFLAGS environment there; this hook is what actually reaches those compilers. The
 * local release (release-android.mjs) and CI install this same text.
 */
export const ANDROID_NATIVE_PATH_INIT_SCRIPT = [
  "def gatorNativePathMapFlags = System.getenv('GATOR_NATIVE_PATH_MAP_FLAGS')",
  'if (gatorNativePathMapFlags == null || gatorNativePathMapFlags.trim().isEmpty()) {',
  "    throw new GradleException('GATOR_NATIVE_PATH_MAP_FLAGS must be set')",
  '}',
  '',
  'gradle.beforeProject { project ->',
  "    ['com.android.application', 'com.android.library'].each { pluginId ->",
  '        project.pluginManager.withPlugin(pluginId) {',
  '            project.android.defaultConfig.externalNativeBuild.cmake {',
  '                arguments "-DCMAKE_C_FLAGS=${gatorNativePathMapFlags}",',
  '                    "-DCMAKE_CXX_FLAGS=${gatorNativePathMapFlags}",',
  '                    "-DCMAKE_ASM_FLAGS=${gatorNativePathMapFlags}"',
  '            }',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

export const ANDROID_NATIVE_PATH_INIT_FILE_NAME = 'gator-native-path-map.gradle';

/** Writes the hook into `$GRADLE_USER_HOME/init.d`, which Gradle applies to every build. */
export function installAndroidNativePathInitScript(environment = process.env) {
  const gradleHome = environment.GRADLE_USER_HOME;
  if (!gradleHome || !isAbsolute(gradleHome)) {
    throw new Error('GRADLE_USER_HOME must be an absolute path');
  }
  // Fail here, not halfway through a Gradle build, when the flags the hook reads are missing.
  if (!environment.GATOR_NATIVE_PATH_MAP_FLAGS?.trim()) {
    throw new Error('GATOR_NATIVE_PATH_MAP_FLAGS must be set');
  }
  const directory = resolve(gradleHome, 'init.d');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, ANDROID_NATIVE_PATH_INIT_FILE_NAME);
  writeFileSync(path, ANDROID_NATIVE_PATH_INIT_SCRIPT, { mode: 0o600 });
  return path;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = installAndroidNativePathInitScript();
  console.log(`Installed the native path-map Gradle hook: ${path}`);
}
