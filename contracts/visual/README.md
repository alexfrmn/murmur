# contracts/visual/

`murmur-mark.svg` — the status mark for the menu bar and the tray. One file,
both platforms, four states.

It sits next to `contracts/setup/v1/` because it is the same kind of thing: an
agreement two implementations must not drift from.

## It is the product logo, not a new drawing

The mark is derived from `docs/images/murmur-logo.svg` and keeps what makes the
logo recognisable: the indigo-to-violet circle, the two signal waves, the lock
between them. Two things changed, both forced by measurement at tray sizes:

- **The wordmark is gone.** At 18 px `MURMUR` renders as a smear of noise along
  the bottom edge, and it reads no better at 32 px. A wordmark that cannot be
  read is dirt on the glyph.
- **The strokes are thicker and the shapes larger.** With the original 3 px
  strokes only 1.6 % of the icon's pixels came out bright at 18 px — the lock
  and the waves were effectively invisible inside a flat purple disc. At 6 px
  the same drawing reaches 8 %, and both the lock and the waves survive.

The logo file itself is untouched; it stays as the full lockup for the README
and the web page.

## A coloured mark is a deliberate choice

macOS also accepts template images, which the system tints to match the menu
bar. That route was considered and rejected: a template has no colour, so every
state collapses into one silhouette, and the mark loses the one thing that makes
it findable among thirty neighbours — being the purple one. Coloured menu bar
items are ordinary; a typical bar already carries several.

The cost is that a coloured mark does not adapt to light and dark bars, which is
why the circle is a filled disc: it carries its own background and reads on both.

## States

| symbol | what changes | reads as |
|---|---|---|
| `murmur-ready` | indigo to violet | connected |
| `murmur-idle` | the same drawing in grey | not connected |
| `murmur-unread` | red dot on the upper right, white outline | something new arrived |
| `murmur-failed` | the whole circle turns red | the channel is broken |

Measured at 18 px: `ready` has no red pixels at all, `unread` has 30 of 275,
`failed` has 243 of 261. The three are not confusable at a glance, which is the
only test that matters here.

Four states cover seven internal ones on purpose. `unknown`, `stopped`, `paused`
and `offline` all map to `murmur-idle`: the mark answers the coarse question,
and the exact state is spelled out in words in the first menu item.

On Windows the same four are used directly, since colour is the native carrier
there. The hover tooltip must still name the product and the state in words —
colour alone is not a message.

## What the file carries besides the paths

`role="img"` with a `<title>` makes it readable by a screen reader.
`data-schema` names the version, so a consumer can refuse a file it does not
understand rather than draw something unexpected. The glyph lives once in a
`<g>` and is referenced by all four symbols, so a change to the lock or the
waves cannot apply to three states out of four. The `<use>` at the end renders
`murmur-ready`, which turns the source into its own preview.

## A known overlap, left on purpose

The unread dot covers part of the outer right wave. That is the source, not a
rendering fault, and it stays: the dot has to be the loudest thing on the icon,
and an unread mark that yields to decoration is not a mark.

Measured at 32 px, the overlap costs nothing legible. In the box the right wave
occupies, `ready` has 45 white pixels and `unread` has 52 — the dot's white ring
puts back more than the red circle takes. The lock and the inner wave are
untouched and are tested separately.

A smaller dot was tried (`r 18`, moved outward): it clears the wave but drops
from 72 red pixels to 47, which is the wrong trade. Do not "fix" this overlap
without re-running both numbers.

## Acceptance before a release

Render every state at 18 and 32 px, read the pixels, and look at the numbers —
not at the source, and not at a 120 px preview where everything always looks
fine. A shape whose strokes disappear is thickened here and regenerated; it is
never patched inside the product.

That test already rejected four candidates: the logo with its wordmark (1.6 %
bright pixels at 18 px, nothing legible), a lock-only variant (legible but it
drops the waves, and with them the idea of two parties), outline nodes instead
of a filled circle (no background of its own, so it disappears on a matching
bar), and a thin-stroke version of this same drawing.
