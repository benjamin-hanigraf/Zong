/* =============================================================================
   Zong Google Sheets sync endpoint  -  multi-sheet edition
   =============================================================================
   Setup:
   1. Open your Google Sheet, Extensions, Apps Script, paste this file.
   2. Project Settings, Script Properties:
        ZONG_ACCESS_KEY  =  <your band/team code>   (e.g. "FACA")
   3. Deploy, New deployment, Web app.
        Execute as: Me    |    Access: Anyone
   4. Paste the /exec URL into VITE_ZONG_SYNC_URL.

   Sheet layout (all sheets are auto-created on first request):
     SyncMeta       -- revision (A2) | lastUpdatedMs (B2)
     Songs          -- id | json (one song per row, starting row 2)
     SpellingChart  -- tamil | tanglish (one word per row, starting row 2)
     SharedSetlists -- id | json (one setlist per row, starting row 2)

   All writes are wrapped in LockService so concurrent requests from 30 devices
   can never corrupt data.  Lock timeout = 10 seconds.
   ============================================================================= */

const META_SHEET     = 'SyncMeta';
const SONGS_SHEET    = 'Songs';
const CHART_SHEET    = 'SpellingChart';
const SETLISTS_SHEET = 'SharedSetlists';


function doGet() {
  return reply_({ ok: true, service: 'Zong sync v2' });
}

