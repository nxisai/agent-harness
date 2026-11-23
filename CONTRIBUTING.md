# Contributing

This repository is public so you can read the harness, audit what it does in your visitors'
browsers, and build it yourself. Thank you for being here.

## What helps right now

Issues. Genuinely — they are the most useful thing you can send us today:

- **Bugs.** A turn that fails, hangs, calls the wrong tool, or renders the wrong thing.
- **A model that misbehaves.** Which model, what was asked, and what it did. The bench in
  [`bench/`](bench/README.md) can usually turn one of these into a repeatable case.
- **Browser and device breakage.** A GPU that cannot load the on-device model, a browser whose
  WebMCP differs from the spec, a page layout the element breaks.
- **Unclear errors.** If a message told you something went wrong but not what to do about it,
  that is a bug in our writing and we want to hear it.
- **Documentation that is wrong.** Including this file.

A good bug report beats a patch we cannot merge yet.

## What we are not accepting yet

**Pull requests.** Not because we do not want the help, but because the harness is pre-1.0 and its
API is still moving, and we would be wasting your time.

That is not a hypothetical. In recent releases the renderer interface gained methods, the
confirmation cards were replaced outright, and the tools a site exposes are now assembled
differently. A patch written against any given release can be invalidated by the next one,
through no fault of yours. Asking people to write code against that would be discourteous.

When the surface settles, this changes. See [Later](#later).

## If you open a pull request anyway

It will be closed, with thanks and a link back here. Nothing more than that — no judgement, and
it does not count against you.

If the underlying fix is right, we will implement it and credit you by name in the release
notes. So the most effective thing to do is open an issue describing the problem and, if you
like, what you think the fix is. That gets your name on the change without either of us
pretending the PR could be merged.

## Later

**We do not have a date yet.** We would rather say that than invent one.

What has to be true before pull requests open:

- The public API has held still for a full release cycle.
- The tests and the bench run without an NxisAI account or a model key.
- A maintainer can commit to a stated review turnaround.

When those hold we will update this file, remove the automation that closes pull requests, and
label some real issues as good first ones.

## Releases

For maintainers. Development happens in a private repository, and this one is its public mirror. A release is a version bump in `package.json` and `CHANGELOG.md`, merged to `main` there. CI then runs the typecheck, the build, the tests and the size budgets, publishes the CDN build (below), and pushes the release here:

1. The release's tree arrives as one commit on `main`, tagged `v<version>`. Before it is pushed it is checked for anything internal (`scripts/check-public.mjs`) and scanned for secrets, and its `package.json` names this repository.
2. The tag runs [`.github/workflows/publish.yml`](.github/workflows/publish.yml), which is the only place the package is published to npm. It checks the release on Node 20 and 22 (the tag matches `package.json`, `repository.url` names this repository, nothing internal in the tree or in `dist/`, typecheck, build, tests), then waits in the `npm` environment for a maintainer to approve it.
3. Once approved, it publishes with `npm publish --provenance`. It holds no npm token: npm trusts this workflow (trusted publishing, configured on npmjs.com for this repository, `publish.yml` and the `npm` environment), and the provenance links each version to the run that built it. A version already on npm is skipped; a version is never published twice.
4. While this repository was private, the approved job only rehearsed (`npm publish --dry-run`), because npm attaches provenance only for public repositories. A tag pushed then is published by running the Publish workflow on that tag.

To check a published version: `npm view @nxisai/agent-harness@<version> repository.url` names this repository, and `npm audit signatures` in a project that installs it verifies its provenance attestation.

The CDN build goes out with each release, to S3 behind CloudFront:

1. CI builds it (`npm run build && npm run build:cdn`), checks `ui.js` and every chunk against `scripts/size-budget.json` (`npm run size:cdn`), runs `npm run smoke:cdn`, and keeps `dist-cdn/` as the `cdn-build` artifact. The release publishes those files, never a local rebuild.
2. The release job then runs `scripts/publish-cdn.mjs` with a role it assumes through GitHub's OIDC token (no stored AWS key). It follows `dist-cdn/upload.json`:
   - every file of `harness/<version>/`, each a conditional create (`If-None-Match: *`), with `Content-Type` and `Cache-Control: public, max-age=31536000, immutable` as object metadata, and its `manifest.json` last;
   - then `harness/<major>.<minor>/`, with `Cache-Control: public, max-age=300`;
   - then a CloudFront invalidation of the alias.
3. **A published version is never changed.** It is cached for a year and pinned by integrity hashes, so a fix is a new version. The bucket refuses an unconditional write to a version directory. A re-run that finds the version's manifest already published with the same bytes updates only the alias; different bytes stop the run.
4. CORS and the other response headers aren't object metadata: the CDN's response headers policy for `/harness/*` adds them.
5. To check by hand, run `npm run cdn:publish -- --bucket <bucket> --distribution <id> --dry-run`, which prints the commands without running them. After a release, fetch `harness/<version>/manifest.json` from the CDN and compare `ui.js`'s `integrity` with the artifact's.

## Sign-off

When contributions do open, this project uses the
[Developer Certificate of Origin](https://developercertificate.org/). It is a short statement
that you wrote the patch, or otherwise have the right to submit it under this project's license.

You certify it by signing off your commits:

```bash
git commit -s -m "fix: whatever you fixed"
```

which appends a line like `Signed-off-by: Your Name <you@example.com>`. You keep your copyright;
your contribution is licensed under Apache-2.0 like the rest of the repository. There is no
separate agreement to sign.

## Security

**Do not open a public issue for a security problem.**

See [SECURITY.md](SECURITY.md) for how to report one privately. We would much rather hear about
it from you first than read about it at the same time as everyone else.

## License

By participating you agree that your contributions are licensed under
[Apache-2.0](LICENSE), the same license as this repository.
