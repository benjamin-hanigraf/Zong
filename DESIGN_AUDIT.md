# Zong — Design & UX audit (report only)

**Nothing in this report has been implemented.** No layout, spacing, colour, typography, icon,
animation, sizing or interaction was changed as part of the audit. Each item needs your explicit
approval before I touch it.

Method: read through every screen and component in `src/App.jsx` and `src/styles.css`, measured
the colour tokens, and compared screenshots of 8 screens (start, empty songs, add-song form, songs
list, song view, setlists, settings, piano) before and after the cleanup — all 8 were pixel-identical.
Line numbers refer to `src/App.jsx` at the time of the audit and move as the file changes; the
function/const names are the stable reference.

Priority: **P1** = affects usability/accessibility for real users, **P2** = noticeable polish,
**P3** = nice to have.

---

## 1. Accessibility

| # | Pri | Finding | Where | Recommendation |
|---|-----|---------|-------|----------------|
| A1 | P1 | Only **1 of ~74** buttons has an accessible name (`aria-label` exists only on "Delete override"). Icon-only buttons (back chevrons, play/stop, +/−, kebab, metronome toggle, key ± buttons) are announced as "button" by VoiceOver/TalkBack. | `SongDetailScreen`, `Knob`, `MetronomeScreen`, `SongForm`, `SettingsScreen` | Add `aria-label` to every icon-only button (e.g. "Back", "Start metronome" / "Stop metronome", "Tempo up"). |
| A2 | P1 | Text colour `textFaint #4D4D50` is **2.49 : 1** on black (WCAG AA needs 4.5 : 1 for text). It is used in ~29 places, including the 11px form/section labels (`Field` label, `SectionLabel`: hard-coded `#4D4D50`), placeholders, and the "Created by…" line. `#6A6A6E` (artist/subtitle text) is 3.9 : 1. `textMuted #98989D` (≈6.9 : 1) and the three accent colours (5.8–11.5 : 1) pass. | `colorsFor()`, `Field`, `SectionLabel`, `SongRow`, `SettingsScreen` footer | Raise `textFaint` to about `#8A8A8E` (≥4.5 : 1) for text; keep the current value only for decorative lines/disabled icons. |
| A3 | P1 | Pinch-zoom and system text scaling are disabled: `html, body { touch-action: none; position: fixed }` plus fixed px font sizes. Users who need larger text cannot get it (WCAG 1.4.4). | `styles.css` | Keep the app-style layout but allow pinch-zoom in song view, or add an in-app text-size setting that scales UI text too (the Settings font sizes only affect song text). |
| A4 | P1 | No visible keyboard-focus indicator on buttons; inputs hide the browser outline and only draw a coloured ring on `:focus` (not `:focus-visible`). Keyboard / switch-control users (iPad keyboard, desktop PWA) cannot see where they are. | `styles.css` (`button`, `input:focus`) | Add a `:focus-visible` outline for buttons and custom controls. |
| A5 | P2 | Touch targets below the 44 × 44 pt guideline: song-view chevron buttons **28 × 28** (`chevronBtn`), key buttons **44 × 28** (`keyButtonStyle`), beat-accent dots **9 px** (`BeatAccentControl`, tap to cycle accent/mute), Settings ± steppers **36 × 36**, setlist header buttons ~30 px. | `SongDetailScreen`, `BeatAccentControl`, `SettingsScreen` | Enlarge the hit area (invisible padding) without changing the visible size. |
| A6 | P2 | Toast messages ("Songs synced", errors) are plain `<div>`s without `role="status"` / `aria-live`, so they are never announced. | `flash()` / toast element | Add `role="status" aria-live="polite"`. |
| A7 | P2 | Information shown by colour only: lit vs unlit beat dot, accent vs normal vs mute dot (mute is an outline). | `BeatAccentControl`, `dotColor()` | Add a non-colour cue (size/shape) or an `aria-label` describing the state. |
| A8 | P2 | `-webkit-user-select: none` on everything but inputs: lyrics, chords and descriptions cannot be selected/copied. | `styles.css` | Allow selection inside the song content area. |
| A9 | P3 | No `prefers-reduced-motion` handling for the swipe and button-press animations. | `styles.css`, swipe hook | Disable/shorten animations when the user asks for reduced motion. |

## 2. Typography & readability

