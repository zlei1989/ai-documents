# Archify vendored engine

- Upstream: https://github.com/tt-a1i/archify
- Version: v3.1.0
- License: MIT (see `archify/LICENSE` and `archify/THIRD_PARTY_NOTICES.md`)
- Vendored at: 2026-10-17
- Removed from the upstream skill to keep the repository lean: `examples/` only.
- Prefer not to edit vendored files in place; the only exceptions are the documented
  local patches below. Upgrade by replacing `vendor/archify` from the pinned upstream tag,
  reapply the patches, then run the `@aidocs/archify` tests.
- Runtime path override for local development: `AIDOCS_ARCHIFY_ROOT=/path/to/archify`.

## Local patches (aidocs)

These are deliberately *not* upstream; reapply them after replacing `vendor/archify`
from the pinned tag, then run `pnpm vitest run packages/server/archify/src/archify.test.ts`
and a visual check of the workflow sample.

1. `renderers/workflow/workflow-compiler.mjs`
   - Lane horizontal inset `leftInset = 8` → `16`; right lane padding `+ 8` → `+ 16`.
     Cards were only 8px from the lane's left/right border.
   - Lane vertical content padding `sharedVerticalExtent.maximum * 2 + 8` → `+ 24`
     (and the independent-lane branch). A 68px tagged card sat 4px from the lane
     bottom border; it now has 12px.
   - Phase header: removed the hairline `.phase-rule` and the small `.phase-chip`;
     each phase now renders a rounded `.phase-band` spanning its columns with the
     label centered. The old line-through-pill timeline read as a broken axis.
2. `renderers/shared/node-card-style.mjs`
   - Added `.phase-band` / `.phase-band-security` fills and strokes.

3. `renderers/dataflow/dataflow-compiler.mjs`
   - Automatic dataflow frames used to stretch every stage to `viewBox[1] - stageY - stageBottomPad`.
     A stage with one node row therefore carried ~140px of empty frame under the row.
   - Each stage frame now hugs its own node bottom plus 22px (`layout.stageH + 80` minimum);
     the shared row grid, routes and labels are unchanged. A stage with a second row stays taller.

4. `renderers/timeline/render-timeline.mjs`
   - `event.detail` was only exposed through the interactive node title; the poster card showed
     only time + title. It now renders as a second line (8.5px) inside the card. Card width
     includes the detail's natural width (still capped at 200px), long detail wraps, and card
     height grows by the detail line count so lane packing stays correct.

Upstream candidates: both changes are presentation-only and guarded by the existing
workflow layout contract; upstreaming them would remove the patch burden.
