# Status page theming

Paste these into Instatus → **HTML**, one per tab of the same name. They are kept here so
the page's appearance is versioned alongside the panel it mirrors — Instatus has no history
of its own, and a page nobody can diff is a page nobody dares change.

| File | Tab |
|---|---|
| `custom.css` | custom.css |
| `in-head-tag.html` | in-head-tag.html |
| `below-footer.html` | below-footer.html |

Paste `custom.css` over the placeholder rule that is there by default — the `background-color:
red` example is not a starting point, it is a smoke test.

## Caveat

Instatus owns the markup. Class names on a hosted product can change without notice, so the
selectors here are broad on purpose: elements, and attribute-contains matches rather than
exact hashed class names. If the page ever looks half-styled, open devtools on the live page
and check what the elements are actually called — the failure is upstream, not in the CSS.

The colours are the panel's `emerald` theme tokens (`--bg #0d1117`, `--surface #161b22`,
`--accent #00d97e`) and its two fonts, so the two sites read as one product.
