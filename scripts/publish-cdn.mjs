#!/usr/bin/env node
// Publishes the CDN build (dist-cdn/, from `npm run build:cdn`) to S3 behind CloudFront, as dist-cdn/upload.json plans
// it. The release job runs it (.github/workflows/deploy.yml) with a role it assumes through GitHub's OIDC token; by
// hand, run it with --dry-run to see the commands.
//
//   node scripts/publish-cdn.mjs --bucket <bucket> --distribution <distribution id> [--dry-run]
//
// In order:
//   1. If harness/<version>/manifest.json is already in the bucket: the same bytes as this build's means the version
//      is published (a re-run), and its files are skipped; any other bytes stop the run. A version is never changed.
//   2. Every file of the version, each a conditional create (If-None-Match: *), with its Content-Type and
//      Cache-Control (a year, immutable) as object metadata. The manifest goes last.
//   3. The alias, harness/<major>.<minor>/, with a five-minute Cache-Control.
//   4. A CloudFront invalidation of the alias, so the release is visible at once.
//
// CORS and the other response headers are not set here: CloudFront's response headers policy for /harness/* adds
// them. Needs the AWS CLI v2 (on GitHub's runners).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The AWS CLI calls, in order, for the plan. Pure, for the tests.
 *
 * @param {{ version: string, alias: string, objects: { key: string, file: string, contentType: string, cacheControl: string, createOnly: boolean }[], invalidate: string[] }} plan
 * @param {{ bucket: string, distribution: string, out: string, skipVersion?: boolean }} o
 * @returns {string[][]} argv for `aws`
 */
export function publishCommands(plan, o) {
  const put = (obj) => [
    's3api',
    'put-object',
    '--bucket',
    o.bucket,
    '--key',
    obj.key,
    '--body',
    join(o.out, obj.file),
    '--content-type',
    obj.contentType,
    '--cache-control',
    obj.cacheControl,
    ...(obj.createOnly ? ['--if-none-match', '*'] : []),
  ];
  const version = plan.objects.filter((x) => x.createOnly);
  const alias = plan.objects.filter((x) => !x.createOnly);
  return [
    ...(o.skipVersion ? [] : version.map(put)),
    ...alias.map(put),
    ['cloudfront', 'create-invalidation', '--distribution-id', o.distribution, '--paths', ...plan.invalidate],
  ];
}

function main() {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const dryRun = process.argv.includes('--dry-run');
  const bucket = arg('--bucket') ?? process.env.HARNESS_CDN_BUCKET;
  const distribution = arg('--distribution') ?? process.env.HARNESS_CDN_DISTRIBUTION_ID;
  const out = resolve(ROOT, arg('--out') ?? 'dist-cdn');
  if (!bucket || !distribution) throw new Error('publish-cdn: --bucket and --distribution are required');
  if (!existsSync(join(out, 'upload.json'))) throw new Error('publish-cdn: dist-cdn/upload.json is missing. Run `npm run build:cdn` first.');
  const plan = JSON.parse(readFileSync(join(out, 'upload.json'), 'utf8'));
  const manifest = plan.objects.find((x) => x.createOnly && x.key.endsWith('/manifest.json'));
  const aws = (args) => execFileSync('aws', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

  // 1. Already published?
  let skipVersion = false;
  if (!dryRun) {
    const tmp = mkdtempSync(join(tmpdir(), 'nxis-publish-'));
    try {
      aws(['s3api', 'get-object', '--bucket', bucket, '--key', manifest.key, join(tmp, 'manifest.json')]);
      const same = readFileSync(join(tmp, 'manifest.json')).equals(readFileSync(join(out, manifest.file)));
      if (!same) throw new Error(`publish-cdn: ${manifest.key} is already published with other contents. A version is never changed; release a new one.`);
      skipVersion = true;
      console.log(`publish-cdn: ${plan.version} is already published, the same build; only the alias is updated`);
    } catch (err) {
      if (/NoSuchKey|Not Found|404/.test(String(err.stderr ?? err.message))) skipVersion = false;
      else throw err;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // 2–4.
  for (const args of publishCommands(plan, { bucket, distribution, out, skipVersion })) {
    if (dryRun) console.log(['aws', ...args.map((a) => (/[\s*]/.test(a) ? `'${a}'` : a))].join(' '));
    else aws(args);
  }
  if (!dryRun) console.log(`publish-cdn: ${plan.version} published to s3://${bucket}/harness/, alias harness/${plan.alias}/ invalidated on ${distribution}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
