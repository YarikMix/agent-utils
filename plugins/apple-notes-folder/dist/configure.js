import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// src/configure-cli.ts
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// src/errors.ts
var ToolError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ToolError";
  }
  code;
};
var CONFIGURE_HINT = "/plugin configure apple-notes-folder@yarikmix-plugins";
var CODEX_CONFIGURE_HINT = "$apple-notes-folder:setup";
var MESSAGES = {
  IMAGE_RUNTIME_LOCK: "\u0425\u0440\u0430\u043D\u0438\u043B\u0438\u0449\u0435 \u043A\u0430\u0440\u0442\u0438\u043D\u043E\u043A \u0437\u0430\u043D\u044F\u0442\u043E \u0438\u043B\u0438 \u0435\u0433\u043E lock \u0442\u0440\u0435\u0431\u0443\u0435\u0442 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438. \u0415\u0441\u043B\u0438 \u043E\u0442\u043A\u0430\u0437 \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u0435\u0442\u0441\u044F \u043F\u043E\u0441\u043B\u0435 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u044F \u0437\u0430\u043F\u0438\u0441\u0438, \u0441\u043B\u0435\u0434\u0443\u0439\u0442\u0435 \u0440\u0430\u0437\u0434\u0435\u043B\u0443 \u0432\u043E\u0441\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u044F lock \u0432 README \u043F\u043B\u0430\u0433\u0438\u043D\u0430. \u0422\u0435\u043A\u0441\u0442\u043E\u0432\u044B\u0435 \u043E\u043F\u0435\u0440\u0430\u0446\u0438\u0438 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B.",
  OUTSIDE: "\u0417\u0430\u043C\u0435\u0442\u043A\u0430 \u0432\u043D\u0435 \u0440\u0430\u0437\u0440\u0435\u0448\u0451\u043D\u043D\u043E\u0439 \u043F\u0430\u043F\u043A\u0438.",
  NOT_FOUND: "\u0417\u0430\u043C\u0435\u0442\u043A\u0430 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430: \u043D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 id \u0438\u043B\u0438 \u0437\u0430\u043C\u0435\u0442\u043A\u0430 \u0443\u0434\u0430\u043B\u0435\u043D\u0430.",
  LOCKED: "\u0417\u0430\u043C\u0435\u0442\u043A\u0430 \u0437\u0430\u0449\u0438\u0449\u0435\u043D\u0430 \u043F\u0430\u0440\u043E\u043B\u0435\u043C \u2014 \u0441\u0435\u0440\u0432\u0435\u0440 \u0435\u0451 \u043D\u0435 \u0447\u0438\u0442\u0430\u0435\u0442 \u0438 \u043D\u0435 \u043C\u0435\u043D\u044F\u0435\u0442.",
  PERMISSION: "\u041D\u0435\u0442 \u0440\u0430\u0437\u0440\u0435\u0448\u0435\u043D\u0438\u044F \u043D\u0430 \u0443\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0435 \u0417\u0430\u043C\u0435\u0442\u043A\u0430\u043C\u0438. \u0412\u044B\u0434\u0430\u0439\u0442\u0435 \u0435\u0433\u043E: \u0421\u0438\u0441\u0442\u0435\u043C\u043D\u044B\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u2192 \u041A\u043E\u043D\u0444\u0438\u0434\u0435\u043D\u0446\u0438\u0430\u043B\u044C\u043D\u043E\u0441\u0442\u044C \u0438 \u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u044C \u2192 \u0410\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0437\u0430\u0446\u0438\u044F \u2192 \u0432\u0430\u0448 \u0442\u0435\u0440\u043C\u0438\u043D\u0430\u043B \u2192 \u0417\u0430\u043C\u0435\u0442\u043A\u0438.",
  TIMEOUT: "\u0417\u0430\u043C\u0435\u0442\u043A\u0438 \u043D\u0435 \u043E\u0442\u0432\u0435\u0442\u0438\u043B\u0438 \u0437\u0430 30 \u0441\u0435\u043A\u0443\u043D\u0434.",
  TIMEOUT_WRITE: "\u0417\u0430\u043C\u0435\u0442\u043A\u0438 \u043D\u0435 \u043E\u0442\u0432\u0435\u0442\u0438\u043B\u0438 \u0437\u0430 30 \u0441\u0435\u043A\u0443\u043D\u0434. \u0418\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0435 \u043C\u043E\u0433\u043B\u043E \u043F\u0440\u0438\u043C\u0435\u043D\u0438\u0442\u044C\u0441\u044F \u2014 \u043F\u0435\u0440\u0435\u0447\u0438\u0442\u0430\u0439\u0442\u0435 \u0437\u0430\u043C\u0435\u0442\u043A\u0443 \u043F\u0435\u0440\u0435\u0434 \u043F\u043E\u0432\u0442\u043E\u0440\u043E\u043C.",
  FOLDER_GONE: `\u0420\u0430\u0437\u0440\u0435\u0448\u0451\u043D\u043D\u0430\u044F \u043F\u0430\u043F\u043A\u0430 \u0431\u043E\u043B\u044C\u0448\u0435 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430 \u0432 \u0417\u0430\u043C\u0435\u0442\u043A\u0430\u0445. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0435\u0451 \u0438\u043C\u044F (${CONFIGURE_HINT}) \u0438 \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 \u0441\u0435\u0441\u0441\u0438\u044E.`,
  IO: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0442\u044C \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u044B\u0439 \u0444\u0430\u0439\u043B \u0441 \u0442\u0435\u043A\u0441\u0442\u043E\u043C \u0437\u0430\u043C\u0435\u0442\u043A\u0438.",
  TRUNCATED: "\u0417\u0430\u043C\u0435\u0442\u043A\u0430 \u0431\u044B\u043B\u0430 \u043E\u0431\u0440\u0435\u0437\u0430\u043D\u0430 \u043F\u0440\u0438 \u0447\u0442\u0435\u043D\u0438\u0438, \u0435\u0451 \u043F\u043E\u043B\u043D\u044B\u0439 \u0442\u0435\u043A\u0441\u0442 \u0430\u0433\u0435\u043D\u0442\u0443 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D. \u0417\u0430\u043C\u0435\u043D\u0430 \u0446\u0435\u043B\u0438\u043A\u043E\u043C \u0443\u0434\u0430\u043B\u0438\u043B\u0430 \u0431\u044B \u0445\u0432\u043E\u0441\u0442 \u2014 \u0434\u043B\u044F \u0442\u0430\u043A\u043E\u0439 \u0437\u0430\u043C\u0435\u0442\u043A\u0438 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 notes_append.",
  LISTS: "\u0412 \u0437\u0430\u043C\u0435\u0442\u043A\u0435 \u0435\u0441\u0442\u044C \u0441\u043F\u0438\u0441\u043A\u0438. \u0417\u0430\u043C\u0435\u0442\u043A\u0438 \u043D\u0435 \u0441\u043E\u043E\u0431\u0449\u0430\u044E\u0442 \u0441\u043A\u0440\u0438\u043F\u0442\u0430\u043C, \u043A\u0430\u043A\u0438\u0435 \u0438\u0437 \u043D\u0438\u0445 \u2014 \u0447\u0435\u043A-\u043B\u0438\u0441\u0442\u044B, \u0430 \u043F\u0440\u0438 \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0438 \u0442\u0435\u043A\u0441\u0442\u0430 \u0447\u0435\u043A-\u043B\u0438\u0441\u0442\u044B \u0438 \u0438\u0445 \u043E\u0442\u043C\u0435\u0442\u043A\u0438 \u043F\u0440\u0435\u0432\u0440\u0430\u0449\u0430\u044E\u0442\u0441\u044F \u0432 \u043E\u0431\u044B\u0447\u043D\u044B\u0439 \u0442\u0435\u043A\u0441\u0442. \u041F\u043E\u044D\u0442\u043E\u043C\u0443 \u0441\u0435\u0440\u0432\u0435\u0440 \u0442\u0435\u043A\u0441\u0442 \u044D\u0442\u043E\u0439 \u0437\u0430\u043C\u0435\u0442\u043A\u0438 \u043D\u0435 \u043C\u0435\u043D\u044F\u0435\u0442; \u043D\u043E\u0432\u044B\u0439 \u0442\u0435\u043A\u0441\u0442 \u043C\u043E\u0436\u043D\u043E \u0437\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u0432 \u043D\u043E\u0432\u0443\u044E \u0437\u0430\u043C\u0435\u0442\u043A\u0443."
};
function attachmentsMessage(n) {
  return `\u0423 \u0437\u0430\u043C\u0435\u0442\u043A\u0438 \u0435\u0441\u0442\u044C \u0432\u043B\u043E\u0436\u0435\u043D\u0438\u044F (${n}). \u0417\u0430\u043C\u0435\u0442\u043A\u0438 \u043F\u043E\u0440\u0442\u044F\u0442 \u0432\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u043F\u0440\u0438 \u043B\u044E\u0431\u043E\u043C \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0438 \u0442\u0435\u043A\u0441\u0442\u0430, \u043F\u043E\u044D\u0442\u043E\u043C\u0443 \u0441\u0435\u0440\u0432\u0435\u0440 \u0442\u0435\u043A\u0441\u0442 \u044D\u0442\u043E\u0439 \u0437\u0430\u043C\u0435\u0442\u043A\u0438 \u043D\u0435 \u043C\u0435\u043D\u044F\u0435\u0442. \u041A\u0430\u0440\u0442\u0438\u043D\u043A\u0438 \u0438 \u043D\u043E\u0432\u044B\u0439 \u0442\u0435\u043A\u0441\u0442 \u043C\u043E\u0436\u043D\u043E \u0437\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u0432 \u043D\u043E\u0432\u0443\u044E \u0437\u0430\u043C\u0435\u0442\u043A\u0443.`;
}

