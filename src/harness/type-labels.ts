/**
 * Which schema.org types are site plumbing (breadcrumbs, the website and its pages, search boxes, pictures,
 * addresses, actions), and a record card's type in words: never a schema.org name. A type listing is never drawn for
 * a visitor at all: it is a step for the model. What the model reads is unchanged.
 *
 * @module
 */
import { readableType } from './entity.js';

type Obj = Record<string, unknown>;

/** Types that are how a site is built, not something a visitor asks about. Any `…Action` is one too. */
const TECHNICAL = new Set(
  (
    'BreadcrumbList ListItem ItemList WebSite WebPage WebPageElement CollectionPage AboutPage ContactPage ItemPage ' +
    'SearchResultsPage ProfilePage QAPage MedicalWebPage CheckoutPage RealEstateListing SiteNavigationElement WPHeader ' +
    'WPFooter WPSideBar WPAdBlock Table EntryPoint ImageObject ImageGallery MediaObject Barcode PostalAddress ' +
    'GeoCoordinates GeoShape GeoCircle ContactPoint OpeningHoursSpecification PropertyValue PropertyValueSpecification ' +
    'PriceSpecification UnitPriceSpecification CompoundPriceSpecification DeliveryChargeSpecification MonetaryAmount ' +
    'QuantitativeValue Rating AggregateRating Thing CreativeWork Intangible StructuredValue DataFeed DataFeedItem Brand ' +
    'Language Country State City AdministrativeArea DefinedTerm DefinedTermSet Answer HowToStep HowToSection ' +
    'HowToDirection HowToTip HowToSupply HowToTool Person Audience PeopleAudience Duration Enumeration ' +
    'MerchantReturnPolicy OfferShippingDetails ShippingDeliveryTime SpeakableSpecification Comment CorrectionComment'
  ).split(' '),
);

/** A type with its schema.org prefix taken off: "https://schema.org/Plumber" → "Plumber". */
export const bare = (t: unknown): string => (typeof t === 'string' ? t.replace(/^.*[/#:]/, '') : '');

/** Whether a type is site plumbing (breadcrumbs, pages, search, pictures, addresses, actions). */
export const isTechnicalType = (type: string): boolean => TECHNICAL.has(bare(type)) || /Action$/.test(bare(type));

/** A person who works for the business: one with a job title, an employer or a team. */
const isStaff = (r: Obj): boolean => ['jobTitle', 'worksFor', 'memberOf', 'roleName'].some((k) => r[k] != null && r[k] !== '');

/**
 * The type tag a record's card wears: its type in words ("Plumber", "Emergency service"), "Team" for staff, and
 * nothing for site plumbing or a person who isn't staff.
 */
export function typeTag(record: Obj): string | undefined {
  const types = [record['@type']].flat().map(bare).filter(Boolean);
  const t = types.find((x) => !isTechnicalType(x)) ?? (types.includes('Person') && isStaff(record) ? 'Team' : undefined);
  return t === 'Team' ? t : t ? readableType(t) : undefined;
}

/** Whether a record is site plumbing: every type it has is technical, and it isn't a member of staff. */
export const isTechnicalRecord = (record: Obj): boolean => !typeTag(record) && [record['@type']].flat().some((t) => typeof t === 'string');
