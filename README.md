# Zong — Developer Handoff & Technical Architecture Guide

**Zong** is a progressive web application (PWA) designed for live worship teams (Vocalists, Instrumentalists, and Drummers). It provides an offline-first song library, synchronized shared setlists, Nashville number chord charting, Tamil-to-Tanglish transliteration, a sample-accurate metronome, and a Web Audio vocal pitch reference chord piano.

---

## 1. High-Level Architecture & Technology Stack

```
                                  ┌────────────────────────────────────────────────────────┐
                                  │                  Zong Client (PWA)                     │
                                  │                                                        │
                                  │  ┌────────────────┐ ┌────────────────┐ ┌─────────────┐ │
                                  │  │  Vocals Mode   │ │  Chords Mode   │ │ Drums Mode  │ │
                                  │  └───────┬────────┘ └───────┬────────┘ └──────┬──────┘ │
                                  │          │                  │                 │        │
                                  │  ┌───────┴──────────────────┴─────────────────┴──────┐ │
                                  │  │          Core UI & State Engine (App.jsx)          │ │
                                  │  └───────┬──────────────────┬─────────────────┬──────┘ │
                                  └──────────┼──────────────────┼─────────────────┼────────┘
                                             │                  │                 │
                         ┌───────────────────┴──┐   ┌───────────┴──────────┐   ┌──┴──────────────────┐
                         │  Web Audio Engine    │   │ Local Cache Layer    │   │ Supabase Sync Layer │
                         │  - Lookahead Metro   │   │ - IndexedDB (Songs)  │   │ - supabaseSync.js   │
                         │  - Chord Synthesizer │   │ - localStorage (UI)  │   │ - Realtime WS Push  │
                         │  - Stereo Chorus     │   │ - ServiceWorker (PWA)│   │ - Auto-Conflict Res │
                         └──────────────────────┘   └──────────────────────┘   └──────────┬──────────┘
                                                                                          │
                                                                           ┌──────────────┴──────────────┐
                                                                           │  Supabase Cloud Database    │
                                                                           │  ├─ zong_global (Songs)     │
                                                                           │  └─ zong_teams (Setlists)   │
                                                                           └─────────────────────────────┘
```

- **Frontend**: React 19 + Vite (Vanilla CSS design system, zero external UI component frameworks for maximum performance and low bundle size).
- **Icons**: `lucide-react`.
- **Audio Engine**: Native browser Web Audio API (`AudioContext`, `BiquadFilterNode`, `StereoPannerNode`, `DynamicsCompressorNode`, `OscillatorNode`).
- **Data Persistence**:
  - **IndexedDB**: Master offline copy of songs, setlists, and custom spelling chart.
  - **localStorage**: Client-only preferences (selected mode, font sizes, chord visibility toggles, metronome sound presets).
- **Cloud Backend & Realtime Sync**: Supabase Database with Realtime replication enabled via WebSockets.
- **Offline / PWA**: Service Worker (`public/sw.js`) with cache-first strategy for static assets and web app manifest (`public/manifest.webmanifest`).

---

## 2. Directory & File Structure

```
Zong/
├── README.md                      # Complete system documentation (this file)
├── package.json                   # Project metadata, dependencies, and build scripts
├── vite.config.js                 # Vite build configuration (React plugin)
├── index.html                     # HTML root with PWA meta tags and font loaders
├── vercel.json                    # Vercel deployment and routing configuration
├── .env.example                   # Template for environment variables
├── .env                           # Local environment secrets (VITE_SUPABASE_URL, etc.)
│
├── src/
│   ├── App.jsx                    # Primary application monolithic file (UI, state, Audio, Tanglish)
│   ├── main.jsx                   # React application entry point (registers Service Worker)
│   ├── supabaseSync.js            # Supabase API client, optimistic syncing, and Realtime listeners
│   ├── bandSync.js                # Legacy Google Apps Script sync client (superseded by Supabase)
│   └── styles.css                 # Global CSS resets, typography, dark mode tokens, animations
│
├── public/
│   ├── manifest.webmanifest       # PWA manifest (app name, colors, standalone display, icons)
│   ├── sw.js                      # Cache-first service worker for full offline functionality
│   ├── favicon-16x16.png          # Browser favicon
│   ├── favicon-32x32.png          # High-resolution favicon
│   ├── apple-touch-icon.png       # iOS home screen touch icon
│   ├── icon-192.png               # Standard PWA icon (192x192)
│   ├── icon-512.png               # High-res PWA icon (512x512)
│   ├── icon-maskable-192.png      # Android adaptive maskable icon
│   ├── icon-maskable-512.png      # Android adaptive maskable icon (512x512)
│   └── icons/                     # Additional asset variants
│
├── supabase/
│   └── schema.sql                 # SQL schema, RLS policies, seed scripts, and Realtime publications
│
├── apps-script/
│   └── Code.gs                    # Legacy Google Apps Script backend code
│
└── scripts/
    └── render-icon.swift          # macOS Swift script for compositing icon layers
```