// src/hosts/config.ts
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join as join2 } from "node:path";

// src/scripts.ts
var PRELUDE = `
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
// \u0412\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u0437\u0430\u043C\u0435\u0442\u043A\u0438. \u0422\u043E\u043B\u044C\u043A\u043E \u0447\u0442\u043E \u0437\u0430\u043F\u0438\u0441\u0430\u043D\u043D\u0443\u044E \u043A\u0430\u0440\u0442\u0438\u043D\u043A\u0443 \u0417\u0430\u043C\u0435\u0442\u043A\u0438 \u043C\u043E\u0433\u0443\u0442 \u0435\u0449\u0451 \u043D\u0435 \u043F\u043E\u043A\u0430\u0437\u0430\u0442\u044C \u0432 attachments,
// \u043F\u043E\u044D\u0442\u043E\u043C\u0443 \u0441\u043A\u0440\u0438\u043F\u0442\u044B \u0437\u0430\u043F\u0438\u0441\u0438 \u0434\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C\u043D\u043E \u043E\u0442\u043A\u0430\u0437\u044B\u0432\u0430\u044E\u0442 \u043F\u043E \u0435\u0451 \u0441\u043B\u0435\u0434\u0443 \u0432 \u0442\u0435\u043B\u0435 (<img> \u0438\u043B\u0438 \u0441\u0438\u043C\u0432\u043E\u043B \u0432\u043B\u043E\u0436\u0435\u043D\u0438\u044F U+FFFC).
function attachmentCount(n) {
  // \u0421\u0432\u0435\u0436\u0435\u0435 \u0432\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u0417\u0430\u043C\u0435\u0442\u043A\u0438 \u0438\u043D\u043E\u0433\u0434\u0430 \u043E\u0442\u0434\u0430\u044E\u0442 \u0432 \u0441\u043F\u0438\u0441\u043A\u0435 \u0434\u0432\u0430\u0436\u0434\u044B \u2014 \u0441\u0447\u0438\u0442\u0430\u0435\u043C \u043F\u043E id \u0431\u0435\u0437 \u043F\u043E\u0432\u0442\u043E\u0440\u043E\u0432.
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
var GUARD_CALL = "guardNote(argv[0], argv[1])";
var listFolders = PRELUDE + `
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
var listNotes = PRELUDE + `
function run(argv) {
  var f = folderById(argv[0]);
  return summaries(f.notes);
}`;
var searchNotes = PRELUDE + `
function run(argv) {
  var f = folderById(argv[0]), q = argv[1].toLowerCase();
  var ids = f.notes.id(), names = f.notes.name(), texts = f.notes.plaintext(), dates = f.notes.modificationDate(), out = [];
  for (var i = 0; i < ids.length; i++) {
    if ((names[i] + '\\n' + (texts[i] || '')).toLowerCase().indexOf(q) !== -1)
      out.push({ id: ids[i], name: names[i], modified: dates[i].toISOString() });
  }
  return JSON.stringify(out);
}`;
var readNote = PRELUDE + `
function run(argv) {
  var n = ${GUARD_CALL};
  return JSON.stringify({ id: n.id(), name: n.name(), modified: n.modificationDate().toISOString(), body: n.body(), attachments: attachmentCount(n) });
}`;
var createNote = PRELUDE + `
function run(argv) {
  var f = folderById(argv[0]);
  handoffImages(argv[2]);
  var n = app.Note({ body: readFile(argv[1]) });
  f.notes.push(n);
  return JSON.stringify({ id: n.id() });
}`;
var appendNote = PRELUDE + `
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
var updateNote = PRELUDE + `
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
var deleteNote = PRELUDE + `
function run(argv) {
  var n = ${GUARD_CALL};
  app.delete(n);
  return JSON.stringify({ ok: true });
}`;
var SCRIPTS = Object.freeze({
  listFolders,
  listNotes,
  searchNotes,
  readNote,
  createNote,
  appendNote,
  updateNote,
  deleteNote
});
var ID_SCRIPTS = Object.freeze([readNote, appendNote, updateNote, deleteNote]);

