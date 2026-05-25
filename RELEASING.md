# Releasing

## Release Process

1. **Bump the version** in `package.json`:

   ```bash
   npm version patch   # 0.1.0 → 0.1.1
   npm version minor   # 0.1.0 → 0.2.0
   npm version major   # 0.1.0 → 1.0.0
   ```

   Or edit `"version"` in `package.json` directly.

2. **Build** — regenerates `src/version.ts` from `package.json`, compiles TypeScript, and marks `dist/bin.js` executable:

   ```bash
   npm run build
   ```

   > `src/version.ts` is gitignored and generated automatically — never edit or commit it.

3. **Update `CHANGELOG.md`** with the new version section.

4. **Commit**:

   ```bash
   git add package.json CHANGELOG.md
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

