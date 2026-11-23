/**
 * The entity renderer: which archetype a record draws as, what it is called, the line under the name, and
 * what access costs. The same cases as the MCP server's widget tests, so the two surfaces draw the same card.
 */
import { describe, expect, it } from 'vitest';
import { access, archetype, entityLabel, groupOf, RENDERER_SPEC_VERSION, reviewFacts, reviewStars, SPEC, subtitle } from '../src/harness/entity';
import { grouped, type AnswerCard } from '../src/ui/result-pick';

describe('archetype', () => {
  it('follows the spec for a type and its subtypes', () => {
    expect(archetype({ '@type': 'Plumber' })).toBe('place');
    expect(archetype({ '@type': 'https://schema.org/Plumber' })).toBe('place');
    expect(archetype({ '@type': 'Review' })).toBe('opinion');
    expect(archetype({ '@type': 'NewsArticle' })).toBe('readable');
    expect(archetype({ '@type': 'Service' })).toBe('offerable');
    expect(archetype({ '@type': 'Person' })).toBe('profile');
  });

  it('draws later phases, deferred types, and types it does not know, as Thing', () => {
    // Events are phase 1, but a CourseInstance waits for its course's sessions.
    expect(archetype({ '@type': 'Event' })).toBe('happening');
    expect(archetype({ '@type': 'CourseInstance' })).toBe('thing');
    expect(archetype({ '@type': 'JobPosting' })).toBe('thing');
    expect(archetype({ '@type': 'NotASchemaType' })).toBe('thing');
    expect(archetype({})).toBe('thing');
  });

  it('draws media items and series, which the spec puts in phase 1', () => {
    expect(SPEC.archetypes.find((a) => a.id === 'media')?.phase).toBe(1);
    expect(SPEC.archetypes.find((a) => a.id === 'series')?.phase).toBe(1);
    expect(archetype({ '@type': 'PodcastEpisode' })).toBe('media');
    expect(archetype({ '@type': 'https://schema.org/PodcastSeries' })).toBe('series');
    expect(archetype({ '@type': 'AudioObject' })).toBe('media');
    expect(archetype({ '@type': 'Course' })).toBe('series');
  });

  it('takes the more specific of several types', () => {
    expect(archetype({ '@type': ['Organization', 'Plumber'] })).toBe('place');
  });

  it('names the groups a list is headed by', () => {
    expect(groupOf('place')).toBe('Businesses');
    expect(groupOf('opinion')).toBe('Reviews');
    expect(RENDERER_SPEC_VERSION).toBe(1);
  });
});

describe('entityLabel', () => {
  it('calls a review by what it reviews, never "Untitled"', () => {
    expect(entityLabel({ '@type': 'Review', itemReviewed: { name: 'Boiler Brothers' } })).toBe('Review of Boiler Brothers');
    expect(entityLabel({ '@type': 'Article', headline: 'Winter boiler care' })).toBe('Winter boiler care');
    expect(entityLabel({ '@type': 'HomeAndConstructionBusiness' })).toBe('Home and construction business');
    expect(entityLabel({})).toBe('Untitled');
  });
});

describe('subtitle', () => {
  it('says what a business is and where', () => {
    expect(subtitle({ '@type': 'Plumber', address: { addressLocality: 'Royal Oak' } })).toBe('Plumber · Royal Oak');
    expect(subtitle({ '@type': 'LocalBusiness', address: { addressLocality: 'Royal Oak' } })).toBe('Royal Oak');
    expect(subtitle({ '@type': 'HVACBusiness', address: { addressLocality: 'Royal Oak' } })).toBe('HVAC business · Royal Oak');
  });

  it('gives an article its publisher, author and date', () => {
    const a = { '@type': 'Article', publisher: { name: 'The Ledger' }, author: 'Dana Ruiz', datePublished: '2026-10-02T08:00:00Z' };
    expect(subtitle(a)).toBe('The Ledger · Dana Ruiz · 2026-10-02');
  });

  it('gives a review none: its title already says what it reviews', () => {
    expect(subtitle({ '@type': 'Review', itemReviewed: { name: 'X' } })).toBeUndefined();
  });
});

describe('access', () => {
  it('reads a paywall the way sites mark it for Google', () => {
    const paywalled = { '@type': 'NewsArticle', isAccessibleForFree: false, hasPart: { '@type': 'WebPageElement', isAccessibleForFree: 'False' } };
    expect(access(paywalled)).toEqual({ state: 'preview', label: 'Free preview' });
    expect(access({ isAccessibleForFree: false })).toEqual({ state: 'subscription', label: 'Subscription' });
    expect(access({ isAccessibleForFree: true })).toEqual({ state: 'free', label: 'Free' });
  });

  it("reads an action's requirements before the record's", () => {
    const action = { '@type': 'WatchAction', actionAccessibilityRequirement: { requiresSubscription: true } };
    expect(access({ isAccessibleForFree: true }, action)?.state).toBe('subscription');
    const paid = { actionAccessibilityRequirement: { expectsAcceptanceOf: { '@type': 'Offer', price: 49, priceCurrency: 'USD' } } };
    expect(access({}, paid)).toEqual({ state: 'purchase', label: '$49' });
  });

  it('prices offers, and calls a zero price free', () => {
    expect(access({ offers: { price: '19.99', priceCurrency: 'EUR' } })).toEqual({ state: 'purchase', label: '19.99 EUR' });
    expect(access({ offers: [{ price: 0 }] })).toEqual({ state: 'free', label: 'Free' });
  });

  it('says nothing, rather than "free", when the record says nothing', () => {
    expect(access({ '@type': 'Plumber', name: 'Boiler Brothers' })).toBeUndefined();
  });
});

describe('reviews', () => {
  it('show their own stars and words', () => {
    const r = { '@type': 'Review', reviewRating: { ratingValue: '5' }, author: { name: 'Pat M.' }, reviewBody: 'Fast and tidy.' };
    expect(reviewStars(r)).toBe(5);
    expect(reviewFacts(r)).toEqual(['By Pat M.', '“Fast and tidy.”']);
  });
});

describe('grouped', () => {
  const card = (title: string, group?: string): AnswerCard => ({ title, facts: [], ...(group ? { group } : {}) });

  it('keeps one kind in order, without headings', () => {
    const rows = grouped([card('A', 'Businesses'), card('B', 'Businesses')]);
    expect(rows.map((r) => r.card.title)).toEqual(['A', 'B']);
    expect(rows.every((r) => !r.heading)).toBe(true);
  });

  it('puts several kinds together under headings, in the order they first came', () => {
    const rows = grouped([card('A', 'Businesses'), card('R1', 'Reviews'), card('B', 'Businesses'), card('R2', 'Reviews')]);
    expect(rows.map((r) => r.card.title)).toEqual(['A', 'B', 'R1', 'R2']);
    expect(rows.map((r) => r.heading)).toEqual(['Businesses', undefined, 'Reviews', undefined]);
    expect(rows.map((r) => r.index)).toEqual([0, 2, 1, 3]);
  });
});
