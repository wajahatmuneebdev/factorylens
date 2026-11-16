# FactoryLens accessibility verification

FactoryLens targets WCAG 2.2 Level AA for its focused desktop and tablet web
experience. Automated checks are a regression gate, not a substitute for
assistive-technology review.

## Automated coverage

`npm run test:e2e` runs axe-core against the signed-out page, dashboard, new
inspection form, history, and completed investigation. It also verifies route
focus, keyboard entry into the form, the 1024 CSS-pixel tablet layout, a 640
CSS-pixel layout equivalent to a 1280-pixel viewport at 200% zoom, and reduced
motion. Component tests cover lifecycle states, upload progress and errors,
dialogs, filters, timeline controls, video naming, and the Canvas text
alternative.

## Manual keyboard and zoom pass

Completed on 2026-11-16 in Chromium against the deterministic Playwright
application server.

| Area | Checks completed | Result |
| --- | --- | --- |
| Sign-in and shell | Tab order, visible focus, skip link, primary navigation, signed-out redirect | Pass |
| New inspection | Source radios, file input, recording controls, progress, cancellation, validation recovery | Pass |
| History | Search, status filter, horizontally scrollable table, pagination, empty and error recovery | Pass |
| Processing | Queued, processing, retry wait, cancellation, failure, retry, cancelled, and completed states | Pass |
| Investigation | Native video controls, class checkboxes, confidence range, event buttons, exports, Canvas text alternative | Pass |
| Account dialog | Initial focus, Tab and Shift+Tab containment, Escape, close action, trigger focus restoration | Pass |
| Reflow | Desktop and tablet widths; 200% browser zoom without page-level horizontal scrolling | Pass |

The status views retain the last loaded durable state and announce a warning if
a background refresh fails. Loading and non-background failures are announced,
and retry actions remain available. Canvas annotations have a programmatic text
equivalent for the current sampled frame; they do not replace the native video
controls.

## Repeating the manual pass

Use only the keyboard to move through each row above at 100% and 200% zoom.
Confirm that focus remains visible, route changes place focus on main content,
dialogs do not leak focus, every control has a useful accessible name, status
changes are announced without exposing private artifact data, and no content is
lost at the desktop or tablet breakpoints. Repeat with reduced motion enabled.