function doPost(e) {
  try {
    var body     = JSON.parse(e.postData.contents || '{}');
    var expected = PropertiesService.getScriptProperties().getProperty('ZONG_ACCESS_KEY');

    // -- Public pull (no key needed) -----------------------------------------
    if (body.action === 'public_pull') {
      var s = read_();
      return reply_({ ok: true, revision: s.revision,
        state: { songs: s.songs, spellingChart: s.spellingChart } });
    }

    // -- Public push ----------------------------------------------------------
    if (body.action === 'public_push') {
      return withLock_(function() {
        var s = read_();
        if (Number(body.baseRevision) !== s.revision) {
          return reply_({ ok: true, conflict: true, revision: s.revision,
            state: { songs: s.songs, spellingChart: s.spellingChart } });
        }
        var nextSongs = body.state && body.state.songs         != null ? body.state.songs         : s.songs;
        var nextChart = body.state && body.state.spellingChart != null ? body.state.spellingChart  : s.spellingChart;
        var nextRev   = s.revision + 1;
        write_({ revision: nextRev, songs: nextSongs, spellingChart: nextChart, sharedSetlists: s.sharedSetlists });
        return reply_({ ok: true, revision: nextRev,
          state: { songs: nextSongs, spellingChart: nextChart } });
      });
    }

    // -- Team actions (require ZONG_ACCESS_KEY) --------------------------------
    if (!expected || body.key !== expected) {
      return reply_({ ok: false, error: 'Invalid team access code.' });
    }

    if (body.action === 'pull' || body.action === 'team_pull') {
      var s = read_();
      return reply_({ ok: true, revision: s.revision,
        state: { songs: s.songs, spellingChart: s.spellingChart, sharedSetlists: s.sharedSetlists } });
    }

    if (body.action === 'push' || body.action === 'team_push') {
      return withLock_(function() {
        var s = read_();
        if (Number(body.baseRevision) !== s.revision) {
          return reply_({ ok: true, conflict: true, revision: s.revision,
            state: { songs: s.songs, spellingChart: s.spellingChart, sharedSetlists: s.sharedSetlists } });
        }
        var nextSongs    = body.state && body.state.songs          != null ? body.state.songs          : s.songs;
        var nextChart    = body.state && body.state.spellingChart  != null ? body.state.spellingChart   : s.spellingChart;
        var nextSetlists = body.state && body.state.sharedSetlists != null ? body.state.sharedSetlists  : s.sharedSetlists;
        var nextRev      = s.revision + 1;
        write_({ revision: nextRev, songs: nextSongs, spellingChart: nextChart, sharedSetlists: nextSetlists });
        return reply_({ ok: true, revision: nextRev,
          state: { songs: nextSongs, spellingChart: nextChart, sharedSetlists: nextSetlists } });
      });
    }

    return reply_({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    return reply_({ ok: false, error: String(err.message || err) });
  }
}

// ---------------------------------------------------------------------------
//  Lock helper -- prevents concurrent write collisions
// ---------------------------------------------------------------------------

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
//  Read -- assembles state from the four named sheets
// ---------------------------------------------------------------------------

function read_() {
  ensureSheets_();
  var ss = SpreadsheetApp.getActive();

  // Revision
  var metaSheet = ss.getSheetByName(META_SHEET);
  var metaRow   = metaSheet.getRange(2, 1, 1, 2).getValues()[0];
  var revision  = Number(metaRow[0] || 0);

  // Songs: each row is [id, json]
  var songsSheet = ss.getSheetByName(SONGS_SHEET);
  var songRows   = songsSheet.getLastRow() > 1
    ? songsSheet.getRange(2, 1, songsSheet.getLastRow() - 1, 2).getValues()
    : [];
  var songs = songRows
    .filter(function(r) { return r[1]; })
    .map(function(r) { try { return JSON.parse(r[1]); } catch(ex) { return null; } })
    .filter(Boolean);

  // Spelling chart: each row is [tamil, tanglish]
  var chartSheet = ss.getSheetByName(CHART_SHEET);
  var chartRows  = chartSheet.getLastRow() > 1
    ? chartSheet.getRange(2, 1, chartSheet.getLastRow() - 1, 2).getValues()
    : [];
  var spellingChart = {};
  chartRows.filter(function(r) { return r[0]; }).forEach(function(r) { spellingChart[r[0]] = r[1]; });

  // Shared setlists: each row is [id, json]
  var slSheet  = ss.getSheetByName(SETLISTS_SHEET);
  var slRows   = slSheet.getLastRow() > 1
    ? slSheet.getRange(2, 1, slSheet.getLastRow() - 1, 2).getValues()
    : [];
  var sharedSetlists = slRows
    .filter(function(r) { return r[1]; })
    .map(function(r) { try { return JSON.parse(r[1]); } catch(ex) { return null; } })
    .filter(Boolean);

  return { revision: revision, songs: songs, spellingChart: spellingChart, sharedSetlists: sharedSetlists };
}

// ---------------------------------------------------------------------------
//  Write -- replaces all sheet data atomically (must be called inside withLock_)
// ---------------------------------------------------------------------------

function write_(data) {
  ensureSheets_();
  var ss = SpreadsheetApp.getActive();

  // Revision + timestamp
  var metaSheet = ss.getSheetByName(META_SHEET);
  metaSheet.getRange(2, 1, 1, 2).setValues([[data.revision, Date.now()]]);

  // Songs
  var songsSheet = ss.getSheetByName(SONGS_SHEET);
  clearDataRows_(songsSheet);
  if (data.songs && data.songs.length > 0) {
    var songData = data.songs.map(function(s) { return [s.id || '', JSON.stringify(s)]; });
    songsSheet.getRange(2, 1, songData.length, 2).setValues(songData);
  }

  // Spelling chart
  var chartSheet = ss.getSheetByName(CHART_SHEET);
  clearDataRows_(chartSheet);
  var chartKeys = Object.keys(data.spellingChart || {});
  if (chartKeys.length > 0) {
    var chartData = chartKeys.map(function(k) { return [k, data.spellingChart[k]]; });
    chartSheet.getRange(2, 1, chartData.length, 2).setValues(chartData);
  }

  // Shared setlists
  var slSheet = ss.getSheetByName(SETLISTS_SHEET);
  clearDataRows_(slSheet);
  if (data.sharedSetlists && data.sharedSetlists.length > 0) {
    var slData = data.sharedSetlists.map(function(sl) { return [sl.id || '', JSON.stringify(sl)]; });
    slSheet.getRange(2, 1, slData.length, 2).setValues(slData);
  }
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function clearDataRows_(sheet) {
  var last = sheet.getLastRow();
  if (last > 1) sheet.deleteRows(2, last - 1);
}

function ensureSheets_() {
  var ss = SpreadsheetApp.getActive();
  var defs = [
    { name: META_SHEET,     headers: ['revision', 'lastUpdatedMs'], defaultRow: [0, ''], hidden: true  },
    { name: SONGS_SHEET,    headers: ['id', 'json'],                 defaultRow: null,   hidden: false },
    { name: CHART_SHEET,    headers: ['tamil', 'tanglish'],          defaultRow: null,   hidden: false },
    { name: SETLISTS_SHEET, headers: ['id', 'json'],                 defaultRow: null,   hidden: false }
  ];
  defs.forEach(function(def) {
    var sheet = ss.getSheetByName(def.name);
    if (!sheet) {
      sheet = ss.insertSheet(def.name);
      sheet.appendRow(def.headers);
      if (def.defaultRow) sheet.appendRow(def.defaultRow);
      if (def.hidden) sheet.hideSheet();
    }
  });
}

// ---------------------------------------------------------------------------
//  One-time migration helper — run from the Apps Script editor if you have
//  existing data in the old single-cell "ZongState" sheet.
//  Open Apps Script editor, select migrateFromV1 in the function picker, Run.
// ---------------------------------------------------------------------------

function migrateFromV1() {
  var ss    = SpreadsheetApp.getActive();
  var oldSh = ss.getSheetByName('ZongState');
  if (!oldSh) { Logger.log('No ZongState sheet found — nothing to migrate.'); return; }
  var row      = oldSh.getRange(2, 1, 1, 2).getValues()[0];
  var revision = Number(row[0] || 0);
  var parsed   = row[1] ? JSON.parse(row[1]) : {};
  ensureSheets_();
  write_({
    revision:       revision,
    songs:          parsed.songs          || [],
    spellingChart:  parsed.spellingChart  || {},
    sharedSetlists: parsed.sharedSetlists || []
  });
  Logger.log('Migration complete. Revision ' + revision + ', ' + (parsed.songs || []).length + ' songs.');
}

function reply_(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

