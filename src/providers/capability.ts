/**
 * Whether this device can load the local model without harming the visitor.
 *
 * {@link LocalGemmaProvider} downloads and holds roughly 3.4 GB of weights in
 * the tab. A mobile renderer cannot take that: it is killed, and the visitor
 * loses the whole host page rather than just the agent.
 *
 * That failure cannot be caught. An out-of-memory kill runs no `catch`, no
 * `onerror` and no `unload` handler, so there is no recovery path and nothing
 * to report afterwards. The only defence is deciding before the load starts,
 * which is what this module is for.
 *
 * @module
 */

/** Fields the standard DOM types do not declare. */
type CapabilityNavigator = Navigator & {
  deviceMemory?: number;
  userAgentData?: { mobile?: boolean };
  gpu?: {
    requestAdapter(): Promise<{
      features: { has(feature: string): boolean };
      limits: Record<string, number>;
    } | null>;
  };
};

/** Approximate footprint of the q4f16 weights, in bytes. */
export const MODEL_BYTES = 3.4e9;

/** Weights plus room for the browser's own use, for the storage estimate. */
const REQUIRED_QUOTA = MODEL_BYTES * 1.8;

/** Reported memory, in GB, below which the load is not attempted. */
const MIN_DEVICE_MEMORY_GB = 8;

/** What {@link assessLocalCapability} found. */
export interface LocalCapability {
  /** Whether the local model should be loaded on this device. */
  ok: boolean;
  /** Why not, when `ok` is false. Suitable for a log, not for a visitor. */
  reason?: string;
  /** The individual findings, for a host that wants to decide for itself. */
  checks: {
    /** True for a phone or tablet, by client hints or user-agent string. */
    mobile: boolean;
    /** Whether `navigator.gpu` exists. The API, not a usable adapter. */
    webgpuApi: boolean;
    /** Whether an adapter was actually returned. */
    adapter: boolean;
    /** Whether the adapter supports fp16 compute, which `q4f16` requires. */
    shaderF16: boolean;
    /** `navigator.deviceMemory` in GB, where the browser reports it. */
    deviceMemoryGb?: number;
    /** Storage quota in bytes, where the browser estimates it. */
    storageQuota?: number;
  };
}

/** Is this a phone or tablet? Client hints where available, UA string if not. */
function isMobile(nav: CapabilityNavigator): boolean {
  if (typeof nav.userAgentData?.mobile === 'boolean') return nav.userAgentData.mobile;
  return /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(nav.userAgent);
}

/**
 * Decide whether the local model can be loaded here, without loading it.
 *
 * Safe and cheap to call: it acquires a WebGPU adapter and reads storage
 * estimates, and downloads nothing. Hosts can call it directly to decide
 * whether to offer the agent at all, rather than rendering a control that
 * cannot work.
 *
 * Deliberately conservative, because the two ways of being wrong are not
 * equal. A false negative costs a capable visitor the local model, and a
 * remote provider still works. A false positive costs a visitor their browser
 * tab, and takes the host's page with it.
 *
 * There is no smaller quantisation to fall back to: `q4f16` is already the
 * smallest build of this model, and `q4` is larger. So a device without fp16
 * compute is declined rather than degraded.
 *
 * @returns The verdict, and the individual findings behind it.
 */
export async function assessLocalCapability(): Promise<LocalCapability> {
  const checks: LocalCapability['checks'] = {
    mobile: false,
    webgpuApi: false,
    adapter: false,
    shaderF16: false,
  };

  if (typeof navigator === 'undefined') {
    return { ok: false, reason: 'no navigator', checks };
  }
  const nav = navigator as CapabilityNavigator;

  checks.mobile = isMobile(nav);
  checks.webgpuApi = !!nav.gpu;
  if (typeof nav.deviceMemory === 'number') checks.deviceMemoryGb = nav.deviceMemory;

  // Mobile is the case this exists for. Even a phone reporting ample memory is
  // subject to a renderer cap far below what these weights need.
  if (checks.mobile) return { ok: false, reason: 'mobile device', checks };
  if (!nav.gpu) return { ok: false, reason: 'no WebGPU', checks };

  if (checks.deviceMemoryGb !== undefined && checks.deviceMemoryGb < MIN_DEVICE_MEMORY_GB) {
    return { ok: false, reason: `deviceMemory ${checks.deviceMemoryGb}GB`, checks };
  }

  let adapter;
  try {
    adapter = await nav.gpu.requestAdapter();
  } catch (error) {
    return { ok: false, reason: `adapter request failed: ${String(error)}`, checks };
  }
  // The API can exist with no adapter behind it, which is a load that fails
  // after the download rather than before it.
  if (!adapter) return { ok: false, reason: 'no WebGPU adapter', checks };
  checks.adapter = true;

  checks.shaderF16 = adapter.features.has('shader-f16');
  if (!checks.shaderF16) return { ok: false, reason: 'no shader-f16', checks };

  // Storage is checked last because it is advisory: browsers report a quota
  // they do not promise to honour, and a missing estimate is not a refusal.
  try {
    const estimate = await nav.storage?.estimate?.();
    if (typeof estimate?.quota === 'number') {
      checks.storageQuota = estimate.quota;
      if (estimate.quota < REQUIRED_QUOTA) {
        return {
          ok: false,
          reason: `storage quota ${(estimate.quota / 1e9).toFixed(1)}GB`,
          checks,
        };
      }
    }
  } catch {
    // An unavailable estimate says nothing either way.
  }

  return { ok: true, checks };
}

/**
 * Ask the browser to keep this origin's storage rather than evicting it.
 *
 * Cache Storage is best-effort by default, and a browser under pressure evicts
 * best-effort data without warning. A multi-gigabyte model is the first thing
 * to go, which looks exactly like caching never having worked.
 *
 * Browsers grant this on their own heuristics, so it is a request rather than
 * a guarantee. Not asking guarantees best-effort; asking sometimes gets more.
 *
 * @returns Whether the origin's storage is persistent afterwards.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = navigator?.storage;
    if (!storage?.persist) return false;
    if (await storage.persisted?.()) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