---

## 3. Core Subsystems Breakdown

### 3.1. Mode Architecture (Vocals, Chords, Drums)
Zong dynamically reorganizes its user interface based on the active musician mode configured in Settings:

1. **Vocals Mode**:
   - First tab in bottom navigation is **Chord Piano**.
   - Lyrics and Nashville / Letter chords are displayed with high contrast.
   - Right-swiping any song row loads that song's key & quality into the Chord Piano.
   - Add/Edit song default section tab opens directly to **Lyrics**.
2. **Chords Mode**:
   - Displays chord progressions and charts with real-time transposition.
   - Includes quick toggles between **Chords** tab (pure chord progression sheet without lyrics) and **Chart** tab (chord chart with chords embedded over lyrics).
   - **Chords Tab Engine**: Uses `ChordsOnlyBlock` to render clean chord lines (Nashville numbers or letter chords) and plain text notes without embedding chords into invisible lyric character grids.
   - Add/Edit song default section tab opens directly to **Chords**.
3. **Drums Mode**:
   - First tab in bottom navigation is the **Metronome**.
   - Songs display drum cue sheets, time signatures, subdivisions, and accent patterns.
   - Right-swiping any song row loads its tempo, time signature, and subdivision into the live Metronome.
   - Add/Edit song default section tab opens directly to **Drums**.

---

### 3.2. Web Audio Engines

#### A. Lookahead Metronome Engine (`MetronomeEngine`)
- **Sample-Accurate Timing**: Does not use JavaScript `setInterval` for sound generation. Instead, it uses a 25ms scheduler loop that schedules Web Audio oscillator clicks ahead into the `AudioContext.currentTime` timeline.
- **Accents & Subdivisions**: Supports full accent matrices (e.g. 4/4 with beat 1 accentuated, or complex syncopated meters) and subdivisions (1, 2, 3, 4 clicks per beat).
- **Seamless Tempo Changes**: Tempo adjustments from dial spins or ± buttons calculate timeline phase shifts on-the-fly without stopping or restarting the audio context.
- **Tone Presets**: Multiple synthesized click sounds (Woodblock, Beep, Click, Rimshot, Cowbell).

#### B. Vocal Pitch Reference Chord Piano (`startPadChord`)
- **Open 10th Voicing (`Root_Low` + `5th` + `Root_High` + `3rd`)**:
  - `Root_Low` (C3–B3, 130–246 Hz): Solid, warm foundation on phone speakers without sub-bass clipping.
  - `5th`: Mid-register harmonic stability.
  - `Root_High` (C4–B4, 261–493 Hz): Dominant guide note that matches both male and female vocal ranges.
  - `3rd`: Color tone establishing Major vs Minor quality.
- **Stereo Width & Warmth**: Notes are spread across the stereo panorama (`StereoPannerNode`).
- **Chorus Pairs**: Each note uses two detuned sine oscillators for natural acoustic spread instead of a sterile test-tone.
- **Air Layer**: A soft octave-up harmonic layer adds presence while low-pass filters (2200 Hz roll-off) prevent mobile speaker distortion.
- **Continuous Range**: Smooth semitone progression across all 12 keys with zero sudden drops or octave cliffs.

---

### 3.3. Tamil-to-Tanglish Transliteration Engine

Located inside `src/App.jsx`, this engine converts Tamil-script song lyrics and titles into Latin Tanglish script offline in real time.

#### Positional Voicing Rules
Consonants alternate between unvoiced and voiced forms based on their phonetic position:
- **க (KA / GA)**:
  - At word-start or after twin pulli `க்` (`க்க`): **`ka / kka`** (e.g. `பக்கம்` → `pakkam`).
  - In middle or end without `க்` in front: **`ga`** (e.g. `பகை` → `pagai`, `மகன்` → `magan`).
