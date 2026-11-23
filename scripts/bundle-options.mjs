// The esbuild options for the browser bundle of `./ui`: shared by the size budget (scripts/size-budget.mjs) and the
// CDN build (scripts/build-cdn.mjs), so the budget measures what ships. ESM, minified, with code splitting on, so
// every dynamic `import()` stays a chunk of its own that loads only when it runs.
export const UI_BUNDLE = Object.freeze({
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  minify: true,
});
