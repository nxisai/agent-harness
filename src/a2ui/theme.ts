/**
 * Theme tokens for A2UI surfaces.
 *
 * The Lit renderer styles its components entirely through `--a2ui-*` custom
 * properties. Those inherit across shadow boundaries, so setting them on the
 * element containing `<a2ui-surface>` restyles everything inside it without
 * `::part()`, a forked catalog, or a patched package.
 *
 * Values map onto the tokens the packaged element already declares, so surfaces
 * follow the same palette rather than carrying a second copy of it.
 *
 * The rules encoded here:
 *   - sans first: Manrope for the title, Inter for everything readable
 *   - mono for labels only: field labels and tags, never body copy
 *   - blue for trust and action: the primary button and focus ring
 *   - light by default
 */
export const A2UI_THEME_CSS = `
  .a2ui-scope {
    /* Core roles */
    --a2ui-color-primary: var(--blue);
    --a2ui-color-primary-hover: var(--blue-strong);
    --a2ui-color-primary-dark: var(--blue-strong);
    --a2ui-color-primary-light: var(--blue-tint);
    --a2ui-color-on-primary: #FFFFFF;
    --a2ui-color-secondary: var(--surface);
    --a2ui-color-secondary-hover: var(--surface-2);
    --a2ui-color-on-secondary: var(--ink);
    --a2ui-color-surface: var(--bg);
    --a2ui-color-on-surface: var(--ink);
    --a2ui-color-on-background: var(--ink);
    --a2ui-color-border: var(--border);
    --a2ui-color-input: var(--bg);
    --a2ui-color-on-input: var(--ink);

    /* Type — Manrope displays, Inter reads (design.md §1) */
    --a2ui-font-family-title: var(--display);
    --a2ui-font-size-xs: 11px;   /* eyebrow / label size, matching .dc-row dt */
    --a2ui-font-size-s: 13px;
    --a2ui-font-size-m: 14px;
    --a2ui-font-size-l: 18px;   /* markdown ### → .dc-title size */
    --a2ui-font-size-xl: 22px;
    --a2ui-font-size-2xl: 31px;
    --a2ui-line-height-body: 1.65;
    --a2ui-line-height-headings: 1.25;
    --a2ui-text-color-text: var(--ink);
    --a2ui-text-caption-color: var(--ink-3);  /* same muted label ink as .dc-row dt */
    --a2ui-text-a-color: var(--blue);
    --a2ui-text-a-font-weight: 600;

    /* Radii — 14px cards, 10px buttons, 999px pills (design.md §1) */
    --a2ui-border-radius: var(--radius-sm);
    --a2ui-border: 1px solid var(--border);
    --a2ui-border-width: 1px;

    --a2ui-card-background: var(--bg);
    --a2ui-card-border: 1px solid var(--border);
    --a2ui-card-border-radius: var(--radius);
    --a2ui-card-box-shadow: var(--shadow-sm);
    /* 22px matches .detailcard, so an input card and a review card sitting in
       the same thread share one rhythm rather than three inherited paddings. */
    --a2ui-card-padding: 22px;
    --a2ui-card-margin: 0;

    /* Buttons: radius 10, weight 600, one primary per view (design.md §4) */
    --a2ui-button-border-radius: var(--radius-sm);
    --a2ui-button-font-weight: 600;
    --a2ui-button-padding: 11px 20px;
    --a2ui-button-border: 1px solid var(--border-strong);
    --a2ui-button-background: var(--bg);
    --a2ui-button-box-shadow: none;
    /* Buttons sit in a Row with its own gap; a margin here would double it. */
    --a2ui-button-margin: 0;
    /* The label is a Text child, so the button's own colour comes from the
       secondary text token — this is what makes a default A2UI button read as
       .btn.ghost rather than as unstyled chrome. */
    --a2ui-color-on-secondary: var(--ink);
    --a2ui-color-secondary-hover: var(--surface-2);

    /* Inputs */
    --a2ui-textfield-border: 1px solid var(--border);
    --a2ui-textfield-border-radius: var(--radius-sm);
    --a2ui-textfield-padding: 10px 12px;
    --a2ui-textfield-color-border-focus: var(--blue);
    --a2ui-textfield-color-error: var(--red);
    --a2ui-textfield-label-font-size: 11px;
    --a2ui-textfield-label-font-weight: 500;

    --a2ui-checkbox-border: 1px solid var(--border-strong);
    --a2ui-checkbox-border-radius: 6px;
    --a2ui-checkbox-background: var(--bg);
    --a2ui-checkbox-color-error: var(--red);
    --a2ui-checkbox-size: 18px;
    --a2ui-checkbox-gap: 10px;
    --a2ui-checkbox-label-font-size: 14px;
    --a2ui-checkbox-label-font-weight: 400;

    /* Tags render as ChoicePicker chips / caption Text — pill radius */
    --a2ui-choicepicker-chip-border-radius: var(--radius-pill);
    --a2ui-choicepicker-chip-padding: 6px 12px;
    --a2ui-choicepicker-label-color: var(--ink-3);
    --a2ui-choicepicker-label-font-size: 11px;
    --a2ui-choicepicker-label-font-weight: 500;

    /* Rhythm */
    --a2ui-spacing-xs: 4px;
    --a2ui-spacing-s: 8px;
    --a2ui-spacing-m: 12px;
    --a2ui-spacing-l: 18px;
    --a2ui-column-gap: 12px;
    --a2ui-row-gap: 10px;
    --a2ui-list-gap: 12px;
    --a2ui-list-padding: 0;

    font-family: var(--sans);
    color: var(--ink);
  }

  /*
   * Mono for labels only (design.md §3.2). The renderer has no token for label
   * *family*, only size and weight, so the eyebrow treatment is applied to the
   * label elements directly. Scoped to .a2ui-scope so it cannot leak.
   */
  .a2ui-scope a2ui-surface::part(label),
  .a2ui-scope label {
    font-family: var(--mono);
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--ink-3);
  }
`;

/** Signal Blue — the one theme value A2UI itself carries on createSurface. */
export const NXIS_PRIMARY = '#2563EB';
