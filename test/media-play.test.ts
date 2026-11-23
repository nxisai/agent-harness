// @vitest-environment happy-dom
/**
 * In-chat playback in the real element, on the podcast example's records:
 * `<nxis-agent media="play">` plays free episode 2 and only the preview of episode 4, never touches the
 * paid episode's public 05.mp3, makes no media request before a tap, keeps playing through redraws and conversation
 * switches, and plays "Listen to the latest" from the episode it fetched. Without the attribute nothing plays.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import F from './fixtures/podcast-records.json';
import { installFakeMedia, type FakeMedia } from './helpers/fake-media';
import '../src/ui/agent';

type Obj = Record<string, any>;
const E = F.episodes as Record<string, Obj>;
const S = F.series as Record<string, Obj>;
const SITE = 'https://podcast.example';
const LATEST = `${SITE}/shows/lantern-hours/03-glue-and-when-not-to.html#episode`;

/** Episode 3, as nxis_get returns it: the part, with its audio. */
const episode3 = {
  ...(S['lantern-hours'].hasPart as Obj[]).find((p) => p['@id'] === LATEST),
  partOfSeries: { '@type': 'PodcastSeries', name: 'Lantern Hours' },
  associatedMedia: { '@type': 'AudioObject', '@id': `${SITE}/shows/lantern-hours/03-glue-and-when-not-to.html#audio`, contentUrl: `${SITE}/audio/lantern-hours/03.mp3`, encodingFormat: 'audio/mpeg', isAccessibleForFree: true },
};

let fake: FakeMedia;
let fetches: string[];
let gets: unknown[];

beforeEach(() => {
  fake = installFakeMedia();
  localStorage.clear();
  sessionStorage.clear();
  fetches = [];
  gets = [];
  vi.spyOn(window, 'fetch').mockImplementation(async (u: any) => {
    fetches.push(String(u?.url ?? u));
    return new Response('{}');
  });
  // As the WebMCP spec's registry behaves: a call names the registered tool object, never a bare name.
  const nxisGet = { name: 'nxis_get', description: 'Get a record', inputSchema: {} };
  (document as any).modelContext = {
    addEventListener() {},
    removeEventListener() {},
    getTools: async () => [nxisGet],
    executeTool: async (tool: unknown, args: Obj) => {
      if (tool !== nxisGet) throw new TypeError("The provided value is not of type 'RegisteredTool'.");
      gets.push([nxisGet.name, args]);
      return { structuredContent: { result: args.id === LATEST ? episode3 : {} } };
    },
  };
});
afterEach(() => {
  fake.restore();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  delete (document as any).modelContext;
});

/** The element, with the given attributes, showing one tool result. */
function mount(attrs: Record<string, string>, records: Obj[]): any {
  const el = document.createElement('nxis-agent') as any;
  el.setAttribute('preload', 'none');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  show(el, records);
  return el;
}

function show(el: any, records: Obj[]): void {
  const item = el._buildResultsItem({ name: 'nxis_query' }, { structuredContent: { results: records } });
  el._active().items.push(item);
  el._renderThread();
}

const thread = (el: any): HTMLElement => el.shadowRoot.querySelector('.thread');
const plays = (el: any): HTMLButtonElement[] => [...thread(el).querySelectorAll<HTMLButtonElement>('.ra-play')];
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const everything = (el: any) => [el.shadowRoot.innerHTML, localStorage.getItem('nxis-listings-agent-conversations') ?? '', fake.requested.join(' '), fetches.join(' ')].join('\n');

