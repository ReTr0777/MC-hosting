# Status page theming

Paste these into Instatus → **HTML**, one per tab of the same name. They are kept here so
the page's appearance is versioned alongside the panel it mirrors — Instatus has no history
of its own, and a page nobody can diff is a page nobody dares change.

| File | Tab |
|---|---|
| `custom.css` | custom.css |
| `in-head-tag.html` | in-head-tag.html |
| `below-components.html` | below-components.html |
| `below-footer.html` | below-footer.html |

Paste `custom.css` over the placeholder rule that is there by default — the `background-color:
red` example is not a starting point, it is a smoke test.

## Scope, and why it is narrow

Colour, type, and one added element. Nothing structural.

The first version also set backgrounds and borders on `[class*='component']` and
`[class*='incident']`. It looked reasonable and broke the page: a substring match hits every
nested wrapper rather than the row, so each one drew its own card — offset boxes overlapping
the notice list, borders past the container edge, stray rules through the footer.

The rule that came out of it: style what an element *is* (a link, a heading, a `<time>`), not
where it sits. Instatus owns the structure, does not document it, and can change it without
notice. Anything structural needs the real class names read off the live page in devtools,
and needs re-checking whenever the page looks off.

The colours are the panel's `emerald` theme tokens (`--bg #0d1117`, `--surface #161b22`,
`--accent #00d97e`) and its two fonts, so the two sites read as one product.
