# Releasing

## Release Process

1. **Bump the version** in `package.json`:

   ```bash
   npm version patch   # 0.1.0 → 0.1.1
   npm version minor   # 0.1.0 → 0.2.0
   npm version major   # 0.1.0 → 1.0.0
   ```

   Or edit `"version"` in `package.json` directly.

2. **Build** — automatically syncs `src/version.ts` from `package.json`, compiles, and marks `dist/bin.js` executable:

   ```bash
   npm run build
   ```

3. **Update `CHANGELOG.md`** with the new version section.

4. **Commit** both updated files together:

   ```bash
   git add package.json src/version.ts CHANGELOG.md
   git commit -m "Bump version to vX.Y.Z"
   ```

5. **Tag and push**:

   ```bash
   git tag vX.Y.Z
   git push origin main --tags
   ```

6. **Publish to npm**:

   ```bash
   npm publish
   ```

   `prepublishOnly` runs `npm run build && npm run lint && npm run typecheck && npm test` — the package is always type-checked, linted, tested, and built fresh before publishing.

For a release candidate, use `npm publish --tag next` and verify on a clean machine with `npx coolhand-cli@next login` before promoting to `latest`.

---

## Version File

`src/version.ts` is **auto-generated** from `package.json` — do not edit it manually. `scripts/sync-version.mjs` (called automatically by `npm run build`) rewrites the file with the current version from `package.json`. To sync manually:

```bash
npm run sync-version
```
