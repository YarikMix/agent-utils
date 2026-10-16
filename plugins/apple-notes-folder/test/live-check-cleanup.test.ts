import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const fixtures = await import(new URL('../scripts/live-check-fixtures.mjs', import.meta.url).href);
const names = { allowed: 'owned-random-allowed', foreign: 'owned-random-foreign', sub: 'owned-random-sub' };
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'notes-live-cleanup-')); await chmod(dir, 0o700); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
type Item = { key: string; kind: string; label: string; parent: Item | null; html: string; deleted: boolean; id: () => string; name: () => string; container: () => Item; body: () => string; delete: () => void; folders: any; notes: any };
// Mock only AppleEvents; execute shipped setup/inspect/catch/cleanup JXA unchanged.
function native(afterCreation = 0) {
  const items: Item[] = [], deleted: string[] = []; let sequence = 0, latestPersisted: any;
  const make = (kind: string, label: string, parent: Item | null, html = ''): Item => {
    const item: Item = { key: `${kind}-${sequence++}`, kind, label, parent, html, deleted: false,
      id: () => item.key, name: () => item.label, container: () => item.parent!, body: () => item.html,
      delete: () => { item.deleted = true; deleted.push(item.key); }, folders: null, notes: null };
    item.folders = collection(item, 'folder'); item.notes = collection(item, 'note'); items.push(item); return item;
  };
  const missing = () => { throw Object.assign(Error('not found'), { errorNumber: -1728 }); };
  const collection = (parent: Item | null, kind: string, global = false): any => {
    const current = () => items.filter(item => !item.deleted && item.kind === kind && (global || item.parent === parent));
    return { id: () => current().map(item => item.key), byId: (id: string) => current().find(item => item.key === id) ?? missing(),
      whose: ({ name }: { name: string }) => () => current().filter(item => item.label === name),
      push: (props: { name?: string; body?: string }) => {
        expect(latestPersisted.pending).toMatchObject({ parent: parent!.key, kind, preflightEmpty: true });
        make(kind, props.name ?? props.body!.match(/<h1>(.*?)<\/h1>/)![1], parent, props.body);
        if (items.filter(item => item.kind !== 'account').length === afterCreation) throw Error('fault after native creation');
      } };
  };
  const account = make('account', 'own account', null);
  const app = { defaultAccount: () => account, folders: collection(null, 'folder', true), notes: collection(null, 'note', true), Folder: (props: object) => props, Note: (props: object) => props };
  account.folders.byId = app.folders.byId;
  const execute = (script: string, args: string[]) => JSON.parse(runInNewContext(`${script};run(${JSON.stringify(args)})`, { Application: () => app }));
  const run = async (action: string, target: any) => execute(action === 'account' ? fixtures.SETUP_ACCOUNT : fixtures.SETUP_STEP, [action, JSON.stringify(target)]);
  const persist = async (journal: any) => { latestPersisted = structuredClone(journal); await writeFile(join(dir, 'journal.json'), JSON.stringify(journal), { mode: 0o600 }); };
  return { run, persist, items, deleted, account, make, cleanup: (journal: any, owned?: Map<string, any>) => execute(fixtures.CLEANUP, [JSON.stringify(fixtures.cleanupSpec(journal, owned))]), disk: async () => JSON.parse(await readFile(join(dir, 'journal.json'), 'utf8')) };
}

