# contracts/visual/

`murmur-mark.svg` — the status mark. One file, both platforms, four states.

It sits next to `contracts/setup/v1/` because it is the same kind of thing: an
agreement two implementations must not drift from.

## Why a single file

The mark is drawn once here and never redrawn inside a product. A product that
keeps its own copy of the paths drifts from this one silently, and the drift is
only noticed when the two sit side by side on a screenshot.

## Geometry

Frame 38 × 38 in a 48 viewBox, `rx 8`, stroke 2.5, no fill. Two filled nodes,
`r 4.5`, at `cx 15` and `cx 33`. Edge between them, stroke 3.

The glyph says what the product is: two agents and the channel between them.

## States are carried by shape, not colour

On macOS the mark ships as a template image, so the system decides the colour
and every state would otherwise collapse into the same silhouette. Shape has to
answer the question on its own:

| symbol | shape | reads as |
|---|---|---|
| `murmur-ready` | solid edge | connected |
| `murmur-idle` | no edge | not connected |
| `murmur-unread` | solid edge, dot above it | something new arrived |
| `murmur-failed` | broken edge, stroke above the break | the channel is broken |

On Windows there is no template mode, so colour stays a legal carrier and runs
alongside shape. Both channels together, not colour alone: a person who cannot
separate the hues and a person with thirty icons in the tray read the same mark.

Four shapes cover more than four internal states. `unknown`, `stopped`, `paused`
and `offline` all map to `murmur-idle`, because the difference between "no edge"
and "edge with a gap" is one pixel at 18 pt and nobody sees it. The exact state
is spelled out in words in the first menu item; the mark answers only the
coarse question.

## Acceptance before a release

Render every state at 16 and 18 px, read the alpha per pixel, and look at the
result — not at the source. A glyph whose inner strokes merge is simplified
here and regenerated; it is never patched inside the product.

That test already rejected four candidates: ring-shaped nodes fill in at 18 px,
a 4 px edge merges with the nodes into one blob, large nodes without a frame
swallow the edge, and a 3 px frame on a 40 × 40 square clips at 16 px. The
failed state was first drawn with a cross on the edge; the cross merged into a
block and was replaced by the stroke above the break.

## What the file carries besides the paths

`color` on the root gives `currentColor` a value, so opening the file shows the
mark instead of nothing. `role="img"` with a `<title>` makes it readable by a
screen reader. `data-schema` names the version, so a consumer can refuse a file
it does not understand rather than draw something unexpected. The `<use>` at the
end renders `murmur-ready` with the colour signal, which turns the source into
its own preview.

The colour signal is a 6 x 4 rectangle at `x 32 y 5`, `#D92027` — the same red
the site already uses for the packet travelling along the edge. A template image
drops it, because a template has no colour; the window header, About and the app
icon keep it.

## Not for the menu bar

`docs/images/murmur-logo.svg` is a filled gradient circle. It stays for the
README and the web page. In a template image it collapses into a solid blot,
so it never goes into the menu bar or the tray.
