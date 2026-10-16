/**
 * Постоянные JXA-скрипты для osascript -l JavaScript.
 * Данные в текст скриптов не подставляются: всё приходит через argv функции run.
 * argv[0] у всех скриптов с аргументами — id разрешённой папки.
 */

const PRELUDE = `
ObjC.import('Foundation');
var app = Application('Notes');
function fail(code) { throw new Error('APN:' + code); }
function readFile(p) {
  var s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null);
  if (s.isNil()) fail('IO');
  return ObjC.unwrap(s);
}
// HTML file URLs carry no sandbox extension. Deliver ONLY the verified snapshot
// paths supplied internally by consume/verify, never paths parsed from HTML.
// Notes cannot resolve a file as its scripting object (-1728), but receiving the
// native file descriptor grants access for the following HTML import (macOS 26.5).
function handoffImages(json) {
  var paths = JSON.parse(json);
  for (var i = 0; i < paths.length; i++) {
    try { app.exists(Path(paths[i])); }
    catch (e) { if (e.errorNumber !== -1728) throw e; }
  }
}
function folderById(id) {
  var f = app.folders.byId(id);
  try { f.id(); } catch (e) { fail('FOLDER_GONE'); }
  return f;
}
function guardNote(folderId, noteId) {
  var n = app.notes.byId(noteId), cid;
  try { cid = n.container().id(); } catch (e) { fail('NOT_FOUND'); }
  if (cid !== folderId) fail('OUTSIDE');
  if (n.passwordProtected()) fail('LOCKED');
  return n;
}
// Вложения заметки. Только что записанную картинку Заметки могут ещё не показать в attachments,
// поэтому скрипты записи дополнительно отказывают по её следу в теле (<img> или символ вложения U+FFFC).
function attachmentCount(n) {
  // Свежее вложение Заметки иногда отдают в списке дважды — считаем по id без повторов.
  var ids = n.attachments.id(), seen = {}, k = 0;
  for (var i = 0; i < ids.length; i++) if (!seen[ids[i]]) { seen[ids[i]] = true; k++; }
  return k;
}
function summaries(notes) {
  var ids = notes.id(), names = notes.name(), dates = notes.modificationDate(), out = [];
  for (var i = 0; i < ids.length; i++) out.push({ id: ids[i], name: names[i], modified: dates[i].toISOString() });
  return JSON.stringify(out);
}
`;

export const GUARD_CALL = 'guardNote(argv[0], argv[1])';

const listFolders =
  PRELUDE +
  `
function run() {
  var out = [];
  function walk(folders, account) {
    for (var i = 0; i < folders.length; i++) {
      out.push({ id: folders[i].id(), name: folders[i].name(), account: account });
      walk(folders[i].folders(), account);
    }
  }
  var accounts = app.accounts();
  for (var i = 0; i < accounts.length; i++) walk(accounts[i].folders(), accounts[i].name());
  return JSON.stringify(out);
}`;

const listNotes =
  PRELUDE +
  `
function run(argv) {
  var f = folderById(argv[0]);
  return summaries(f.notes);
}`;

// Поиск без встроенного фильтра Заметок: тот тратит ~150 мс на каждое совпадение и на ~1200 заметках не
// укладывается в таймаут. Поля всех заметок папки берутся пакетно, сравнение — здесь, без учёта регистра.
const searchNotes =
  PRELUDE +
  `
function run(argv) {
  var f = folderById(argv[0]), q = argv[1].toLowerCase();
  var ids = f.notes.id(), names = f.notes.name(), texts = f.notes.plaintext(), dates = f.notes.modificationDate(), out = [];
  for (var i = 0; i < ids.length; i++) {
    if ((names[i] + '\\n' + (texts[i] || '')).toLowerCase().indexOf(q) !== -1)
      out.push({ id: ids[i], name: names[i], modified: dates[i].toISOString() });
  }
  return JSON.stringify(out);
}`;

const readNote =
  PRELUDE +
  `
function run(argv) {
  var n = ${GUARD_CALL};
  return JSON.stringify({ id: n.id(), name: n.name(), modified: n.modificationDate().toISOString(), body: n.body(), attachments: attachmentCount(n) });
}`;

const createNote =
  PRELUDE +
  `
function run(argv) {
  var f = folderById(argv[0]);
  handoffImages(argv[2]);
  var n = app.Note({ body: readFile(argv[1]) });
  f.notes.push(n);
  return JSON.stringify({ id: n.id() });
}`;

const appendNote =
  PRELUDE +
  `
function run(argv) {
  var n = ${GUARD_CALL};
  var b = n.body();
  var k = attachmentCount(n);
  if (k > 0 || /<img\\b/i.test(b) || b.indexOf('\\uFFFC') !== -1) fail('ATTACHMENTS:' + Math.max(k, 1));
  if (/<(ul|ol)\\b/i.test(b)) fail('LISTS');
  handoffImages(argv[3]);
  n.body = b + readFile(argv[2]);
  return JSON.stringify({ id: n.id() });
}`;

const updateNote =
  PRELUDE +
  `
function run(argv) {
  var n = ${GUARD_CALL};
  var b = n.body();
  var k = attachmentCount(n);
  if (k > 0 || /<img\\b/i.test(b) || b.indexOf('\\uFFFC') !== -1) fail('ATTACHMENTS:' + Math.max(k, 1));
  if (/<(ul|ol)\\b/i.test(b)) fail('LISTS');
  handoffImages(argv[3]);
  n.body = readFile(argv[2]);
  return JSON.stringify({ id: n.id() });
}`;

const deleteNote =
  PRELUDE +
  `
function run(argv) {
  var n = ${GUARD_CALL};
  app.delete(n);
  return JSON.stringify({ ok: true });
}`;

export const SCRIPTS = Object.freeze({
  listFolders,
  listNotes,
  searchNotes,
  readNote,
  createNote,
  appendNote,
  updateNote,
  deleteNote,
});

export const ID_SCRIPTS: readonly string[] = Object.freeze([readNote, appendNote, updateNote, deleteNote]);
