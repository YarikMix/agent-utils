#!/usr/bin/env python3
"""Regenerate the standalone figma-lookup distribution from canonical figma-ops.

Repository maintenance only. Installed runtime never invokes this tool.
"""
from pathlib import Path
import shutil


def main():
    canonical = Path(__file__).resolve().parents[1]
    legacy = canonical.parent / 'figma-lookup'
    sources = [path for path in (canonical / 'scripts').glob('*.py')
               if path.name != Path(__file__).name]
    destination = legacy / 'scripts'
    destination.mkdir(parents=True, exist_ok=True)
    names = {path.name for path in sources}
    for stale in destination.glob('*.py'):
        if stale.name not in names:
            stale.unlink()
    for source in sources:
        shutil.copyfile(source, destination / source.name)
    skill = canonical / 'skills' / 'figma-ops'
    compat = legacy / 'skills' / 'figma-lookup'
    compat.mkdir(parents=True, exist_ok=True)
    shutil.copytree(skill / 'references', compat / 'references', dirs_exist_ok=True)
    for stale in (compat / 'references').iterdir():
        if stale.is_file() and not (skill / 'references' / stale.name).exists():
            stale.unlink()
    frontmatter, body = skill.joinpath('SKILL.md').read_text().split('---', 2)[1:]
    frontmatter = frontmatter.replace('\nname: figma-ops\n', '\nname: figma-lookup\n', 1)
    frontmatter = frontmatter.replace('\ndescription: ', '\ndescription: Compatibility alias for figma-ops. ', 1)
    compat.joinpath('SKILL.md').write_text('---' + frontmatter + '---' + body)
    print(f'Synchronized {len(sources)} runtime modules and standalone skill/references.')


if __name__ == '__main__':
    main()