describe('live-check incremental setup journal and exact-ID failure cleanup', () => {
  it.each([1, 2, 3, 4, 5])('journals and cleans every exact ID after post-creation fault at step %i', async step => {
    const host = native(step), journal = fixtures.newFixtureJournal();
    await expect(fixtures.setupFixtures(journal, host.run, host.persist, names, 'own-marker')).rejects.toThrow('fault after native creation');
    expect(journal.folders.length + journal.notes.length).toBe(step); expect(journal.pending).toBeNull();
    expect(await host.disk()).toEqual(journal); expect((await stat(join(dir, 'journal.json'))).mode & 0o777).toBe(0o600);
    host.cleanup(journal); expect(host.deleted).toHaveLength(step);
    expect(host.items.filter(item => item.kind !== 'account').every(item => item.deleted)).toBe(true);
  });
  it.each([1, 2, 3, 4, 5])('recovers a lost response after native creation step %i and cleans the partial journal', async step => {
    const host = native(), journal = fixtures.newFixtureJournal(); let creates = 0;
    const run = async (action: string, target: any) => { const value = await host.run(action, target); if (action === 'create' && ++creates === step) throw Error('transport timeout or invalid JSON'); return value; };
    await expect(fixtures.setupFixtures(journal, run, host.persist, names, 'own-marker')).rejects.toThrow('transport');
    expect(journal.folders.length + journal.notes.length).toBe(step); expect(journal.pending).toBeNull();
    host.cleanup(await host.disk()); expect(host.deleted).toHaveLength(step);
  });
  it.each(['absent', 'read-error', 'wrong-parent', 'wrong-marker', 'ambiguous'])('retains intent and ancestors on %s recovery, then resumes safely', async failure => {
    const host = native(), journal = fixtures.newFixtureJournal(); let broken = false;
    const run = async (action: string, target: any) => {
      if (broken && action === 'inspect') {
        if (failure === 'read-error') throw Error('transport still unavailable');
        const values = await host.run(action, target);
        if (failure === 'absent') return []; if (failure === 'ambiguous') return [...values, ...values];
        return values.map((value: any) => ({ ...value, ...(failure === 'wrong-parent' ? { parent: 'unrelated' } : { marker: false }) }));
      }
      const value = await host.run(action, target); if (action === 'create' && target.key === 'foreignNote') { broken = true; throw Error('lost response'); } return value;
    };
    await expect(fixtures.setupFixtures(journal, run, host.persist, names, 'own-marker')).rejects.toThrow('lost response');
    const saved = await host.disk(); expect(saved.pending).toMatchObject({ key: 'foreignNote', preflightEmpty: true, marker: 'own-marker' });
    expect(fixtures.cleanupSpec(saved).folders).toEqual([]); expect(host.cleanup(saved).removedKnownIds).toEqual([]);
    await fixtures.recoverPending(saved, host.run, host.persist); expect(saved.pending).toBeNull(); host.cleanup(saved); expect(host.deleted).toHaveLength(4);
  });
  it('does not adopt or delete a name present before creation', async () => {
    const host = native(), outsider = host.make('folder', names.allowed, host.account), journal = fixtures.newFixtureJournal();
    await expect(fixtures.setupFixtures(journal, host.run, host.persist, names, 'own-marker')).rejects.toThrow('occupied');
    expect(journal.folders).toEqual([]); host.cleanup(journal); expect(outsider.deleted).toBe(false); expect(host.deleted).toEqual([]);
  });
  it('validates note identity and marker before any cleanup mutation', async () => {
    const host = native(), journal = fixtures.newFixtureJournal(); await fixtures.setupFixtures(journal, host.run, host.persist, names, 'own-marker');
    host.items.find(item => item.key === journal.ids.foreignNote)!.html = 'unrelated body';
    const ownTracked = new Map([[journal.ids.foreignNote, { id: journal.ids.foreignNote, title: 'Чужая', folder: journal.ids.foreign }]]);
    expect(() => host.cleanup(journal, ownTracked)).toThrow('identity mismatch'); expect(host.deleted).toEqual([]);
  });
  it('retains unexpected members and their parent instead of broad folder deletion', async () => {
    const host = native(), journal = fixtures.newFixtureJournal(); await fixtures.setupFixtures(journal, host.run, host.persist, names, 'own-marker');
    const parent = host.items.find(item => item.key === journal.ids.allowed)!, outsider = host.make('note', 'unrelated note', parent, 'unrelated');
    expect(host.cleanup(journal).unexpectedRetained).toEqual([parent.key]); expect(outsider.deleted).toBe(false); expect(parent.deleted).toBe(false); expect(host.deleted).toHaveLength(4);
  });
});
