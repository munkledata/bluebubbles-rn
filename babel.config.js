// Babel config — used ONLY by the jest-expo component-test project
// (test files under test/components, extension .test.tsx). The Node/core jest
// project uses ts-jest and does not read this file. Expo Metro also reads it at
// bundle time.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
