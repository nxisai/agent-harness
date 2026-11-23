/**
 * Finishing a carried call on the page that can submit it.
 *
 * This is the part that used to live inside the custom element, where it
 * could only be checked by hand: a page load, a registry that may never
 * appear, a form that may want more than the record carried. The waits and
 * the run are injected, so every ending is reachable here.
 */
import { describe, expect, it, vi } from 'vitest';
import { resumePendingAction, type ResumeOptions } from '../src/harness/tools/resume';
import { savePendingAction, takePendingAction } from '../src/harness/tools/pending-action';
import { LocalModelContext } from '../src/harness/tools/local-context';
import type { ModelContextToolInfo } from '../src/types';

const PAGE = 'https://listings.example/listings/royal-oak.html';
const ELSEWHERE = 'https://listings.example/index.html';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const HELD = {
  actionId: 'urn:nxis:action:royal-oak',
  pageToolName: 'quote_form',
  toolName: 'quote_form_anywhere',
  values: { business: 'Royal Oak Remodeling', full_name: 'Dana' },
  pageUrl: PAGE,
  conversationId: 'c-1',
};

/** The page's own tool, as nxis.js would have registered it. */
const pageTool = (required: string[] = []): ModelContextToolInfo =>
  ({
    name: 'quote_form',
    inputSchema: {
      type: 'object',
      properties: { business: { type: 'string' }, full_name: { type: 'string' }, email: { type: 'string' } },
      ...(required.length ? { required } : {}),
    },
  }) as ModelContextToolInfo;

/** A waiting call, and the seams wired to the happy path. */
function waiting(over: Partial<ResumeOptions> = {}) {
  const storage = memoryStorage();
  savePendingAction(HELD, { storage });
  const opts: ResumeOptions = {
    href: PAGE,
    storage,
    timeoutMs: 10,
    registry: async () => new LocalModelContext(),
    pageTool: async () => pageTool(),
    exec: async () => ({ content: [{ type: 'text', text: '{"submitted":true}' }] }),
    ...over,
  };
  return { storage, opts };
}

describe('resuming on arrival', () => {
  it('does nothing, cheaply, when no call is waiting', async () => {
    const registry = vi.fn();
    const outcome = await resumePendingAction({ href: PAGE, storage: memoryStorage(), registry });
    expect(outcome).toEqual({ status: 'none' });
    // Nothing waiting is the ordinary page load: it must not wait on anything.
    expect(registry).not.toHaveBeenCalled();
  });

  it('leaves a call addressed to another page where it is', async () => {
    const { opts, storage } = waiting({ href: ELSEWHERE });
    expect(await resumePendingAction(opts)).toEqual({ status: 'none' });
    expect(takePendingAction(PAGE, { storage })).not.toBeNull();
  });

  it('submits, and says so', async () => {
    const { opts } = waiting();
    const outcome = await resumePendingAction(opts);
    expect(outcome).toMatchObject({ status: 'submitted', text: '{"submitted":true}' });
  });

  it("sends what was carried, to the page's own tool", async () => {
    const exec = vi.fn(async () => ({ content: [] }));
    const { opts } = waiting({ exec });
    await resumePendingAction(opts);
    expect(exec).toHaveBeenCalledWith(expect.objectContaining({ name: 'quote_form' }), HELD.values);
  });

  it('reads the call once, so a reload cannot submit twice', async () => {
    const { opts, storage } = waiting();
    expect((await resumePendingAction(opts)).status).toBe('submitted');
    expect((await resumePendingAction({ ...opts, storage })).status).toBe('none');
  });

  it('opens the conversation before the waiting starts', async () => {
    const order: string[] = [];
    const { opts } = waiting({
      onStart: (p) => order.push(`start:${p.conversationId}`),
      registry: async () => {
        order.push('registry');
        return new LocalModelContext();
      },
    });
    await resumePendingAction(opts);
    expect(order).toEqual(['start:c-1', 'registry']);
  });

  it('reports a registry that never appears', async () => {
    const { opts } = waiting({ registry: async () => null });
    expect((await resumePendingAction(opts)).status).toBe('no-registry');
  });

  it('reports a form the page never registered', async () => {
    const { opts } = waiting({ pageTool: async () => null });
    expect((await resumePendingAction(opts)).status).toBe('no-tool');
  });

  it('asks rather than submitting when the live form wants more', async () => {
    const exec = vi.fn();
    const { opts } = waiting({ pageTool: async () => pageTool(['email']), exec });
    const outcome = await resumePendingAction(opts);
    expect(outcome).toMatchObject({ status: 'incomplete', missing: ['email'] });
    // The half-filled form must not be sent on someone's behalf.
    expect(exec).not.toHaveBeenCalled();
  });

  it('passes on what the form said when it refuses', async () => {
    const { opts } = waiting({
      exec: async () => ({ isError: true, content: [{ type: 'text', text: 'Email looks wrong.' }] }),
    });
    expect(await resumePendingAction(opts)).toMatchObject({
      status: 'rejected',
      text: 'Email looks wrong.',
    });
  });

  it('survives a tool that throws', async () => {
    const { opts } = waiting({
      exec: async () => {
        throw new Error('detached from the document');
      },
    });
    expect(await resumePendingAction(opts)).toMatchObject({
      status: 'failed',
      error: 'detached from the document',
    });
  });

  it('unwraps a response the registry stringified', async () => {
    const { opts } = waiting({
      exec: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ content: [{ type: 'text', text: 'Thanks — we will be in touch.' }] }),
          },
        ],
      }),
    });
    expect(await resumePendingAction(opts)).toMatchObject({
      status: 'submitted',
      text: 'Thanks — we will be in touch.',
    });
  });
});
