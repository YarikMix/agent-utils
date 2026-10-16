/**
 * Server-only проверка: npm run live-check -- --client claude|codex.
 * Синтетический issueTicket проверяет общий сервер, а не происхождение вложения в клиенте.
 * Создаёт тестовые папки в аккаунте по умолчанию, гоняет dist/server.js через MCP-клиент и удаляет папки.
 * Реальные папки не меняет. LIVE_BIG_FOLDER (необязательно) — имя большой папки для замера времени, только чтение;
 * LIVE_BIG_QUERY — запрос для замера поиска (по умолчанию «а»).
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import { buildOptions } from './build-options.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const jxa = async (script, ...args) =>
  (await exec('osascript', ['-l', 'JavaScript', '-e', script, ...args], { timeout: 60_000, maxBuffer: 64 << 20 })).stdout.trim();

const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== '--client' || !['claude', 'codex'].includes(argv[1])) {
  console.error('Usage: npm run live-check -- --client claude|codex');
  process.exit(2);
}
const HOST = argv[1];
const ROOT = await realpath(await mkdtemp(join(tmpdir(), `apple-notes-live-${HOST}-`)));
await chmod(ROOT, 0o700);
const SUFFIX = Date.now().toString(36);
const ALLOWED = `anf-live-allowed-${SUFFIX}`;
const FOREIGN = `anf-live-foreign-${SUFFIX}`;
const SUB = `anf-live-sub-${SUFFIX}`;
const SECRET = `anfsecret${SUFFIX}`;
const SERVER = fileURLToPath(new URL('../dist/server.js', import.meta.url));
const IMG_DIR = join(ROOT, 'images');
const HELPER = join(ROOT, 'tickets.mjs');
let issueTicket;
const contexts = new WeakMap();
// Настоящий PNG 1×1.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const SETUP = `function run(argv) {
  var app = Application('Notes'), acc = app.defaultAccount();
  function mk(parent, name) { parent.folders.push(app.Folder({ name: name })); return parent.folders.byName(name); }
  var allowed = mk(acc, argv[0]), foreign = mk(acc, argv[1]), sub = mk(allowed, argv[2]);
  foreign.notes.push(app.Note({ body: '<div><h1>Чужая</h1></div><div>' + argv[3] + '</div>' }));
  sub.notes.push(app.Note({ body: '<div><h1>Во вложенной</h1></div><div>' + argv[3] + '</div>' }));
  return JSON.stringify({ allowed: allowed.id(), foreign: foreign.id(), sub: sub.id(), foreignNote: foreign.notes[0].id(), subNote: sub.notes[0].id() });
}`;
// Counts alone also accept broken data:image/png;base64,(null). Compare decoded bytes below.
const NOTE_STATE = `function run(argv) {
  var n = Application('Notes').notes.byId(argv[0]), ids = n.attachments.id(), seen = {}, k = 0;
  for (var i = 0; i < ids.length; i++) if (!seen[ids[i]]) { seen[ids[i]] = true; k++; }
  var body = n.body(), sources = [], re = /<img\\b[^>]*\\bsrc="([^"]*)"/g, match;
  while ((match = re.exec(body))) sources.push(match[1]);
  return JSON.stringify({ attachments: k, img: (body.match(/<img/g) || []).length, sources: sources });
}`;
const NOTE_CONTAINER = `function run(argv) {
  try { return Application('Notes').notes.byId(argv[0]).container().name(); } catch (e) { return 'нет'; }
}`;
// Удаление папки целиком iCloud откатывает при следующей синхронизации (папка возвращается вместе с заметками),
// а вложенная папка после удаления родителя остаётся сиротой. Поэтому: сначала заметки, потом вложенная папка,
// потом остальные; acc.folders видит и вложенные папки.
const CLEANUP = `function run(argv) {
  var app = Application('Notes'), acc = app.defaultAccount(), spec = JSON.parse(argv[0]), done = [], retained = [];
  function known(collection, id) { try { var item = collection.byId(id); item.id(); return item; } catch(e) { if(Number(e.errorNumber) === -1728) return null; throw e; } }
  // Validate every exact created ID before deleting anything. Unknown members are never deleted.
  for (var i = 0; i < spec.notes.length; i++) {
    var t = spec.notes[i], n = known(app.notes, t.id);
    if (n && (n.name() !== t.title || n.container().id() !== t.folder)) throw Error('Own note identity mismatch');
  }
  for (var i = 0; i < spec.notes.length; i++) {
    var t = spec.notes[i], n = known(app.notes, t.id);
    if (n) { if(n.name() !== t.title || n.container().id() !== t.folder) throw Error('Own note changed'); n.delete(); done.push(t.id); }
  }
  for (var i = 0; i < spec.folders.length; i++) {
    var t = spec.folders[i], f = known(acc.folders, t.id);
    if (!f) continue;
    if (f.name() !== t.name) throw Error('Own folder identity mismatch');
    var childIds = f.folders.id(), active = [];
    for (var j = 0; j < childIds.length; j++) if (known(acc.folders, childIds[j])) active.push(childIds[j]);
    if (f.notes.id().length || active.length) { retained.push(t.id); continue; }
    f.delete(); done.push(t.id);
  }
  return JSON.stringify({ removedKnownIds: done, unexpectedRetained: retained });
}`;
const LEFTOVER = `function run(argv) {
  var names = Application('Notes').defaultAccount().folders.name(), out = [];
  for (var i = 0; i < names.length; i++) if (argv.indexOf(names[i]) >= 0) out.push(names[i]);
  return JSON.stringify(out);
}`;

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const clients = [];
let fixtureIds;
const ownedNotes = new Map();
function cleanupSpec() {
  return { notes: [...ownedNotes.values()], folders: fixtureIds ? [
    { id: fixtureIds.sub, name: SUB }, { id: fixtureIds.allowed, name: ALLOWED }, { id: fixtureIds.foreign, name: FOREIGN },
  ] : [] };
}
async function noteState(id) {
  const state = JSON.parse(await jxa(NOTE_STATE, id));
  state.imageBytesMatch = state.sources.length === 1 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(state.sources[0])
    && Buffer.from(state.sources[0].split(',')[1], 'base64').equals(PNG);
  delete state.sources;
  return state;
}
async function connect(folder) {
  const profile = join(ROOT, `profile-${clients.length}`);
  const plugin = join(profile, 'agent-utils', 'apple-notes-folder');
  await mkdir(plugin, { recursive: true, mode: 0o700 });
  if (HOST === 'codex' && folder) await writeFile(join(plugin, 'config.json'), JSON.stringify({ version: 1, folder }), { mode: 0o600 });
  const paths = { configFile: HOST === 'codex' ? join(plugin, 'config.json') : null, runtimeDir: join(plugin, 'runtime') };
  const client = new Client({ name: 'live-check-server-only', version: '2.0.0' });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [SERVER, '--client', HOST], env: { ...process.env,
      CODEX_HOME: profile, CLAUDE_CONFIG_DIR: profile, NOTES_FOLDER: HOST === 'claude' ? folder : 'ignored-host-sentinel' } }),
  );
  clients.push(client);
  contexts.set(client, paths);
  return client;
}
let sequence = 0;
async function imageCall(client, name, args, href) {
  // Synthetic confirmation ONLY: this proves the shared server, never client provenance.
  const sha256 = createHash('sha256').update(PNG).digest('hex');
  const ticket = await issueTicket(contexts.get(client), {
    host: HOST, sessionId: 'synthetic-server-only-session', callId: `synthetic-call-${++sequence}`, transcriptPath: '',
  }, name, args, [{ href, aliases: [], bytes: PNG, sha256 }]);
  return call(client, name, { ...args, attachment_ticket: ticket });
}
async function call(client, name, args) {
  const r = await client.callTool({ name, arguments: args });
  const result = { isError: Boolean(r.isError), text: r.content?.[0]?.text ?? '' };
  if (!result.isError && name === 'notes_create') {
    const { id } = JSON.parse(result.text);
    ownedNotes.set(id, { id, title: args.title, folder: fixtureIds.allowed });
  }
  if (!result.isError && name === 'notes_delete') ownedNotes.delete(args.id);
  return result;
}

try {
  console.log(`SERVER-ONLY ${HOST}: synthetic ticket confirmation; not a client attachment test.`);
  console.log('Временные тестовые папки iCloud будут созданы и удалены; удалённые заметки могут оставаться в «Недавно удалённых» до 30 дней. Окно Notes может появиться.');
  console.log(`Own fixture names: ${JSON.stringify([ALLOWED, FOREIGN, SUB])}`);
  const options = buildOptions(ROOT);
  delete options.outdir;
  await build({ ...options, absWorkingDir: dirname(fileURLToPath(new URL('../package.json', import.meta.url))), entryPoints: ['src/attachments/tickets.ts'], outfile: HELPER });
  await chmod(HELPER, 0o600);
  ({ issueTicket } = await import(pathToFileURL(HELPER).href));
  await mkdir(IMG_DIR, { recursive: true, mode: 0o700 });
  // Пробел и кириллица в имени — как у скриншотов; в HTML уходит file://-URL с процентным кодированием.
  const png = `${IMG_DIR}/снимок экрана 1.png`;
  await writeFile(png, PNG, { mode: 0o600 });
  const ids = JSON.parse(await jxa(SETUP, ALLOWED, FOREIGN, SUB, SECRET));
  fixtureIds = ids;
  ownedNotes.set(ids.foreignNote, { id: ids.foreignNote, title: 'Чужая', folder: ids.foreign });
  ownedNotes.set(ids.subNote, { id: ids.subNote, title: 'Во вложенной', folder: ids.sub });
  console.log(`Own fixture IDs: ${JSON.stringify(ids)}`);
  const c = await connect(ALLOWED);
  const inventory = (await c.listTools()).tools;
  check('ровно семь инструментов', inventory.length === 7, `N=${inventory.length}`);
  check('readonly/destructive annotations', inventory.every(t => Boolean(t.annotations?.readOnlyHint) === ['notes_list', 'notes_search', 'notes_read'].includes(t.name) && Boolean(t.annotations?.destructiveHint) === ['notes_update', 'notes_delete'].includes(t.name)));
  const bad = await call(c, 'notes_create', { title: 'invalid-ticket', markdown: `![](<${png}>)`, attachment_ticket: '0'.repeat(64) });
  check('неправильный билет отклонён до записи', bad.isError && bad.text.includes('Допуск'));
  check('после неправильного билета заметок нет', JSON.parse((await call(c, 'notes_list', {})).text).total === 0);
  const noTicket = await call(c, 'notes_create', { title: 'no-ticket', markdown: `![](<${png}>)` });
  check('tmp-файл без допуска отклонён', noTicket.isError && noTicket.text.includes('Допуск'));
  // Заметки обрабатывают вложение не мгновенно: ждём, пока состояние заметки станет ожидаемым (до 15 с).
  async function stateOf(nid, want) {
    let st;
    for (let i = 0; i < 15; i++) {
      st = await noteState(nid);
      if (st.attachments === want.attachments && st.img === want.img && st.imageBytesMatch) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return st;
  }
  const isAttachmentsRefusal = (r) => r.isError && r.text.includes('вложения');

  // 1. Заметка A с картинкой: вложение через file://, текст заметки с вложениями сервер не меняет.
  const createdA = await imageCall(c, 'notes_create', { title: 'Проверка картинки', markdown: `Подпись\n\n![](<${png}>)` }, png);
  check('notes_create с картинкой', !createdA.isError, createdA.text);
  const idA = JSON.parse(createdA.text).id;
  let st = await stateOf(idA, { attachments: 1, img: 1 });
  check('одно PNG-вложение: декодированные bytes равны исходным', st.attachments === 1 && st.img === 1 && st.imageBytesMatch, JSON.stringify(st));
  let md = (await call(c, 'notes_read', { id: idA })).text;
  check('notes_read(A) сообщает о вложении', md.includes('[Вложений в заметке: 1'), md.slice(-80));
  const appA = await call(c, 'notes_append', { id: idA, markdown: 'взлом вложений' });
  check('notes_append(A) → отказ из-за вложений', isAttachmentsRefusal(appA), appA.text);
  const updA = await call(c, 'notes_update', { id: idA, markdown: '# Проверка картинки\n\nзамена' });
  check('notes_update(A) → отказ из-за вложений', isAttachmentsRefusal(updA), updA.text);
  st = await noteState(idA);
  md = (await call(c, 'notes_read', { id: idA })).text;
  check(
    'у A после отказов по-прежнему 1 вложение',
    st.attachments === 1 && st.img === 1 && st.imageBytesMatch && md.includes('[Вложений в заметке: 1') && !md.includes('взлом'),
    JSON.stringify(st),
  );

  // 1a. Заметка C: дописывание сразу после создания с картинкой, без ожидания — Заметки могут ещё не
  // посчитать вложение, отказ должен сработать и по следу картинки в теле.
  const createdC = await imageCall(c, 'notes_create', { title: 'Проверка сразу', markdown: `![](<${png}>)` }, png);
  check('notes_create(C) с картинкой', !createdC.isError, createdC.text);
  const idC = JSON.parse(createdC.text).id;
  const appC = await call(c, 'notes_append', { id: idC, markdown: 'текст' });
  check('notes_append(C) сразу после создания → отказ из-за вложений', isAttachmentsRefusal(appC), appC.text);
  st = await stateOf(idC, { attachments: 1, img: 1 });
  md = (await call(c, 'notes_read', { id: idC })).text;
  check('у C исходные PNG bytes, текст не дописан', st.attachments === 1 && st.img === 1 && st.imageBytesMatch && !md.includes('текст'), JSON.stringify(st));

  // 2. Заметка B без картинок: заголовок, оформление, дописывание, замена.
  const created = await call(c, 'notes_create', { title: 'Проверка связи', markdown: 'Текст **жирный**' });
  check('notes_create', !created.isError, created.text);
  const id = JSON.parse(created.text).id;
  const mine = JSON.parse((await call(c, 'notes_list', {})).text).notes.find((n) => n.id === id);
  check('заголовок заметки совпал с title', mine?.name === 'Проверка связи', `name=${JSON.stringify(mine?.name)}`);
  md = (await call(c, 'notes_read', { id })).text;
  console.log(`--- notes_read(B) после создания ---\n${md.slice(0, 500)}\n---`);
  check('оформление сохранилось', md.includes('**жирный**'));
  check('без вложений строки о вложениях нет', !md.includes('Вложений в заметке'));
  await call(c, 'notes_append', { id, markdown: 'пункт добавлен' });
  md = (await call(c, 'notes_read', { id })).text;
  check('append дописал текст', md.includes('пункт добавлен'));
  const upd = await call(c, 'notes_update', { id, markdown: md.replace('**жирный**', '**изменён**') });
  check('notes_update', !upd.isError, upd.text);
  md = (await call(c, 'notes_read', { id })).text;
  check('update заменил текст', md.includes('**изменён**') && md.includes('пункт добавлен'));

  // 3. Поиск.
  const s1 = JSON.parse((await call(c, 'notes_search', { query: 'ИЗМЕНЁН' })).text);
  check('поиск без учёта регистра, кириллица', s1.total === 1, `total=${s1.total}`);
  const s1e = JSON.parse((await call(c, 'notes_search', { query: 'изменен' })).text);
  check('поиск различает «ё» и «е»', s1e.total === 0, `total=${s1e.total}`);
  const s2 = JSON.parse((await call(c, 'notes_search', { query: SECRET })).text);
  check('поиск не видит чужую и вложенную папки', s2.total === 0, `total=${s2.total}`);
  // Запрос с дефисом в начале не должен разбираться osascript как опция.
  const s3 = await call(c, 'notes_search', { query: `-${SECRET}` });
  check('поиск с дефисом в начале запроса', !s3.isError, s3.isError ? s3.text : `total=${JSON.parse(s3.text).total}`);

  // 4. Картинка в существующую заметку без вложений — через notes_append; дальше заметка только для чтения.
  const appImg = await imageCall(c, 'notes_append', { id, markdown: `![](<${png}>)` }, png);
  check('notes_append(B) с картинкой', !appImg.isError, appImg.text);
  st = await stateOf(id, { attachments: 1, img: 1 });
  md = (await call(c, 'notes_read', { id })).text;
  check(
    'у B 1 вложение, текст B на месте',
    st.attachments === 1 && st.img === 1 && st.imageBytesMatch && md.includes('**изменён**') && md.includes('пункт добавлен') && md.includes('[Вложений в заметке: 1'),
    JSON.stringify(st),
  );
  const appB2 = await call(c, 'notes_append', { id, markdown: 'ещё' });
  check('повторный notes_append(B) → отказ из-за вложений', isAttachmentsRefusal(appB2), appB2.text);

  // 5. Заметка D со списком: чек-листы неотличимы от обычных списков в HTML — правка отказывает, текст цел.
  const createdD = await call(c, 'notes_create', { title: 'Проверка списка', markdown: '- раз\n- два' });
  check('notes_create(D) со списком', !createdD.isError, createdD.text);
  const idD = JSON.parse(createdD.text).id;
  const isListsRefusal = (r) => r.isError && r.text.includes('списки');
  const appD = await call(c, 'notes_append', { id: idD, markdown: 'ещё' });
  check('notes_append(D) → отказ из-за списка', isListsRefusal(appD), appD.text);
  const updD = await call(c, 'notes_update', { id: idD, markdown: '# Проверка списка\n\nзамена' });
  check('notes_update(D) → отказ из-за списка', isListsRefusal(updD), updD.text);
  md = (await call(c, 'notes_read', { id: idD })).text;
  check(
    'текст D не изменился после отказов',
    md.includes('раз') && md.includes('два') && !md.includes('ещё') && !md.includes('замена'),
    md,
  );

  // 6. Список — только своя заметка (вложенная папка не входит).
  const list = JSON.parse((await call(c, 'notes_list', { limit: 200 })).text);
  const listed = list.notes.map((n) => n.id).sort();
  check(
    'список: только свои заметки',
    list.total === 4 && JSON.stringify(listed) === JSON.stringify([id, idA, idC, idD].sort()),
    `total=${list.total}`,
  );

  // 7. Чужая и вложенная папки — отказ без названия заметки.
  for (const [label, nid] of [
    ['чужая папка', ids.foreignNote],
    ['вложенная папка', ids.subNote],
  ]) {
    for (const [tool, extra] of [
      ['notes_read', {}],
      ['notes_append', { markdown: 'взлом' }],
      ['notes_update', { markdown: 'взлом' }],
      ['notes_delete', {}],
    ]) {
      const r = await call(c, tool, { id: nid, ...extra });
      const clean = !r.text.includes('Чужая') && !r.text.includes('Во вложенной');
      check(`${label}: ${tool} → отказ`, r.isError && r.text.includes('вне разрешённой папки') && clean, r.text);
    }
  }
  const where = await jxa(NOTE_CONTAINER, ids.foreignNote);
  check('чужая заметка на месте после попыток', where === FOREIGN, `container=${where}`);

  // 8. Удаление своей.
  const del = await call(c, 'notes_delete', { id });
  check('notes_delete', !del.isError, del.text);
  const delA = await call(c, 'notes_delete', { id: idA });
  check('notes_delete заметки с вложением', !delA.isError, delA.text);
  const delC = await call(c, 'notes_delete', { id: idC });
  check('notes_delete(C)', !delC.isError, delC.text);
  const delD = await call(c, 'notes_delete', { id: idD });
  check('notes_delete(D)', !delD.isError, delD.text);
  const gone = await call(c, 'notes_read', { id });
  check('удалённая заметка недоступна', gone.isError, gone.text);

  // 9. Ошибки настройки.
  const e1 = await call(await connect(''), 'notes_list', {});
  check('папка не задана → ошибка настройки', e1.isError && e1.text.includes(HOST === 'claude' ? '/plugin configure' : '$apple-notes-folder:setup'), e1.text);
  const e2 = await call(await connect(`anf-missing-${SUFFIX}`), 'notes_list', {});
  check('папка не существует → «не найдена» с подсказкой про «Notes»', e2.isError && e2.text.includes('не найдена') && e2.text.includes('«Notes»'), e2.text);

  // 10. Время на большой папке — только чтение.
  if (process.env.LIVE_BIG_FOLDER) {
    const big = await connect(process.env.LIVE_BIG_FOLDER);
    let t = Date.now();
    const l = await call(big, 'notes_list', { limit: 50 });
    const tl = Date.now() - t;
    t = Date.now();
    const s = await call(big, 'notes_search', { query: process.env.LIVE_BIG_QUERY ?? 'а' });
    const ts = Date.now() - t;
    const total = (r) => (r.isError ? r.text : JSON.parse(r.text).total);
    console.log(`Большая папка: notes_list ${tl} мс (total=${total(l)}), notes_search ${ts} мс (total=${total(s)})`);
    check('большая папка: notes_list без ошибки', !l.isError, l.isError ? l.text : '');
    check('поиск по широкому запросу уложился в 30 с', !s.isError && ts < 30_000, s.isError ? s.text : `${ts} мс`);
  }
} finally {
  for (const client of clients) await client.close().catch(() => {});
  const removed = await jxa(CLEANUP, JSON.stringify(cleanupSpec())).catch((e) => { check('cleanup exact IDs', false, e.message); return 'ошибка удаления'; });
  console.log(`Удалены тестовые папки: ${removed}`);
  // Синхронизация iCloud может вернуть папку через несколько секунд — проверить и удалить ещё раз.
  for (let round = 1; round <= 3; round++) {
    await new Promise((r) => setTimeout(r, 20_000));
    let left;
    try { left = JSON.parse(await jxa(LEFTOVER, SUB, ALLOWED, FOREIGN)); }
    catch (error) { check('проверка cleanup при ожидании iCloud', false, error.message); break; }
    if (!left.length) break;
    console.log(`Тестовые папки вернулись (${round}): ${JSON.stringify(left)} — проверяю только известные IDs`);
    await jxa(CLEANUP, JSON.stringify(cleanupSpec())).catch((e) => check('cleanup retry exact IDs', false, e.message));
  }
  try {
    const left = JSON.parse(await jxa(LEFTOVER, SUB, ALLOWED, FOREIGN));
    check('не осталось тестовых папок', left.length === 0, JSON.stringify(left));
  } catch (error) { check('проверка cleanup', false, error.message); }
  await rm(ROOT, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\nПроверок: ${results.length}, не прошло: ${failed.length}`);
process.exit(failed.length ? 1 : 0);
