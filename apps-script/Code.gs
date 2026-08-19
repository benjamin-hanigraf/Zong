/* Zong Google Sheets sync endpoint.
 * 1. Create a Google Sheet. Extensions > Apps Script; paste this file.
 * 2. Project Settings > Script Properties: set ZONG_ACCESS_KEY to your band/team code.
 * 3. Deploy > New deployment > Web app. Execute as: Me. Access: Anyone.
 * 4. Put the resulting /exec URL in VITE_ZONG_SYNC_URL before building/deploying Zong.
 */
const STATE_SHEET = 'ZongState';

function doGet() {
  return reply_({ ok: true, service: 'Zong sync' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const expected = PropertiesService.getScriptProperties().getProperty('ZONG_ACCESS_KEY');
    const state = read_();

    // 1. Public Sync (No team key required — gives access to Songs & Spelling Chart)
    if (body.action === 'public_pull') {
      return reply_({
        ok: true,
        revision: state.revision,
        state: {
          songs: state.state.songs || [],
          spellingChart: state.state.spellingChart || {}
        }
      });
    }

    if (body.action === 'public_push') {
      if (Number(body.baseRevision) !== state.revision) {
        return reply_({
          ok: true,
          conflict: true,
          revision: state.revision,
          state: {
            songs: state.state.songs || [],
            spellingChart: state.state.spellingChart || {}
          }
        });
      }
      const nextSongs = body.state?.songs ?? (state.state.songs || []);
      const nextSpelling = body.state?.spellingChart ?? (state.state.spellingChart || {});
      const nextState = {
        songs: nextSongs,
        spellingChart: nextSpelling,
        sharedSetlists: state.state.sharedSetlists || []
      };
      const next = { revision: state.revision + 1, state: nextState };
      write_(next);
      return reply_({
        ok: true,
        revision: next.revision,
        state: { songs: nextState.songs, spellingChart: nextState.spellingChart }
      });
    }

    // 2. Team Sync (Requires ZONG_ACCESS_KEY — syncs Songs, Spelling Chart, and Shared Setlists)
    if (!expected || body.key !== expected) {
      return reply_({ ok: false, error: 'Invalid team access code.' });
    }

    if (body.action === 'pull' || body.action === 'team_pull') {
      return reply_({
        ok: true,
        revision: state.revision,
        state: {
          songs: state.state.songs || [],
          spellingChart: state.state.spellingChart || {},
          sharedSetlists: state.state.sharedSetlists || []
        }
      });
    }

    if (body.action === 'push' || body.action === 'team_push') {
      if (Number(body.baseRevision) !== state.revision) {
        return reply_({
          ok: true,
          conflict: true,
          revision: state.revision,
          state: {
            songs: state.state.songs || [],
            spellingChart: state.state.spellingChart || {},
            sharedSetlists: state.state.sharedSetlists || []
          }
        });
      }
      const nextSongs = body.state?.songs ?? (state.state.songs || []);
      const nextSpelling = body.state?.spellingChart ?? (state.state.spellingChart || {});
      const nextSharedSetlists = body.state?.sharedSetlists ?? (state.state.sharedSetlists || []);
      const nextState = {
        songs: nextSongs,
        spellingChart: nextSpelling,
        sharedSetlists: nextSharedSetlists
      };
      const next = { revision: state.revision + 1, state: nextState };
      write_(next);
      return reply_({
        ok: true,
        revision: next.revision,
        state: nextState
      });
    }

    return reply_({ ok: false, error: 'Unknown request.' });
  } catch (err) {
    return reply_({ ok: false, error: String(err.message || err) });
  }
}

function read_() {
  const sheet = sheet_();
  const row = sheet.getRange(2, 1, 1, 2).getValues()[0];
  const parsed = row[1] ? JSON.parse(row[1]) : {};
  // Normalize backwards compatibility if state was previously { songs: [], setlists: [] }
  const songs = parsed.songs || [];
  const spellingChart = parsed.spellingChart || {};
  const sharedSetlists = parsed.sharedSetlists || (parsed.setlists ? parsed.setlists.filter(s => s.shared) : []);
  return {
    revision: Number(row[0] || 0),
    state: { songs, spellingChart, sharedSetlists }
  };
}

function write_(value) {
  const sheet = sheet_();
  sheet.getRange(2, 1, 1, 2).setValues([[value.revision, JSON.stringify(value.state)]]);
}

function sheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(STATE_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(STATE_SHEET);
    sheet.appendRow(['revision', 'state']);
    sheet.appendRow([0, '']);
    sheet.hideSheet();
  }
  return sheet;
}

function reply_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
