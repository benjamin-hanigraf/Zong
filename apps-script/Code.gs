/* Zong Google Sheets sync endpoint.
 * 1. Create a Google Sheet. Extensions > Apps Script; paste this file.
 * 2. Project Settings > Script Properties: set ZONG_ACCESS_KEY to your band code.
 * 3. Deploy > New deployment > Web app. Execute as: Me. Access: Anyone.
 * 4. Put the resulting /exec URL in VITE_ZONG_SYNC_URL before building/deploying Zong.
 */
const STATE_SHEET = 'ZongState';
function doGet() { return reply_({ ok: true, service: 'Zong sync' }); }
function doPost(e) { try { const body = JSON.parse(e.postData.contents || '{}'); const expected = PropertiesService.getScriptProperties().getProperty('ZONG_ACCESS_KEY'); if (!expected || body.key !== expected) return reply_({ ok:false, error:'Invalid access code.' }); const state = read_(); if (body.action === 'pull') return reply_({ok:true, ...state}); if (body.action !== 'push') return reply_({ok:false,error:'Unknown request.'}); if (Number(body.baseRevision) !== state.revision) return reply_({ok:true,conflict:true,...state}); const next={revision:state.revision+1,state:body.state||{songs:[],setlists:[]}}; write_(next); return reply_({ok:true,...next}); } catch(err) { return reply_({ok:false,error:String(err.message || err)}); } }
function read_() { const sheet = sheet_(); const row=sheet.getRange(2,1,1,2).getValues()[0]; return {revision:Number(row[0]||0),state:row[1]?JSON.parse(row[1]):{songs:[],setlists:[]}}; }
function write_(value) { const sheet=sheet_(); sheet.getRange(2,1,1,2).setValues([[value.revision,JSON.stringify(value.state)]]); }
function sheet_() { const ss=SpreadsheetApp.getActive(); let sheet=ss.getSheetByName(STATE_SHEET); if(!sheet){sheet=ss.insertSheet(STATE_SHEET);sheet.appendRow(['revision','state']);sheet.appendRow([0,'']);sheet.hideSheet();} return sheet; }
function reply_(data) { return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON); }