| # | Pri | Finding | Where | Recommendation |
|---|-----|---------|-------|----------------|
| T1 | P1 | **8 px** bottom-tab labels (Songs / Setlists / Settings…) are below any readable minimum. | tab bar (`fontSize: 8`) | 10–11 px minimum. |
| T2 | P2 | 17 distinct font sizes are in use (8, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 17, 18, 22, 26, 60) with half-pixel steps that add no visible difference. | whole app | Collapse to a small type scale (e.g. 11, 13, 15, 17, 22, 26). |
| T3 | P2 | Several label styles at 11–12.5 px with different weights and letter-spacing (form labels, settings labels, song-view labels). | `Field`, `SectionLabel`, form labels | One shared "label" style. |
| T4 | P3 | Song titles/artists are single-line with ellipsis, so long titles cannot be read in the list. | `SongRow` | Allow two lines, or show the full title on long-press. |
| T5 | P3 | Tamil size is matched to Latin x-height at runtime (`--ta-scale`); only titles/artists use it. Lyrics and chord charts are not scaled (would break chord alignment). | `Tamil`, `measureTamilScale` | Decide whether Tamil lyric lines should get a font-size bump per mode. |

## 3. Spacing, layout & consistency

| # | Pri | Finding | Where | Recommendation |
|---|-----|---------|-------|----------------|
| L1 | P2 | Spacing values are ad-hoc numbers (14, 16, 18, 20, 22, 26, 40, 60 px …) and border radii mix 6, 8, 9, 10, 12, 18, 50 %. Control heights mix 28, 30, 34, 36, 44, 48, 64. | whole app | Define spacing/radius/height tokens (e.g. 4-pt grid) and map existing values to the nearest token. |
| L2 | P2 | Layout is phone-only: containers use `width: 100%` with no `max-width`, so on iPad / desktop PWA lines of lyrics and settings rows stretch very wide. | `SettingsScreen`, `SongDetailScreen`, `SongsScreen` | Cap content width (~640 px) and centre it. |
| L3 | P2 | Safe areas are applied per screen (`paddingTop: env(safe-area-inset-top)` repeated on several full-screen containers; now moved into the sticky header on the song form and setlist editor). Behaviour differs between screens; the bottom tab bar uses `max(36px, 8px + env(safe-area-inset-bottom))`. | all `position: fixed` screens | One shared screen-shell component that owns the safe areas. |
| L4 | P2 | Keyboard handling is per screen: `useKeyboardInset` is wired into some screens individually, so behaviour with the on-screen keyboard can differ between screens (not tested on a device). | `useKeyboardInset` users | Apply uniformly through the shared shell. |
| L5 | P3 | Hidden gestures without visible affordance: long-press the song title to edit, swipe a row to delete, right-swipe to load into piano/metronome, edge-swipe back. The back-swipe edge zone (24 px, 80 px in the song view) overlaps the browser/OS back gesture in the PWA. | `SongDetailScreen`, `SongRow`, `useEdgeSwipeBack` | Add a small first-run hint or visible affordances. |
| L6 | P3 | Icon sizes vary (15, 16, 18, 22, 26 px) for similar roles; the stroke weight is only consistent among the lucide icons and the new metronome icon. | whole app | One size per role (nav, toolbar, inline). |
| L7 | P3 | The piano uses `LandscapeLock`, which rotates the whole view on every device class, while `manifest.webmanifest` declares `"orientation": "portrait"`. Expected, but worth documenting so it is not mistaken for a bug. | `PianoScreen`, `manifest.webmanifest` | Keep, or allow native landscape on iPad. |

## 4. Colours & visual hierarchy

| # | Pri | Finding | Recommendation |
|---|-----|---------|----------------|
| C1 | P2 | The amber (Drums) accent `#FFB020` and green (Vocals) pass contrast; **blue (Chords) `#0A84FF` is 4.66 : 1 on `surface2`** — right at the AA limit for small text. | Use a slightly lighter blue for small text on elevated surfaces. |
| C2 | P3 | Several hard-coded colours bypass the theme tokens (`#4D4D50`, `#6A6A6E`, `#0B0B0C`, `#1F1F1F`, `#fff`). | Move them into `colorsFor()` so theme changes are one edit. |
| C3 | P3 | Pressed-state feedback is a global `button:active { transform: scale(.94); opacity: .8 }`, including large cards/rows, so big buttons shrink noticeably. | Smaller scale for large buttons. |

## 5. Native iOS-specific

| # | Pri | Finding | Recommendation |
|---|-----|---------|----------------|
| N1 | P2 | `UIRequiredDeviceCapabilities` is `armv7`; every supported device is arm64. | Change to `arm64` (project-metadata change, not visual). |
| N2 | P3 | Live Activity: buttons are 40 pt (below 44 pt) and the bar has no accessibility labels (`Button(intent:)` uses images only). | Add `.accessibilityLabel` and 44 pt targets. |
| N3 | P3 | The Dynamic Island compact trailing view shows only the BPM number (no unit). | Optional "BPM" suffix in the expanded view only. |

---

## Suggested order if you approve changes
1. A1, A2, T1, A5 (accessibility basics — invisible or nearly invisible to sighted users).
2. A4, A6, L2 (focus ring, announcements, tablet width).
3. T2/T3/L1 (type scale and spacing tokens) — larger, visible change; best done as one reviewed pass.