// src/scope.ts
var RECENTLY_DELETED_NAMES = /* @__PURE__ */ new Set(["recently deleted", "\u043D\u0435\u0434\u0430\u0432\u043D\u043E \u0443\u0434\u0430\u043B\u0451\u043D\u043D\u044B\u0435", "\u043D\u0435\u0434\u0430\u0432\u043D\u043E \u0443\u0434\u0430\u043B\u0435\u043D\u043D\u044B\u0435"]);
async function resolveScope(name, run, hint = CONFIGURE_HINT) {
  if (!name) throw new ToolError("CONFIG", `\u041D\u0435 \u0437\u0430\u0434\u0430\u043D\u0430 \u043F\u0430\u043F\u043A\u0430 \u0417\u0430\u043C\u0435\u0442\u043E\u043A. \u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u0435\u0451: ${hint}.`);
  if (RECENTLY_DELETED_NAMES.has(name.trim().toLowerCase())) {
    throw new ToolError("CONFIG", `\u041F\u0430\u043F\u043A\u0443 \xAB${name}\xBB \u043D\u0435\u043B\u044C\u0437\u044F \u0432\u044B\u0431\u0440\u0430\u0442\u044C: \u0432 \u043D\u0435\u0439 \u043B\u0435\u0436\u0430\u0442 \u0443\u0434\u0430\u043B\u0451\u043D\u043D\u044B\u0435 \u0437\u0430\u043C\u0435\u0442\u043A\u0438 \u0438\u0437 \u0432\u0441\u0435\u0445 \u043F\u0430\u043F\u043E\u043A.`);
  }
  const byId = /* @__PURE__ */ new Map();
  for (const f of JSON.parse(await run(SCRIPTS.listFolders, [], { write: false }))) byId.set(f.id, f);
  const matches = [...byId.values()].filter((f) => f.name === name);
  if (matches.length === 0) {
    throw new ToolError(
      "CONFIG",
      `\u041F\u0430\u043F\u043A\u0430 \xAB${name}\xBB \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430 \u0432 \u0417\u0430\u043C\u0435\u0442\u043A\u0430\u0445. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0438\u043C\u044F: ${hint}. \u041F\u0430\u043F\u043A\u0430 \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E \u0432 \u0441\u043A\u0440\u0438\u043F\u0442\u0430\u0445 \u043C\u043E\u0436\u0435\u0442 \u043D\u0430\u0437\u044B\u0432\u0430\u0442\u044C\u0441\u044F \u0438\u043D\u0430\u0447\u0435, \u0447\u0435\u043C \u0432 \u0438\u043D\u0442\u0435\u0440\u0444\u0435\u0439\u0441\u0435: \u0432 \u0440\u0443\u0441\u0441\u043A\u043E\u043C \u0438\u043D\u0442\u0435\u0440\u0444\u0435\u0439\u0441\u0435 \xAB\u0417\u0430\u043C\u0435\u0442\u043A\u0438\xBB, \u0432 \u0441\u043A\u0440\u0438\u043F\u0442\u0430\u0445 \xABNotes\xBB.`
    );
  }
  if (matches.length > 1) {
    const accounts = [...new Set(matches.map((m) => m.account))].join(", ");
    throw new ToolError(
      "CONFIG",
      `\u041F\u0430\u043F\u043E\u043A \u0441 \u0438\u043C\u0435\u043D\u0435\u043C \xAB${name}\xBB \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E (${matches.length}; \u0430\u043A\u043A\u0430\u0443\u043D\u0442\u044B: ${accounts}). \u041F\u0435\u0440\u0435\u0438\u043C\u0435\u043D\u0443\u0439\u0442\u0435 \u043B\u0438\u0448\u043D\u0438\u0435 \u0438\u043B\u0438 \u0443\u043A\u0430\u0436\u0438\u0442\u0435 \u0434\u0440\u0443\u0433\u0443\u044E \u043F\u0430\u043F\u043A\u0443: ${hint}.`
    );
  }
  return { folderId: matches[0].id, folderName: name };
}