describe('media="play" on the podcast example', () => {
  it('free and preview episodes get play buttons; paid and sign-up keep Subscribe to listen and Sign up to listen', () => {
    const el = mount({ media: 'play' }, [E.free, E.preview, E.paid, E.signup]);
    expect(plays(el).map((b) => b.dataset.label)).toEqual(['Listen', 'Listen to preview']);
    const links = [...thread(el).querySelectorAll<HTMLAnchorElement>('a.ra-btn')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([
      ['Subscribe to listen', `${SITE}/subscribe/lantern-hours.html`],
      ['Sign up to listen', `${SITE}/subscribe/lantern-hours.html`],
    ]);
  });

  it('makes no media request at all before a tap, for a list of 12 episodes', () => {
    const many = (S['lantern-hours'].hasPart as Obj[]).map((p) => ({ ...p, partOfSeries: { name: 'Lantern Hours' }, associatedMedia: { '@type': 'AudioObject', contentUrl: `${SITE}/audio/lantern-hours/${String(p.episodeNumber).padStart(2, '0')}.mp3`, encodingFormat: 'audio/mpeg' } }));
    const el = mount({ media: 'play' }, many);
    expect(plays(el).length).toBeGreaterThan(0);
    expect(fake.requested).toEqual([]);
    expect(fake.plays).toBe(0);
    expect(el.shadowRoot.querySelectorAll('audio, video')).toHaveLength(0);
    expect(fetches.filter((u) => /\.mp3/.test(u))).toEqual([]);
  });

  it('plays free episode 2 in the dock, pressed, and keeps playing through redraws and a conversation switch', async () => {
    const el = mount({ media: 'play' }, [E.free, E.preview, E.paid, E.signup]);
    plays(el)[0].click();
    // play() ran inside the tap, before the player module arrived.
    expect(fake.requested).toEqual([`${SITE}/audio/lantern-hours/02.mp3`]);
    await vi.waitFor(() => expect(el._media).toBeTruthy(), { timeout: 5000 });
    await settle();
    const dock = el.shadowRoot.querySelector('section.md-dock') as HTMLElement;
    expect(dock.hidden).toBe(false);
    expect(dock.previousElementSibling!.className).toBe('thread');
    expect(dock.nextElementSibling!.className).toBe('statusline');
    expect([plays(el)[0].getAttribute('aria-pressed'), plays(el)[0].textContent]).toEqual(['true', 'Pause']);

    el._renderThread();
    await settle();
    expect(el._media.el.paused).toBe(false);
    expect(plays(el)[0].getAttribute('aria-pressed')).toBe('true');

    el._newConversation();
    await settle();
    expect(el._media.el.paused).toBe(false);
    expect(el.shadowRoot.querySelector('section.md-dock')).toBe(dock);

    // Tapped again, from wherever it is drawn: pause.
    el._activeId = el._conversations[1].id;
    el._renderThread();
    await settle();
    plays(el)[0].click();
    expect(el._media.el.paused).toBe(true);
    await settle();
    expect(plays(el)[0].getAttribute('aria-pressed')).toBe('false');
  });

  it('the preview plays only 04-preview.mp3; and no request is ever made to 05.mp3', async () => {
    const el = mount({ media: 'play' }, [E.free, E.preview, E.paid, E.signup]);
    plays(el)[1].click();
    await settle();
    plays(el)[0].click();
    await settle();
    expect(fake.requested.filter((r) => !r.startsWith('load:'))).toEqual([`${SITE}/audio/lantern-hours/04-preview.mp3`, `${SITE}/audio/lantern-hours/02.mp3`]);
    expect(everything(el)).not.toMatch(/04\.mp3|05\.mp3|12\.mp3/);
  });

  it('reports the first play of each item as page_open with its Listen, once', async () => {
    const reported: Obj[] = [];
    const { setPageOpenReporter } = await import('../src/harness/tools/report');
    setPageOpenReporter((r) => reported.push(r));
    const el = mount({ media: 'play' }, [E.free]);
    plays(el)[0].click();
    await settle();
    plays(el)[0].click();
    plays(el)[0].click();
    await settle();
    expect(reported).toEqual([{ outcome: 'page_open', action_type: 'ListenAction', action_id: `${SITE}/shows/lantern-hours/02-the-drawer-that-sticks.html#listen`, report_token: 'tok.listen', source: 'on_page_agent' }]);
    setPageOpenReporter(null);
  });

  it('"Listen to the latest" fetches its episode once as the card is drawn, then plays it', async () => {
    const el = mount({ media: 'play' }, [S['lantern-hours']]);
    await settle();
    expect(gets).toEqual([['nxis_get', { id: LATEST }]]);
    const lead = plays(el)[0];
    expect(lead.dataset.label).toBe('Listen to the latest');
    lead.click();
    expect(fake.requested).toEqual([`${SITE}/audio/lantern-hours/03.mp3`]);
    el._renderThread();
    expect(gets).toHaveLength(1);
  });

  it('a host blocked this session draws its buttons as links again, and a tap opens the page', async () => {
    const el = mount({ media: 'play' }, [E.free]);
    plays(el)[0].click();
    await settle();
    const v = new Event('securitypolicyviolation') as any;
    Object.assign(v, { effectiveDirective: 'media-src', blockedURI: `${SITE}/audio/lantern-hours/02.mp3` });
    document.dispatchEvent(v);
    await settle();
    expect(plays(el)).toHaveLength(0);
    expect(thread(el).querySelector('a.ra-btn')!.getAttribute('href')).toBe(`${SITE}/shows/lantern-hours/02-the-drawer-that-sticks.html#player`);
    expect(el.shadowRoot.querySelector('.md-status')!.textContent).toBe("Can't play here. Open the episode page");
  });

  it('stops and lets go when the element is removed', async () => {
    const el = mount({ media: 'play' }, [E.free]);
    plays(el)[0].click();
    await settle();
    const media = el._media.el as HTMLVideoElement;
    el.remove();
    expect(media.paused).toBe(true);
    expect(media.querySelectorAll('source')).toHaveLength(0);
    expect(el._media).toBeNull();
  });
});

describe('without media="play"', () => {
  it('draws exactly what media="open" draws: links, no player, nothing loaded', async () => {
    const plain = mount({}, [E.free, E.preview, E.paid, E.signup]);
    const open = mount({ media: 'open' }, [E.free, E.preview, E.paid, E.signup]);
    const html = (el: any) => thread(el).innerHTML.replace(/ra-m-[a-z0-9]+/g, 'ra-m-x');
    expect(html(plain)).toBe(html(open));
    expect(plays(plain)).toHaveLength(0);
    expect(thread(plain).querySelector('a.ra-btn')!.getAttribute('href')).toBe(`${SITE}/shows/lantern-hours/02-the-drawer-that-sticks.html#player`);
    expect(gets).toEqual([]);
    await settle();
    expect(plain.shadowRoot.querySelector('.md-dock')).toBeNull();
    expect(fake.requested).toEqual([]);
  });

  it('a card saved while it was on is drawn as its link once it is off', () => {
    const el = mount({ media: 'play' }, [E.free]);
    el.removeAttribute('media');
    el._renderThread();
    expect(plays(el)).toHaveLength(0);
    expect(thread(el).querySelector('a.ra-btn')!.textContent).toBe('Listen');
  });
});
