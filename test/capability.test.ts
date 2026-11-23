/**
 * Refusing to load where loading would kill the tab, and keeping the weights
 * once they are downloaded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessLocalCapability, requestPersistentStorage, shouldUseCache } from '../src/index';

const adapter = (f16 = true) => ({ features: new Set(f16 ? ['shader-f16'] : []), limits: {} });

const DESKTOP = {
  userAgent: 'Mozilla/5.0 (Macintosh) Chrome/131',
  userAgentData: { mobile: false },
  deviceMemory: 16,
  gpu: { requestAdapter: async () => adapter() },
  storage: { estimate: async () => ({ quota: 20e9 }) },
};

function withNavigator(nav: unknown) {
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true });
});

describe('assessLocalCapability', () => {
  it('clears a capable desktop', async () => {
    withNavigator(DESKTOP);
    const v = await assessLocalCapability();
    expect(v.ok).toBe(true);
    expect(v.checks.shaderF16).toBe(true);
  });

  it('declines Chrome for Android, which is the case it exists for', async () => {
    withNavigator({
      ...DESKTOP,
      userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/131 Mobile',
      userAgentData: { mobile: true },
    });
    const v = await assessLocalCapability();
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('mobile device');
  });

  it('falls back to the user-agent string where client hints are absent', async () => {
    const { userAgentData: _omitted, ...noHints } = DESKTOP;
    withNavigator({ ...noHints, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari' });
    const v = await assessLocalCapability();
    expect(v.ok).toBe(false);
    expect(v.checks.mobile).toBe(true);
  });

  it('declines without fp16 compute, rather than degrading', async () => {
    // There is no smaller build to fall back to: q4f16 is the smallest, and q4
    // is larger. Degrading would make the crash worse, not better.
    withNavigator({ ...DESKTOP, gpu: { requestAdapter: async () => adapter(false) } });
    const v = await assessLocalCapability();
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('no shader-f16');
  });

  it('declines when the API exists but no adapter is behind it', async () => {
    withNavigator({ ...DESKTOP, gpu: { requestAdapter: async () => null } });
    const v = await assessLocalCapability();
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('no WebGPU adapter');
    expect(v.checks.webgpuApi).toBe(true);
  });

  it('declines a machine that cannot hold the weights', async () => {
    withNavigator({ ...DESKTOP, deviceMemory: 4 });
    expect((await assessLocalCapability()).reason).toBe('deviceMemory 4GB');
  });

  it('declines when the storage quota is too small for the download', async () => {
    withNavigator({ ...DESKTOP, storage: { estimate: async () => ({ quota: 2e9 }) } });
    expect((await assessLocalCapability()).reason).toMatch(/storage quota/);
  });

  it('treats a missing storage estimate as saying nothing either way', async () => {
    withNavigator({ ...DESKTOP, storage: undefined });
    expect((await assessLocalCapability()).ok).toBe(true);
  });

  it('reports its findings, so a host can decide differently', async () => {
    withNavigator({ ...DESKTOP, deviceMemory: 4 });
    const v = await assessLocalCapability();
    expect(v.checks).toMatchObject({ mobile: false, webgpuApi: true, deviceMemoryGb: 4 });
  });
});

describe('requestPersistentStorage', () => {
  it('does not ask again when storage is already persistent', async () => {
    const persist = vi.fn(async () => true);
    withNavigator({ storage: { persisted: async () => true, persist } });
    expect(await requestPersistentStorage()).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it('asks when it is not, and reports what the browser decided', async () => {
    withNavigator({ storage: { persisted: async () => false, persist: async () => true } });
    expect(await requestPersistentStorage()).toBe(true);

    withNavigator({ storage: { persisted: async () => false, persist: async () => false } });
    // A refusal is normal: browsers grant this on their own heuristics.
    expect(await requestPersistentStorage()).toBe(false);
  });

  it('reports false where the API is missing or throws, rather than failing the load', async () => {
    withNavigator({});
    expect(await requestPersistentStorage()).toBe(false);

    withNavigator({ storage: { persisted: async () => false, persist: async () => { throw new Error('no'); } } });
    expect(await requestPersistentStorage()).toBe(false);
  });
});

describe('the load guard', () => {
  it('caches when nothing went wrong', () => {
    expect(shouldUseCache(0, true)).toBe(true);
  });

  it('gives the Cache Storage theory exactly one attempt', () => {
    expect(shouldUseCache(1, true)).toBe(false);
  });

  it('goes back to caching once that theory is disproved', () => {
    // The regression this pins. Any non-zero count used to disable the cache,
    // so a device being killed for another reason (a phone out of memory) never
    // used the cache again, and re-downloading gigabytes each time made the
    // next kill likelier. One crash became caching that never worked.
    expect(shouldUseCache(2, true)).toBe(true);
    expect(shouldUseCache(7, true)).toBe(true);
  });

  it('never overrides a host that turned caching off', () => {
    for (const died of [0, 1, 2, 9]) expect(shouldUseCache(died, false)).toBe(false);
  });
});
