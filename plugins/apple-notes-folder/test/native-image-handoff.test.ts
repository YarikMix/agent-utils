import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { NotesService } from '../src/notes.js';
import type { Runner } from '../src/runner.js';

// Mock only AppleEvents; execute the actual JXA and HTML file lifecycle.
// Without descriptor delivery Notes cannot import the image, despite creating an attachment.
function nativeBoundary(errorNumber = -1728, existing = '<div>old</div>', outside = false) {
  const events: string[] = [];
  let body = existing;
  const note = { id: () => 'N', container: () => ({ id: () => outside ? 'OTHER' : 'F' }),
    passwordProtected: () => false, attachments: { id: () => [] } } as any;
  Object.defineProperty(note, 'body', { get: () => () => body, set: value => { events.push('write'); body = value; } });
  const folder = { id: () => 'F', notes: { push: (n: { body: string }) => { events.push('write'); body = n.body; } } };
  const app = { folders: { byId: () => folder }, notes: { byId: () => note },
    Note: (props: { body: string }) => ({ ...props, id: () => 'N' }),
    exists: (path: string) => { events.push(`handoff:${path}`); throw Object.assign(new Error('native failure'), { errorNumber }); } };
  const run: Runner = async (script, args) => {
    const context = { Application: () => app, Path: (p: string) => p,
      ObjC: { import() {}, unwrap: (v: any) => v.text },
      $: { NSUTF8StringEncoding: 4, NSString: { stringWithContentsOfFileEncodingError: (p: string) => ({ isNil: () => false, text: readFileSync(p, 'utf8') }) } } };
    return runInNewContext(`${script}\nrun(${JSON.stringify(args)})`, context);
  };
  return { run, events, body: () => body };
}

describe('native image descriptor handoff', () => {
  it.each(['create', 'append', 'update'] as const)('%s delivers all verified files before writing, ignoring only native -1728', async operation => {
    const native = nativeBoundary();
    const service = new NotesService(native.run, 'F', ['/closed/snapshots/a.png', '/closed/snapshots/b.png']);
    const html = '<div><img src="file:///closed/snapshots/a.png"><img src="file:///closed/snapshots/b.png"></div>';
    if (operation === 'create') await service.create(html);
    else await service[operation]('N', html);
    expect(native.events).toEqual(['handoff:/closed/snapshots/a.png', 'handoff:/closed/snapshots/b.png', 'write']);
    expect(native.body()).toContain(html);
  });

  it.each([-1743, -1712, -10000])('native error %s stops before any write', async code => {
    const native = nativeBoundary(code);
    const service = new NotesService(native.run, 'F', ['/closed/snapshots/a.png']);
    await expect(service.create('<div>x</div>')).rejects.toMatchObject({ errorNumber: code });
    expect(native.events).toEqual(['handoff:/closed/snapshots/a.png']);
  });

  it.each(['append', 'update'] as const)('%s keeps container and list guards before file handoff', async operation => {
    for (const [body, outside, message] of [['<div>x</div>', true, 'APN:OUTSIDE'], ['<ul><li>x</li></ul>', false, 'APN:LISTS']] as const) {
      const native = nativeBoundary(-1728, body, outside);
      await expect(new NotesService(native.run, 'F', ['/closed/snapshots/a.png'])[operation]('N', '<div>new</div>')).rejects.toThrow(message);
      expect(native.events).toEqual([]);
    }
  });

  it('text-only writes send no file descriptors even for file links in HTML', async () => {
    const native = nativeBoundary();
    await new NotesService(native.run, 'F').create('<a href="file:///untrusted">link</a>');
    expect(native.events).toEqual(['write']);
  });
});
