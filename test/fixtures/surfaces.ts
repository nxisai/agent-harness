/**
 * Step surfaces as a Quote or Booking agent sends them (docs/quote-booking-surfaces.md), for the surfaces' tests.
 */
import { STEPS_CATALOG } from '../../src/a2ui/steps';

/** The Booking step 2 surface, as the contract's example draws it. */
export const SLOTS = {
  version: 'v1.0',
  createSurface: {
    surfaceId: 'booking-slots',
    catalogId: STEPS_CATALOG,
    components: [
      { id: 'root', component: 'Card', child: 'body' },
      { id: 'body', component: 'Column', children: ['days', 'windows', 'hold', 'go'] },
      { id: 'days', component: 'DayStrip', label: 'This week', days: '${/booking/days}', value: { path: '/booking/date' }, action: { event: { name: 'pick_day', context: { date: { path: '/booking/date' } } } } },
      { id: 'windows', component: 'WindowGrid', label: '${/booking/dayLabel}', windows: '${/booking/windows}', value: { path: '/booking/window' }, action: { event: { name: 'pick_window', context: { date: { path: '/booking/date' }, window: { path: '/booking/window' } } } } },
      { id: 'hold', component: 'HoldCountdown', expiresAt: '${/booking/hold}' },
      { id: 'go', component: 'Button', child: 'go_label', variant: 'primary', action: { event: { name: 'continue', context: { label: { path: '/booking/summary' } } } } },
      { id: 'go_label', component: 'Text', text: '${/booking/summary}' },
    ],
    dataModel: {
      booking: {
        days: [
          { value: '2026-11-24', weekday: 'Tue', day: '24' },
          { value: '2026-11-25', weekday: 'Wed', day: '25' },
          { value: '2026-11-27', weekday: 'Fri', day: '27', disabled: true, note: 'Full' },
        ],
        date: '2026-11-25',
        dayLabel: 'Wednesday, arrival window',
        windows: [
          { value: 'win-08', label: '8 – 10 am', open: 2 },
          { value: 'win-10', label: '10 am – 12 pm', open: 1 },
          { value: 'win-13', label: '1 – 3 pm', open: 0 },
        ],
        window: '',
        hold: '',
        summary: 'Pick a window',
      },
    },
  },
};


/** Quote step 2: the estimate with its sources. */
export const ESTIMATE = {
  version: 'v1.0',
  createSurface: {
    surfaceId: 'quote-estimate',
    catalogId: STEPS_CATALOG,
    components: [
      {
        id: 'root',
        component: 'EstimateCard',
        eyebrow: 'Estimate · Service',
        title: 'Water heater replacement',
        low: 1800,
        high: 2600,
        currency: 'USD',
        qualifier: 'installed',
        note: "From the site's Offer records · not a binding price",
        cites: [1, 2],
        included: ['Haul-away of the old tank', 'Permit and code check'],
        onSite: ['Venting changes priced on site'],
        actions: [
          { label: 'Request this quote', primary: true, action: { event: { name: 'request_quote' } } },
          { label: 'Adjust details', action: { event: { name: 'adjust' } } },
        ],
      },
    ],
  },
};

/** Booking step 3: the confirmation, with a hold. */
export const confirmSurface = (expiresAt: string) => ({
  version: 'v1.0',
  createSurface: {
    surfaceId: 'booking-confirm',
    catalogId: STEPS_CATALOG,
    components: [
      {
        id: 'root',
        component: 'ConfirmCard',
        heading: 'Confirm your visit',
        date: '2026-11-25',
        title: 'Drain and sewer rodding',
        subtitle: 'Wednesday · arrive 10 am – 12 pm',
        expiresAt,
        rows: '${/rows}',
        note: 'Only these details go to Copperline, not the conversation.',
        confirm: { label: 'Confirm booking', action: { event: { name: 'confirm_booking', context: { hold: { path: '/hold' } } } } },
        cancel: { label: 'Change time', action: { event: { name: 'change_time' } } },
      },
    ],
    dataModel: {
      hold: 'hold-42',
      rows: [
        { label: 'Address', value: '12 Elm St, Chicago 60630' },
        { label: 'Contact', value: 'Dana R. · (312) 555-0136' },
      ],
    },
  },
});

/** Booking step 3, after the commit: the receipt. */
export const RECEIPT = {
  version: 'v1.0',
  createSurface: {
    surfaceId: 'booking-receipt',
    catalogId: STEPS_CATALOG,
    components: [
      {
        id: 'root',
        component: 'ReceiptCard',
        title: "You're booked",
        summary: 'Wed, Nov 25 · 10 am – 12 pm',
        reference: { value: 'CPL-4821' },
        nextSteps: 'The technician calls about 30 minutes before arriving.',
        calendar: { url: 'https://relay.example/v1/s/site/booking/ics/CPL-4821.ics' },
        actions: [
          { label: 'Reschedule', action: { event: { name: 'reschedule' } } },
          { label: 'Back to assistant', action: { event: { name: 'nxis.back' } } },
        ],
        cancel: { label: 'Cancel this visit', action: { event: { name: 'cancel_visit' } } },
      },
    ],
  },
};

/** Quote step 1 with the guided intake's components (`ui.surfaces` 2): the job, as chips under a step header. */
export const INTAKE = {
  version: 'v1.0',
  createSurface: {
    surfaceId: 'quote-intake',
    catalogId: STEPS_CATALOG,
    components: [
      { id: 'root', component: 'Card', child: 'body' },
      { id: 'body', component: 'Column', children: ['head', 'service', 'fuel', 'zip', 'area', 'acts'] },
      { id: 'head', component: 'StepHeader', step: 1, of: 3, caption: 'The job', title: '${/form/service}' },
      {
        id: 'service',
        component: 'ChoiceChips',
        label: 'Service',
        max: 4,
        options: [
          { value: 'Water heater replacement', label: 'Water heater replacement' },
          { value: 'Plumbing service call', label: 'Plumbing service call' },
          { value: 'Drain and sewer rodding', label: 'Drain and sewer rodding' },
          { value: 'Sump pumps', label: 'Sump pumps', hint: 'and flood control' },
          { value: 'Boiler and radiator service', label: 'Boiler and radiator service' },
          { value: 'Furnace repair and installation', label: 'Furnace repair and installation' },
          { value: 'other', label: 'Something else' },
        ],
        value: { path: '/form/service' },
      },
      { id: 'fuel', component: 'ChoiceChips', label: 'Fuel', options: '${/fuels}', value: { path: '/form/fuel' }, action: { event: { name: 'pick_fuel', context: { fuel: { path: '/form/fuel' } } } } },
      { id: 'zip', component: 'TextField', label: 'ZIP code', value: { path: '/form/zip' } },
      { id: 'area', component: 'FieldNote', text: '${/area}', tone: 'ok' },
      { id: 'acts', component: 'Row', children: ['back', 'go'] },
      { id: 'back', component: 'Button', child: 'back_l', action: { event: { name: 'nxis.back' } } },
      { id: 'back_l', component: 'Text', text: 'Back' },
      { id: 'go', component: 'Button', child: 'go_l', variant: 'primary', action: { event: { name: 'continue', context: { form: { path: '/form' }, label: 'Continue' } } } },
      { id: 'go_l', component: 'Text', text: 'Continue' },
    ],
    dataModel: {
      form: { service: 'Furnace repair and installation', fuel: '', zip: '60630' },
      fuels: [
        { value: 'gas', label: 'Gas' },
        { value: 'electric', label: 'Electric' },
      ],
      area: 'Inside the Chicago service area',
    },
  },
};