// src/hosts/paths.ts
import { join } from "node:path";
function hostPaths(host, env, home) {
  const root = host === "codex" ? env.CODEX_HOME || join(home, ".codex") : env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const pluginDir = join(root, "agent-utils", "apple-notes-folder");
  return {
    configFile: host === "codex" ? join(pluginDir, "config.json") : null,
    runtimeDir: join(pluginDir, "runtime")
  };
}
function configurationHint(host) {
  return host === "codex" ? CODEX_CONFIGURE_HINT : CONFIGURE_HINT;
}

// src/hosts/config.ts
async function configureCodex(folder, env, home, run) {
  const scope = await resolveScope(folder.trim() || null, run, configurationHint("codex"));
  const { configFile } = hostPaths("codex", env, home);
  const configDir = dirname(configFile);
  await mkdir(configDir, { recursive: true, mode: 448 });
  await chmod(dirname(configDir), 448);
  await chmod(configDir, 448);
  const temporary = join2(configDir, `.config-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, folder: scope.folderName })}
`, { flag: "wx", mode: 384 });
    await rename(temporary, configFile);
  } finally {
    await rm(temporary, { force: true });
  }
  return scope;
}

// src/runner.ts
import { execFile } from "node:child_process";
var OSA_TIMEOUT_MS = 3e4;
var MAX_BUFFER = 64 * 1024 * 1024;
function mapOsaFailure(err, stderr, write, hint = CONFIGURE_HINT) {
  const timeout = () => new ToolError(write ? "TIMEOUT_WRITE" : "TIMEOUT", write ? MESSAGES.TIMEOUT_WRITE : MESSAGES.TIMEOUT);
  if (err.killed || err.signal === "SIGTERM") return timeout();
  const apn = /APN:([A-Z_]+)(?::(\d+))?/.exec(stderr);
  const code = apn?.[1];
  switch (code) {
    case "ATTACHMENTS":
      return new ToolError("ATTACHMENTS", attachmentsMessage(Number(apn?.[2] ?? 0)));
    case "LISTS":
      return new ToolError("LISTS", MESSAGES.LISTS);
    case "OUTSIDE":
      return new ToolError("OUTSIDE", MESSAGES.OUTSIDE);
    case "NOT_FOUND":
      return new ToolError("NOT_FOUND", MESSAGES.NOT_FOUND);
    case "LOCKED":
      return new ToolError("LOCKED", MESSAGES.LOCKED);
    case "FOLDER_GONE":
      return new ToolError("CONFIG", MESSAGES.FOLDER_GONE.replace(CONFIGURE_HINT, hint));
    case "IO":
      return new ToolError("OSA", MESSAGES.IO);
  }
  if (/-1743|not authori[sz]ed/i.test(stderr)) return new ToolError("PERMISSION", MESSAGES.PERMISSION);
  if (/-1712/.test(stderr)) return timeout();
  return new ToolError("OSA", `\u041E\u0448\u0438\u0431\u043A\u0430 \u0417\u0430\u043C\u0435\u0442\u043E\u043A: ${stderr.trim().slice(0, 500)}`);
}
function makeOsascriptRunner(exec = execFile, hint = CONFIGURE_HINT) {
  return (script, args, { write }) => new Promise((resolve2, reject) => {
    exec(
      "osascript",
      ["-l", "JavaScript", "-e", script, ...args],
      { timeout: OSA_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) reject(mapOsaFailure(err, String(stderr ?? ""), write, hint));
        else resolve2(String(stdout).trim());
      }
    );
  });
}

// src/configure-cli.ts
async function runConfigureCli(argv, env, home, run) {
  if (argv.length !== 2 || argv[0] !== "--folder" || !argv[1].trim() || argv[1].startsWith("--")) {
    throw new ToolError("CONFIG", "\u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u043F\u0430\u043F\u043A\u0443: --folder <\u0438\u043C\u044F>.");
  }
  await configureCodex(argv[1], env, home, run);
  return "\u041F\u0430\u043F\u043A\u0430 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D\u0430. \u041F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 MCP-\u0441\u0435\u0440\u0432\u0435\u0440 Apple Notes.";
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  runConfigureCli(process.argv.slice(2), process.env, homedir(), makeOsascriptRunner()).then(
    (status) => {
      console.log(status);
    },
    (error) => {
      console.error(error instanceof ToolError ? error.message : "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043D\u0430\u0441\u0442\u0440\u043E\u0438\u0442\u044C \u043F\u0430\u043F\u043A\u0443 Apple Notes.");
      process.exitCode = 1;
    }
  );
}
export {
  runConfigureCli
};
