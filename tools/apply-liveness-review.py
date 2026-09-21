"""Review-branch-only patch transport; excluded from formal release."""
import hashlib
import json
import lzma
import os
from pathlib import Path
import subprocess
import tempfile

BRANCH = 'fix/polling-search-liveness'
BASE = '7702baff3e309caa079040aefef4f1f7cf218b3b'
if os.environ.get('GITHUB_REF') != 'refs/heads/' + BRANCH:
    raise SystemExit('Refusing to modify any other branch')

def git(*args):
    return subprocess.check_output(['git', *args]).decode().strip()

raw = lzma.decompress(Path('tools/liveness-review.xz').read_bytes())
if hashlib.sha256(raw).hexdigest() != '035cbcceb7340bbdb3d0cae22ee094522cb95674626335e58ea5239eb3a5ab45':
    raise SystemExit('Patch payload checksum mismatch')
data = json.loads(raw)
if git('status', '--porcelain'):
    raise SystemExit('Dirty review checkout')
for f in data['files']:
    p = f['path']
    if f['before'] is None:
        if Path(p).exists():
            raise SystemExit('New path already exists: ' + p)
    elif git('rev-parse', 'HEAD:' + p) != f['before'] or git('rev-parse', BASE + ':' + p) != f['before']:
        raise SystemExit('Baseline mismatch: ' + p)
with tempfile.TemporaryDirectory() as directory:
    patch = Path(directory) / 'review.patch'
    patch.write_text(data['patch'], encoding='utf-8')
    git('apply', '--check', str(patch))
    git('apply', str(patch))
for f in data['files']:
    if git('hash-object', '--', f['path']) != f['after']:
        raise SystemExit('Result blob mismatch: ' + f['path'])
git('config', 'user.name', 'github-actions[bot]')
git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
git('add', '--', *[f['path'] for f in data['files']])
git('commit', '-m', 'fix: maintain owned playback observation and query-scoped search pagination\n\nAI-assisted implementation. Exact baseline/result source hashes checked; no media clock or timeout changes.')
git('push', 'origin', 'HEAD:refs/heads/' + BRANCH)
with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
    output.write('sha=' + git('rev-parse', 'HEAD') + '\n')
