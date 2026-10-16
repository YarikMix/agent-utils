export const CLEANUP = `function run(argv) {
  var app = Application('Notes'), acc = app.defaultAccount(), spec = JSON.parse(argv[0]), done = [], retained = [];
  function known(collection, id) { try { var item = collection.byId(id); item.id(); return item; } catch(e) { if(Number(e.errorNumber) === -1728) return null; throw e; } }
  // Validate every exact created ID before deleting anything. Unknown members are never deleted.
  for (var i = 0; i < spec.notes.length; i++) {
    var t = spec.notes[i], n = known(app.notes, t.id);
    if (n && (n.name() !== t.title || n.container().id() !== t.folder || (t.marker && n.body().indexOf(t.marker) < 0))) throw Error('Own note identity mismatch');
  }
  for (var i = 0; i < spec.notes.length; i++) {
    var t = spec.notes[i], n = known(app.notes, t.id);
    if (n) { if(n.name() !== t.title || n.container().id() !== t.folder || (t.marker && n.body().indexOf(t.marker) < 0)) throw Error('Own note changed'); n.delete(); done.push(t.id); }
  }
  for (var i = 0; i < spec.folders.length; i++) {
    var t = spec.folders[i], f = known(acc.folders, t.id);
    if (!f) continue;
    if (f.name() !== t.name || f.container().id() !== t.parent) throw Error('Own folder identity mismatch');
    var childIds = f.folders.id(), active = [];
    for (var j = 0; j < childIds.length; j++) if (known(acc.folders, childIds[j])) active.push(childIds[j]);
    if (f.notes.id().length || active.length) { retained.push(t.id); continue; }
    f.delete(); done.push(t.id);
  }
  return JSON.stringify({ removedKnownIds: done, unexpectedRetained: retained });
}`;

export const SETUP_ACCOUNT = `function run() { return JSON.stringify({ id: Application('Notes').defaultAccount().id() }); }`;
// One native mutation per process. Even a post-push error returns its observed identity.
export const SETUP_STEP = `function run(argv) {
  var app = Application('Notes'), t = JSON.parse(argv[1]), attempted = false;
  var parent = t.parentKind === 'account' ? app.defaultAccount() : app.folders.byId(t.parent);
  if (parent.id() !== t.parent) throw Error('Setup parent identity mismatch');
  var collection = t.kind === 'folder' ? parent.folders : parent.notes;
  function inspect() {
    var matches = collection.whose({ name: t.name })(), out = [];
    for (var i = 0; i < matches.length; i++) {
      var n = matches[i];
      out.push({ id: n.id(), name: n.name(), parent: n.container().id(), marker: t.kind === 'folder' || n.body().indexOf(t.marker) >= 0 });
    }
    return out;
  }
  if (argv[0] === 'inspect') return JSON.stringify(inspect());
  try {
    if (inspect().length) return JSON.stringify({ ok: false, attempted: false, error: 'Setup name already exists' });
    attempted = true;
    collection.push(t.kind === 'folder' ? app.Folder({ name: t.name }) : app.Note({ body: '<div><h1>' + t.name + '</h1></div><div>' + t.marker + '</div>' }));
    return JSON.stringify({ ok: true, items: inspect() });
  } catch (error) {
    var items = [];
    try { items = inspect(); } catch (_) {}
    return JSON.stringify({ ok: false, attempted: attempted, items: items, error: String(error) });
  }
}`;

export function newFixtureJournal() {
  return { version: 1, ids: {}, folders: [], notes: [], pending: null, complete: false };
}

function acceptIdentity(target, items) {
  if (!Array.isArray(items) || items.length !== 1) throw Error('Setup recovery is absent or ambiguous');
  const item = items[0];
  if (!item || typeof item.id !== 'string' || !item.id || item.name !== target.name || item.parent !== target.parent || item.marker !== true) {
    throw Error('Setup recovery identity mismatch');
  }
  return item;
}

async function recordIdentity(journal, target, items, persist) {
  const item = acceptIdentity(target, items);
  journal.ids[target.key] = item.id;
  if (target.kind === 'folder') journal.folders.push({ id: item.id, name: target.name, parent: target.parent });
  else journal.notes.push({ id: item.id, title: target.name, folder: target.parent, marker: target.marker });
  journal.pending = null;
  await persist(journal);
}

export async function recoverPending(journal, run, persist) {
  if (!journal.pending) return;
  // The saved preflight proved absence before this one attempted mutation. No generic name cleanup.
  const target = journal.pending;
  if (target.preflightEmpty !== true) throw Error('Missing setup preflight proof');
  await recordIdentity(journal, target, await run('inspect', target), persist);
}

export async function setupFixtures(journal, run, persist, names, marker) {
  const account = await run('account');
  if (!account || typeof account.id !== 'string' || !account.id) throw Error('Missing setup account identity');
  journal.account = account.id;
  await persist(journal);
  const step = async (kind, key, name, parent, parentKind) => {
    const target = { kind, key, name, parent, parentKind, ...(kind === 'note' ? { marker } : {}) };
    const before = await run('inspect', target);
    if (!Array.isArray(before) || before.length) throw Error('Setup preflight name is occupied');
    journal.pending = { ...target, preflightEmpty: true };
    await persist(journal); // Recovery intent is committed BEFORE the native mutation.
    try {
      const result = await run('create', target);
      if (result?.ok === false && result.attempted === false) {
        journal.pending = null;
        await persist(journal);
      } else if (result?.ok === true) {
        await recordIdentity(journal, target, result.items, persist);
        return;
      } else if (result?.items?.length === 1) {
        // The native catch may already carry an exact identity despite a post-push failure.
        await recordIdentity(journal, target, result.items, persist);
      }
      throw Error(result?.error || 'Incomplete setup response');
    } catch (error) {
      try { await recoverPending(journal, run, persist); }
      catch (recovery) { journal.recoveryError = String(recovery); await persist(journal); }
      throw error;
    }
  };
  await step('folder', 'allowed', names.allowed, account.id, 'account');
  await step('folder', 'foreign', names.foreign, account.id, 'account');
  await step('folder', 'sub', names.sub, journal.ids.allowed, 'folder');
  await step('note', 'foreignNote', 'Чужая', journal.ids.foreign, 'folder');
  await step('note', 'subNote', 'Во вложенной', journal.ids.sub, 'folder');
  journal.complete = true;
  await persist(journal);
  return journal.ids;
}

export function cleanupSpec(journal, ownedNotes = new Map()) {
  const notes = new Map(journal.notes.map(note => [note.id, note]));
  for (const [id, note] of ownedNotes) notes.set(id, { ...notes.get(id), ...note });
  // An unresolved in-flight mutation may still create a child: retain its ancestors and recovery record.
  return { notes: [...notes.values()], folders: journal.pending ? [] : [...journal.folders].reverse() };
}
