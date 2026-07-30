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

5. **Tag and push** — this is what triggers the release:

   ```bash
   git tag vX.Y.Z
   git push origin main --tags
   ```

   Pushing a `vX.Y.Z` tag runs [`.github/workflows/publish.yml`](./.github/workflows/publish.yml), which lints, type-checks, tests, and builds the package fresh, verifies the tag matches `package.json`'s version (failing the run otherwise), then publishes to npm using [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) with `--provenance` — no `NPM_TOKEN` secret is stored anywhere. Publishing runs in a separate job scoped to the `npm-publish` GitHub Environment, gated behind the build/verify job passing.

   Watch the [Actions tab](https://github.com/Coolhand-Labs/coolhand-cli/actions/workflows/publish.yml) for the run; a failure there (including a tag/version mismatch) means the package was **not** published.

