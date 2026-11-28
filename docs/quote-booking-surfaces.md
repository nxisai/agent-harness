# Step surfaces: quotes and bookings in the chat

A handoff target can draw its steps in the chat instead of asking for everything in words: a short intake form, an estimate with its sources, a day and arrival-window picker, the review the visitor says yes to, and a receipt. The target sends [A2UI](https://a2ui.org) messages beside its reply, and the harness draws them under the reply's bubble with the **steps catalog**: the basic catalog's layout and input components plus ten of its own, and a TextField that can say whether it is required and show its own error. A choice or a press goes back to the target on the same task.

Two flows are drawn with it:

- **Quote:** guided intake → estimate with sources → review, send and receipt.
- **Booking:** service and next openings → day and window → confirm, add to calendar and reschedule.

The rules are the handoff's:

- **Only the visitor commits.** A send or a booking happens only after the visitor presses the confirm button on a `ConfirmCard`, which shows exactly what will be sent. Nothing else sends a commit, whatever the target writes.
- **Typing always works.** What the visitor types still goes to the target as words, and the target can update the same surface from them.
- **Everything is data.** Messages are read strictly (below), every string is drawn as text, and a surface never opens a link or runs anything by itself.

It builds on [handing a conversation off](handoff.md): the parts below are the handoff extension's, `https://nxis.ai/a2a/handoff/v1`.

## Whether the page draws them

The envelope's `ui` says so, by version:

| `ui.surfaces` | The page draws |
| --- | --- |
| `3` | Everything below, including a field's `required`, `optional` and `error` ([field markers and errors](#field-markers-and-errors)). |
| `2` | The guided intake's `ChoiceChips`, `StepHeader` and `FieldNote` too. A TextField or ChoiceChips with `required`, `optional` or `error` may not be drawn, so send the error as a `FieldNote` under the field. |
| `1` | The basic components and `DayStrip`, `WindowGrid`, `HoldCountdown`, `DateTile`, `EstimateCard`, `ConfirmCard` and `ReceiptCard`. A `ChoiceChips`, `StepHeader` or `FieldNote` is dropped, so send version 1's cards (a ChoicePicker, a caption Text). |
| none | No surfaces (an older harness). Ask in words instead. |

## From the target: the `surface` part

On an agent message, beside its text part, which is still required:

```json
{
  "data": { "handoff": "surface", "messages": [ { "version": "v1.0", "createSurface": { "…": "…" } } ] },
  "mediaType": "application/json",
  "metadata": { "extension": "https://nxis.ai/a2a/handoff/v1" }
}
```

- **A2UI v1.0.** The harness downgrades to v0.9 for its renderer, as it does for its own surfaces: `createSurface` may carry `components` and `dataModel` inline, and a dynamic value is a whole-string `"${/path}"` (or `"${relative}"` inside a List template) or a `{ "path": "/…" }` binding. A string that mixes words and an expression (`"Hi ${name}"`) is drawn literally.
- **The catalog:** `catalogId: "https://nxis.ai/a2ui/catalogs/steps/v1.json"`. A surface that names the basic v1.0 catalog is drawn with the steps catalog too.
- **The messages:**

  | Message | What the page does |
  | --- | --- |
  | `createSurface { surfaceId, catalogId, components, dataModel }` | Draws a new card under this message's bubble. Sent again for a `surfaceId` already drawn, it replaces the earlier card. |
  | `updateComponents { surfaceId, components }` | Updates the card wherever it is in the thread. A component sent again replaces the one with its id. |
  | `updateDataModel { surfaceId, path, value }` | Updates the card's data, wherever it is. |
  | `deleteSurface { surfaceId }` | Removes the card. |

  A message with only updates, and no words, adds nothing to the thread of its own. The conversation keeps each surface as last updated, so it is drawn the same after a reload.
- **Components:** Card, Column, Row, List, Text, Button, ChoicePicker, TextField, CheckBox, DateTimeInput, Divider and Icon from the basic catalog, and the [step components](#the-step-components). Image, Video, AudioPlayer, Tabs, Modal and Slider are dropped from a remote surface, and so is anything else.
- **Actions** are events only: `{ "event": { "name", "context"? } }`. A component with a `functionCall` action, or that calls `openUrl` anywhere, is dropped. Validation `checks` with the basic functions (`required`, `regex`, `email`, …) work.
- **Limits:** a `surfaceId` is `[A-Za-z0-9_-]{1,64}`; a part carries up to 20 messages and 48 KB of JSON; a surface has up to 150 components; a conversation keeps up to 8 surfaces, and the oldest goes first. A `ChoiceChips` has up to 50 choices, each with a `value` and words up to 200 characters; a `StepHeader` up to 10 steps, whole numbers, `step` no more than `of`; a `FieldNote`'s `tone` is `ok`, `warn` or `info`; a field's `required` and `optional` are booleans, not both `true`, and its `error` is words up to 200 characters or a binding. What breaks a rule is dropped, not cut short: a component with a literal over its limit is dropped when it arrives, and one whose bound list is over it draws nothing.

## From the page: the `action` part

When the visitor presses a button or makes a choice on a component with an `action`, the page sends `SendStreamingMessage` on the same task, with the task's `Nxis-Handoff-Key`:

```json
{
  "role": "ROLE_USER", "taskId": "…", "contextId": "…",
  "parts": [
    { "text": "10 am – 12 pm" },
    {
      "data": {
        "handoff": "action",
        "surfaceId": "booking-slots",
        "name": "pick_window",
        "component": "windows",
        "context": { "date": "2026-11-25", "window": "win-10", "label": "10 am – 12 pm" }
      },
      "mediaType": "application/json",
      "metadata": { "extension": "https://nxis.ai/a2a/handoff/v1" }
    }
  ]
}
```

| Field | Holds |
| --- | --- |
| `surfaceId`, `name`, `component` | The surface, the event's name and the component that sent it. |
| `context` | The event's context, every `{ "path" }` resolved against the surface's data after the choice was written to it. To receive a form, put `{ "path": "/form" }` in the context. A step component adds `label`, the choice in words, when the context has none. |
| `commit` | `true` only for a `ConfirmCard`'s confirm button. **A target commits only on an action with `commit: true`**; any other action is a choice. |
| `consent` | With `commit`: `{ rows, at }`, the rows the visitor saw and when they pressed. |

- The text part is `context.label` when it is a string, else the event's name, so a target that ignores the extension still reads the visitor's choice. The page doesn't draw it as the visitor's message (the surface shows the choice), and the page's own model never sees it. It goes through the same input checks as typed words.
- **The page's own events** are never sent: `nxis.back` (Back to the assistant: ends the handoff) and `nxis.open` (`context.url`: a `tel:` number dials; an https address opens when it is on this page's origin, an origin in `link-origins`, or the relay's, after the guardrails' navigation check).
- **One at a time.** Once an action is sent, every surface in the conversation is inert until the target answers. A `ConfirmCard`'s surface stays done once confirmed, until the target sends it again (`createSurface`, or `updateComponents` for it).
- **Superseded surfaces are inert for good.** When the handoff is over (handed back, ended or failed), and once a later reply creates a new surface, every surface no reply has touched since (by `createSurface`, `updateComponents` or `updateDataModel`) is superseded: it can't be pressed or edited, it is dimmed, and its countdowns stop and never send their action. Surfaces created by the same reply stay live together; an update to an older surface keeps it live. After a reload, the same holds.
- **Unsent edits survive a reload.** What the visitor types or picks on a live surface is kept with the conversation, per surface, and drawn into it again after a reload. It goes once the surface sends an action, is superseded, or is created again; a target's `updateDataModel` is written over it.
- Keys that start with `nxis:` in a context are the page's: a target's own are removed.
- **The visitor's details.** An action whose `context.form` has fields named `name`, `email`, `phone`, `street`, `city` or `zip` (or another of `PROFILE_ALIASES`' names for them) keeps their values for the conversation, and the next agent's envelope `contact` carries them. A `clear_details` event ("Not you? Clear details") clears them first, then is sent like any other. See [the visitor's details](handoff.md#the-visitors-details).

## The step components

A prop marked *dynamic* takes a literal or a `{ "path" }` binding (or `"${/path}"`). An action is `{ "event": { "name", "context"? } }`.

Every choice is a real button, at least 44 px each way, with `aria-pressed` for a choice and a focus ring. A full day or window is disabled and says so. Colors are the element's theme tokens (`--bg`, `--ink`, `--blue`…), so a theme, a dark one included, styles these as it does the rest. Icons are [Heroicons](https://heroicons.com).

In a step surface, the fields' labels (a ChoicePicker's, a TextField's) share the step components' label: the ink color, 13 px, semibold. A step surface spans the width of the chat.

### `ChoiceChips`

A field's choices as chips: one choice, or several. Two or three short choices are drawn as a segmented control ("Gas | Electric"). Past `max`, the rest wait behind a **More (n)** button (`aria-expanded`); a chosen one always shows.

| Prop | Type | |
| --- | --- | --- |
| `label` | dynamic string, optional | The field's name, drawn above the chips and naming their group: "Service". |
| `options` | dynamic list of `{ value, label, hint? }` | `label` "Water heater replacement"; `hint`, smaller, after it: "same day". |
| `value` | `{ path }` | Where the choice is written: the chosen `value`, or with `multiple` a list of them. |
| `multiple` | boolean, optional | Several choices: each press adds or removes one. |
| `segmented` | boolean, optional | Default: on for two or three choices, each 14 characters or fewer, with no hints. `false` keeps chips; `true` asks for it with more. Never with `multiple`. |
| `max` | number, optional | How many show before **More**. Default 6. |
| `moreLabel` | dynamic string, optional | Default "More". |
| `action` | action, optional | Sent after each choice, with the choice's words as `label`. Leave it out for a field that is sent with the form (a Continue button with `{ "form": { "path": "/form" } }`). |
| `required`, `optional`, `error` | | From `ui.surfaces` 3. See [field markers and errors](#field-markers-and-errors). |

### `StepHeader`

Where the visitor is: "Step 2 of 3 · The job" on the left, the job's title on the right, and a bar per step under them, filled up to this one. Read out as a `progressbar` with the step and the title.

| Prop | Type | |
| --- | --- | --- |
| `step`, `of` | dynamic number | This step and how many there are, 1 to 10. A step past `of` is drawn as the last. |
| `caption` | dynamic string, optional | The step's name: "The job". |
| `title` | dynamic string, optional | The job: "Water heater replacement". Bind it to the service's value (`{ "path": "/form/service" }`) and it follows the visitor's choice. |

### `FieldNote`

One line under a field, with a Heroicon for its tone: a check for `ok` ("Inside the Chicago service area"), a warning for `warn` ("The business may not serve ZIP code 60999."), an information circle for `info`. It is a `status`, so a change is read out. Empty text draws nothing, so a target can bind it and fill it in with `updateDataModel` later.

| Prop | Type | |
| --- | --- | --- |
| `text` | dynamic string | The line. |
| `tone` | dynamic string, optional | `ok` (green), `warn` (red) or `info` (default, muted). |

### `TextField`

The basic catalog's TextField, drawn by the steps catalog: `label`, `value` (a `{ path }`), `variant` (`shortText`, `longText`, `number`, `obscured`), `validationRegexp` and `checks` as in the basic catalog, plus, from `ui.surfaces` 3:

| Prop | Type | |
| --- | --- | --- |
| `required`, `optional` | boolean, optional | "Required" or "Optional" after the label, in the muted ink. A required field is `aria-required`. Not both. |
| `error` | dynamic string, optional | The field's error, drawn under it. See below. |
| `inputType` | `text`, `email`, `tel`, `url` or `numeric`, optional | What the field holds, for the visitor's keyboard and autofill: an email address is an `email` input, a phone number a `tel` one, and `numeric` (a ZIP code) a text input with the numeric keyboard (`inputmode="numeric"`), so a leading zero is kept. A page before this ignores it. |
| `autocomplete` | string, optional | The browser's autofill hint, up to four tokens of `[a-z0-9-]`: `name`, `email`, `tel`, `street-address`, `address-level2`, `postal-code`. |

### Field markers and errors

From `ui.surfaces` 3, a TextField and a ChoiceChips take `required`, `optional` and `error`.

- **Markers.** Mark what may be left empty with `optional: true` ("Optional", as in the intake mock), or what must be filled with `required: true` ("Required"). Pick one way per form: when most fields are required, mark the optional ones.
- **Errors in place.** Bind each field's `error` to a path of its own and fill them all in one `updateDataModel`, so the visitor sees every problem at once, each under its field, instead of one per turn at the bottom of the card. An error is drawn as a warn `FieldNote` under the field (red, with the warning Heroicon, a `status`), and the field is `aria-invalid` and names it in `aria-describedby`. Empty words draw nothing, so clearing a path clears its error. When the visitor edits the field (types in it, or picks a chip), the page clears its bound error itself, so a fixed ZIP code loses its error at once; the target's next check sets it again if it is still wrong. Without `error`, a TextField whose `checks` fail shows the check's message the same way.

```json
{ "id": "zip", "component": "TextField", "label": "ZIP code", "value": { "path": "/form/zip" }, "required": true, "error": { "path": "/errors/zip" } }
```

```json
{ "version": "v1.0", "updateDataModel": { "surfaceId": "quote-where", "path": "/errors", "value": { "zip": "We don't serve ZIP code 53202. The service area is Chicago and nearby suburbs.", "street": "Add the street address." } } }
```

The target still checks the form itself when it arrives (the `action` part's `context.form`): an error drawn on the page is a hint for the visitor, not a check.

### `DayStrip`

A week's days, one button each.

| Prop | Type | |
| --- | --- | --- |
| `label` | dynamic string | The group's name and caption: "This week". |
| `days` | dynamic list of `{ value, weekday, day, disabled?, note? }` | `value` is the day's id (`"2026-11-25"`), `weekday` "Wed", `day` "25". A `disabled` day shows its `note` ("Full") and can't be chosen. |
| `value` | `{ path }` | Where the chosen day's `value` is written. |
| `action` | action, optional | Sent after a choice: `pick_day` with `{ "date": { "path": "/booking/date" } }`. |
| `previous`, `next` | action, optional | Earlier and later days, as chevron buttons. Drawn only when given. |

### `WindowGrid`

A day's arrival windows, in two columns.

| Prop | Type | |
| --- | --- | --- |
| `label` | dynamic string | "Wednesday, arrival window". |
| `windows` | dynamic list of `{ value, label, open?, disabled?, held? }` | `label` "10 am – 12 pm". `open` is how many the business has left, drawn as "2 open". `open: 0` or `disabled` is drawn as **Full** and can't be chosen. Without `open`, no count is shown. `held: true` (a boolean) is the visitor's own hold: drawn as "Held for you" in place of the count (and in its accessible name), never disabled, whatever `open` or `disabled` say, so send it for the held window and leave out its `open`. |
| `value` | `{ path }` | Where the chosen window's `value` is written. |
| `action` | action, optional | Sent after a choice: `pick_window`, for the target to check it and hold it. |

### `HoldCountdown`

The time left on the business's hold: "Held for you · 9:41 left". It is a `timer` that assistive technology doesn't read out every second; when it reaches zero it says so, as a status. On a superseded surface it draws nothing, stops, and never sends its action.

| Prop | Type | |
| --- | --- | --- |
| `expiresAt` | dynamic string, ISO 8601 | When the hold ends. Empty draws nothing: no hold, no countdown. |
| `label` | dynamic string, optional | Default "Held for you". |
| `expiredLabel` | dynamic string, optional | Default "The hold has ended. Pick the time again." |
| `action` | action, optional | Sent once when it reaches zero: `hold_expired`. |

### `DateTile`

The date as a tile, "NOV" over "25", in the visitor's language, read out in full ("Wednesday, November 25").

| Prop | Type | |
| --- | --- | --- |
| `date` | dynamic string, `YYYY-MM-DD` | The day. |

### `EstimateCard`

A price range from the site's own prices, with what it includes and what is priced on site.

| Prop | Type | |
| --- | --- | --- |
| `eyebrow` | dynamic string, optional | "Estimate · Service". |
| `title` | dynamic string | "Water heater replacement". |
| `low`, `high` | dynamic number (`high` optional) | Drawn in `currency`, in whole units when whole: "$1,800 – $2,600". |
| `currency` | dynamic string | ISO 4217: `"USD"`. |
| `qualifier` | dynamic string, optional | "installed". |
| `note` | dynamic string, optional | "From the site's published prices · not a binding price". |
| `cites` | dynamic list of numbers, optional | Source numbers, as the reply's Sources list numbers them (see [Citations](#citations)). Drawn as the same markers after the note; pressing one moves to that row. |
| `included` | dynamic list of strings, optional | Rows with a check: "Haul-away of the old tank". |
| `onSite` | dynamic list of strings, optional | Rows with a wrench: "Venting changes priced on site". |
| `actions` | up to 2 `{ label, action, primary? }`, optional | "Request this quote" (primary), "Adjust details". |

### `ConfirmCard`

What will be sent or booked, and the visitor's yes. The only place a commit comes from.

| Prop | Type | |
| --- | --- | --- |
| `heading` | dynamic string | "What will be sent to McManus Electric". |
| `date` | dynamic string, `YYYY-MM-DD`, optional | Draws a `DateTile` (a booking). |
| `title`, `subtitle` | dynamic string, optional | "Drain and sewer rodding", "Wednesday · arrive 10 am – 12 pm". |
| `expiresAt` | dynamic string, optional | Draws a `HoldCountdown`. Once it runs out, confirm is disabled. |
| `rows` | dynamic list of `{ label, value }` | Exactly what is sent. Echoed back in `consent.rows`. |
| `note` | dynamic string, optional | "Only these details are sent, not the conversation." |
| `confirm` | `{ label, action }` | "Send", "Confirm booking". Sent with `commit: true` and `consent`. Pressed once, it says "Sent. Waiting for the answer…". |
| `cancel` | `{ label, action }`, optional | "Not now", "Change time". |

### `ReceiptCard`

What a commit came to.

| Prop | Type | |
| --- | --- | --- |
| `title` | dynamic string | "Quote request sent", "You're booked". |
| `summary` | dynamic string, optional | "Wed, Nov 25 · 10 am – 12 pm". |
| `reference` | `{ label?, value }`, optional | The reference, under "Reference" unless `label` says otherwise. |
| `nextSteps` | dynamic string, optional | "The technician calls about 30 minutes before arriving." |
| `calendar` | `{ label?, url }`, optional | **Add to calendar**, a secondary button: the visit's `.ics` file. Drawn only for an https `url`, and downloaded only from this page's origin, a `link-origins` origin or the relay's: a plain download where the visitor is, with no confirmation, no new window and no navigation, so serve it as an attachment (`Content-Type: text/calendar`, `Content-Disposition: attachment`). Make one of `actions` the primary. Once a receipt is on screen, the handoff bar says the target is done rather than waiting for a reply. |
| `actions` | up to 3 `{ label, action, primary? }`, optional | "Reschedule", "Book a visit too", "Back to assistant" (`nxis.back`). |
| `cancel` | `{ label, action }`, optional | A quiet link-style button: "Cancel this visit". A cancellation is a commit too, so the target should answer it with a `ConfirmCard`. |

An `EstimateCard`, `ConfirmCard` or `ReceiptCard` with `inset: true` draws without its own border, padding and shadow: for one inside a `Card` under that Card's `StepHeader`, so step 3 reads like steps 1 and 2. A page before this ignores it.

## Citations

As in a Support answer: the message's [`answer`](handoff.md#answer-cards-for-an-answers-sources) part draws numbered markers in the reply and its **Sources** list. Sources are numbered in the order the reply's `claims` first cite them, then in card order, and `EstimateCard.cites` uses those numbers. When the reply comes with a step card (an estimate), the Sources list is drawn under the card rather than in the bubble.

## Colors

The step components draw in the element's tokens. A primary button, a chosen chip or day, the step bars and the markers are the accent (`theme.accent`, the `--blue` token); a chosen chip's words are its pressed shade (`accentStrong`) on its wash (`accentTint`). A site that gives only its accent (its brand color) gets the other two mixed from it, so its cards read in the brand, not the default blue. A card's primary button fills the rest of its row; give a basic Button `weight: 1` (Continue beside Back) for the same.

## The steps, as drawn

| Step | Components |
| --- | --- |
| Quote 1 · intake (`ui.surfaces` 2) | Two steps, each a `Card › Column`. **The job:** `StepHeader` (`title` bound to the service), `ChoiceChips` for the service (the closest few, More, "Something else") and the timeline, TextField (what needs doing), a `FieldNote` for what is missing, `Row › Button` (Back; Continue with `{ "form": { "path": "/form" } }`). **Where and who:** `StepHeader`, TextField (ZIP) with a `FieldNote` for the service-area check, then the address and contact fields not already known, Back and Continue. From `ui.surfaces` 3, the fields carry `required` or `optional`, and each one's `error` is bound to `/errors/<field>`, all filled at once when Continue finds problems. |
| Quote 1 · intake (`ui.surfaces` 1) | `Card › Column`: a caption Text ("STEP 1 OF 3"), ChoicePicker (`mutuallyExclusive`), TextField (ZIP, notes), CheckBox, a caption Text for the service-area check, `Row › Button` (Back; Continue with `{ "form": { "path": "/form" } }`). Basic catalog only. |
| Quote 2 · estimate | The reply with `claims` and an `answer` part, and `EstimateCard` (actions `request_quote`, `adjust`). From `ui.surfaces` 2, a `StepHeader` above it. |
| Quote 3 · review, send, receipt | `ConfirmCard` (confirm `send_quote`, cancel `not_now`), then `ReceiptCard` with the reference, next steps and actions (`book_visit`, `nxis.back`). |
| Booking 1 · service and openings | A List of Cards, one per service, each with a List of opening Buttons (`pick_opening`), a "Pick another day and window" Button, a TextField for the ZIP, and an emergency Card whose Button is `nxis.open` with `{ "url": "tel:…" }`. Basic catalog only. |
| Booking 2 · day and window | `Row` (the service, Change), `DayStrip` (`pick_day`), `WindowGrid` (`pick_window`), a caption Text, `HoldCountdown` once there is a hold, and a primary Button labelled `"${/booking/summary}"` (`continue`). |
| Booking 3 · confirm, calendar, reschedule | `ConfirmCard` with `date`, `title`, `subtitle`, `expiresAt` and the rows (confirm `confirm_booking`, cancel `change_time`), then `ReceiptCard` with `calendar.url`, actions `reschedule` and `nxis.back`, and `cancel` (`cancel_visit`). |

When the business offers no counts or no hold, leave out `open` and `HoldCountdown`. A commit that comes back taken answers with the day and window step again.

## Headless

`./a2ui` exports the reading and the constants for a target's own tests: `readSurfaceMessages` (the strict reading), `STEPS_CATALOG`, `STEP_COMPONENTS`, `BASIC_ALLOWED`, `PAGE_EVENTS`, `SURFACE_LIMITS`, `surfaceIdOf`, `foldSurface`, and the `SurfaceAction` type. `HandoffController.send(conversationId, text, parts)` sends words with extension parts, an `action` part among them.

The element loads the steps catalog and its components as a chunk of their own with the first reply that has a surface, so a page whose targets send none pays nothing for them.