- **ச (SA / CHA)**:
  - At word-start or in middle without `ச்` in front: **`sa`** (e.g. `விசை` → `visai`, `சமாதானம்` → `samaadhaanam`).
  - After twin pulli `ச்` (`ச்ச`): **`cha`** (e.g. `பச்சை` → `pachai`, `மகிழ்ச்சி` → `magizhchi`, `பேச்சு` → `pechu`).
  - After `ட்` (`ட்ச`): **`cha`** (e.g. `காட்சி` → `kaatchi`).
- **ப (PA / BA)**:
  - At word-start or after twin pulli `ப்` (`ப்ப`): **`pa / ppa`** (e.g. `படம்` → `padam`, `அப்பம்` → `appam`).
  - In middle or end without `ப்` in front: **`ba`** (e.g. `கிருபை` → `kirubai`, `சுபாவம்` → `subaavam`, `அன்பு` → `anbu`).
- **ட (TA / DA)**:
  - At word-start or after twin pulli `ட்` (`ட்ட`): **`ta / tta`** (e.g. `பாட்டு` → `paattu`, `கூட்டம்` → `koottam`).
  - In middle or end without `ட்` in front: **`da`** (e.g. `படம்` → `padam`, `நாடகம்` → `naadagam`, `வண்டு` → `vandu`).
- **த (THA / DHA)**:
  - At word-start or after twin pulli `த்` (`த்த`): **`tha / ttha`** (e.g. `தமிழ்` → `thamizh`, `பத்து` → `pathu`, `நித்தம்` → `nitham`).
  - In middle or end without `த்` in front: **`dha`** (e.g. `வேதம்` → `vedham`, `கவிதை` → `kavidhai`, `தந்தை` → `thandhai`).
- **Special Clusters & Vowel Rules**:
  - `ன்ற` / `ன்றி` / `ன்று` → **`ndr` + vowel** (e.g. `நன்றி` → `nandri`, `என்று` → `endru`).
  - `ஞ்ச` / `ஞ்சி` / `ஞ்சு` → **`nj` + vowel** (e.g. `தஞ்சை` → `thanjai`, `பஞ்சு` → `panju`, `மஞ்சள்` → `manjal`).
  - `ங்க` → **`nga`** (nasal drops double `g` → `தங்கம்` → `thangam`).
  - `ற்ற` → **`tra / tri`** (geminate `ற` sounds as `t` + `r` → `காற்று` → `kaatru`).
  - `ஔ` / `ௌ` → **`ou`** (e.g. `கௌரவம்` → `gouravam`, `பௌர்ணமி` → `pournami`).
  - `ய்` + vowel → diphthong conversion (e.g. `-ஆய்` → `-aai`).

#### Tag-Preserving Character Offset Mapping
Chord tags embedded inside words (e.g., `ப[G]ரிசுத்த[Am]ரே`) are mapped through an offset-tracking array (`transliterateTamilWordWithOffsets`), ensuring chord markers land on the exact syllable in Tanglish without drift.

#### Spelling Chart Override System (`SpellingChartModal`)
Musicians can override any word's transliteration globally. Tapping "+ Add word..." or clicking an entry opens a modal that writes directly to the dictionary (`activeTanglishExceptions`), instantly updating all song sheets.

---

### 3.4. Supabase Cloud Sync & Real-Time Collaboration

