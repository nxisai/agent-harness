/**
 * Load progress, which a person watches for minutes on a first visit.
 *
 * These run headless — no model, no WebGPU. `_trackProgress` is the callback
 * Transformers.js drives during the download, and it is reachable without
 * loading anything, so the arithmetic can be checked directly.
 */
import { describe, expect, it } from 'vitest';
import { AgentEngine } from '../src/index';
import type { ProgressDetail } from '../src/index';

type Report = { pct: number; detail?: ProgressDetail };

/** An engine that records what it reported, without ever loading a model. */
function engineWithLog() {
  const reports: Report[] = [];
  const engine = new AgentEngine({ onProgress: (pct, detail) => reports.push({ pct, detail }) });
  const feed = (file: string, loaded: number, total: number) =>
    (engine as unknown as { _trackProgress(p: unknown): void })._trackProgress({
      status: 'progress',
      file,
      loaded,
      total,
    });
  const ready = () =>
    (engine as unknown as { _trackProgress(p: unknown): void })._trackProgress({ status: 'ready' });
  const newLoad = () => (engine as unknown as { _resetProgress(): void })._resetProgress();
  return { engine, reports, feed, ready, newLoad };
}

const MB = 1024 * 1024;

describe('load progress', () => {
  it('reports bytes alongside the percentage', () => {
    const { reports, feed } = engineWithLog();
    feed('model.onnx', 50 * MB, 200 * MB);

    expect(reports).toHaveLength(1);
    expect(reports[0].pct).toBeCloseTo(25);
    expect(reports[0].detail).toEqual({ loaded: 50 * MB, total: 200 * MB });
  });

  it('sums across files', () => {
    const { reports, feed } = engineWithLog();
    feed('a.onnx', 50 * MB, 100 * MB);
    feed('b.onnx', 50 * MB, 100 * MB);

    expect(reports.at(-1)!.detail).toEqual({ loaded: 100 * MB, total: 200 * MB });
    expect(reports.at(-1)!.pct).toBeCloseTo(50);
  });

  it('follows the true ratio down when the denominator grows', () => {
    const { reports, feed } = engineWithLog();
    // 90% of what is known so far…
    feed('a.onnx', 90 * MB, 100 * MB);
    expect(reports.at(-1)!.pct).toBeCloseTo(90);

    // …then a second shard registers, and the honest ratio drops to 45%.
    feed('b.onnx', 0, 100 * MB);

    // It reports 45, not 90. This was once clamped so it could never decrease,
    // which sounded kind and behaved terribly: the tokenizer's files finish in
    // a second, the ratio touches 100% before the weights announce themselves,
    // and the ring then sat full through the entire download.
    expect(reports.at(-1)!.pct).toBeCloseTo(45);
    expect(reports.at(-1)!.detail).toEqual({ loaded: 90 * MB, total: 200 * MB });
  });

  it('measures each stage on its own', () => {
    const { reports, feed, newLoad } = engineWithLog();
    // The tokenizer: small, and finished almost at once.
    feed('tokenizer.json', 4 * MB, 4 * MB);
    expect(reports.at(-1)!.pct).toBeCloseTo(100);

    // The weights are a different stage, and start from nothing rather than
    // inheriting the tokenizer's "done".
    newLoad();
    feed('model.onnx', 86 * MB, 1720 * MB);
    expect(reports.at(-1)!.pct).toBeCloseTo(5);
  });

  it('ignores the per-artefact "ready", which arrives mid-load', () => {
    const { reports, feed, ready } = engineWithLog();
    feed('tokenizer.json', 40 * MB, 100 * MB);
    expect(reports.at(-1)!.pct).toBeCloseTo(40);

    // The tokenizer is ready while the weights are still coming. Treating that
    // as the end of the load dropped the bar to zero and then jumped it back.
    ready();
    expect(reports.at(-1)!.pct).toBeCloseTo(40);
  });

  it('starts a fresh load at zero', () => {
    const { reports, feed, newLoad } = engineWithLog();
    feed('a.onnx', 100 * MB, 100 * MB);
    expect(reports.at(-1)!.pct).toBeCloseTo(100);

    newLoad(); // what _loadEngine does before fetching anything
    feed('b.onnx', 10 * MB, 100 * MB);
    expect(reports.at(-1)!.pct).toBeCloseTo(10);
  });

  it('says nothing while the total is unknown', () => {
    const { reports, feed } = engineWithLog();
    feed('a.onnx', 12 * MB, 0);

    // No denominator, no percentage — better silent than a bar pinned at zero.
    expect(reports).toHaveLength(0);
  });
});