File: [src/supabaseSync.js](file:///Users/benjaminhanigraf/Desktop/Zong/src/supabaseSync.js)

```
Supabase Architecture:
  Table: zong_global (Row id = 'main')
    ├── revision: integer
    ├── songs: jsonb (Global song library shared by all users)
    └── spelling_chart: jsonb (Shared custom transliterations)

  Table: zong_teams (Row team_key = '<team_code>')
    ├── revision: integer
    ├── shared_setlists: jsonb (Setlists shared within this team)
    └── subscribers: jsonb (Array of active device IDs)
```

1. **Optimistic Locking**:
   - Each push sends the client's known `baseRevision`.
   - The database only accepts writes if `revision == baseRevision`.
   - On conflict, Zong automatically fetches remote changes, merges local non-duplicate items, and retries.
2. **WebSocket Realtime Subscriptions**:
   - `subscribeToChanges()` registers Postgres change listeners on `zong_global` and `zong_teams`.
   - When any team member saves a song or reorders a setlist, all devices update instantly without polling.
3. **Automatic Team Cleanup**:
   - Devices register their random UUID in `subscribers`.
   - When a musician leaves a team or disconnects, `leaveTeam()` removes their ID. If 0 subscribers remain, the team row is deleted from Supabase automatically.

---

### 3.5. Mobile Touch & Viewport UX Engineering

- **Viewport Scroll Pinning**: Fixed-position full-screen layouts register a `window.scrollTo(0, 0)` handler on resize/scroll to prevent mobile browser address bars from shifting touch targets.
- **Keyboard Insets (`useKeyboardInset`)**: Listens to `window.visualViewport` resize events to detect on-screen keyboards, padding bottom modals so input fields remain accessible.
- **Swipe-to-Delete Isolation**: `SongRow` tracks `wasOpenRef` during touch-start. If the delete button was already open, swiping right only closes the row — a fresh gesture is required to trigger the "Load to Piano / Metronome" action.

---

## 4. Setup, Local Development & Deployment

### Prerequisites
- Node.js 18+
- Supabase account (Free tier is sufficient for hundreds of concurrent users)

### Local Installation
```bash
# 1. Clone repository
git clone <repo-url>
cd Zong

# 2. Install dependencies
npm install

# 3. Create .env file
cp .env.example .env

# 4. Fill in your Supabase project credentials in .env:
# VITE_SUPABASE_URL=https://your-project.supabase.co
# VITE_SUPABASE_ANON_KEY=your-anon-key

# 5. Start development server
npm run dev
```

### Supabase Database Setup
1. Log in to [Supabase Console](https://supabase.com).
2. Open **SQL Editor** -> **New Query**.
3. Paste the contents of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.
4. In **Database -> Replication**, confirm that `supabase_realtime` has `zong_global` and `zong_teams` enabled.

### Production Build & Deployment
```bash
# Build the production bundle
npm run build

# Preview production build locally
npm run preview
```

#### Vercel Deployment
1. Import the repository into Vercel.
2. Add Environment Variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
3. Deploy (Vercel automatically picks up [`vercel.json`](vercel.json) and Vite output).

---

## 5. Storage Keys & Data Models

### Song Schema
```typescript
interface Song {
  id: string;                  // "id-<timestamp>-<random>"
  title: string;               // Song title (e.g. "Parisuthare")
  artist?: string;             // Artist / author name
  key: string;                 // "C", "F#", "Bb", etc.
  keyQuality: "Major"|"Minor"; // Key quality
  tempo?: number | "";         // BPM (e.g. 128)
  timeSignature?: string;      // "4/4", "3/4", "6/8", etc.
  subdivision?: number;        // 1, 2, 3, 4
  lyricsText: string;          // Plain lyrics with section markers (-Verse, -Chorus)
  chordsText: string;          // Nashville/Letter chords notation (e.g. "1 [4] 5")
  chartText: string;           // Inline chord chart notation (e.g. "[C]Lyrics")
  drumsText: string;           // Drum cue notations
  description?: string;        // Notes for the band
  accents?: number[];          // Metronome accent pattern (0 or 1 per beat)
  language?: string;           // "Tamil", "English", etc.
  updatedAt?: number;          // Timestamp in ms
}
```

### LocalStorage Keys
| Key | Type | Description |
|---|---|---|
| `altar:musician-mode` | `"vocals" \| "chords" \| "drums"` | Active musician interface mode |
| `altar:tanglish-mode` | `boolean` | Global Tanglish transliteration toggle |
| `altar:song-view-chords-mode` | `"chords" \| "chart"` | Song detail chords/chart view state |
| `altar:song-view-metro-bar` | `boolean` | Floating metronome bar visibility |
| `altar:click-settings` | `object` | Metronome click tone & volume preferences |
| `altar:team-key` | `string` | Connected church / team code |
| `altar:device-id` | `string` | Unique device identifier for subscriber tracking |

---

## 6. Maintenance & Troubleshooting

- **Service Worker Updates**: When deploying new code, the service worker automatically checks for updates on navigation. Users receive updates on next refresh.
- **Audio Unlock on iOS**: iOS Safari requires user interaction before Web Audio can output sound. Tapping any button or piano key triggers `ensureCtx()` which initializes the audio context.
- **Conflict Recovery**: If two devices edit offline and reconnect simultaneously, the server merges entries. If a remote write wins, local changes are preserved and re-merged rather than discarded.
