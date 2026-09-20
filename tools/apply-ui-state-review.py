"""One-shot review-branch transport. Removed from the formal release tree."""
import base64
import hashlib
import json
import lzma
import os
from pathlib import Path
import subprocess
import tempfile

BRANCH = 'fix/ui-state-ownership'
BASE = '9f1e967fbb92f349a1986579609d61adbc582179'
if os.environ.get('GITHUB_REF') != 'refs/heads/' + BRANCH:
    raise SystemExit('Refusing to apply outside the isolated review branch')

def git(*args, **kwargs):
    return subprocess.check_output(['git', *args], **kwargs).decode().strip()

hashes = [
    '35311c09d1ce64c54903675adfc2c7ff75b618f548e4b4322752a90ce265c844',
    'd94ca9fe674bd886c4c4aa3d931264227e7a2e867c23a41034998619d273ef9a',
    '8e72793b8abafd6691c933570c41ba0b6c53dcedf8267e955f2e61e01f22b7cf',
    'f00bc4f9a3cbc3e5f3636f9d5e41c7f6ab08eaac739fef0db15035307413d78e',
]
chunks = []
for index, digest in enumerate(hashes, 1):
    chunk = Path(f'tools/ui-state-review.payload.{index}').read_text().strip()
    if hashlib.sha256(chunk.encode()).hexdigest() != digest:
        raise SystemExit(f'Payload chunk {index} checksum mismatch')
    chunks.append(chunk)
raw = lzma.decompress(base64.b64decode(''.join(chunks), validate=True))
if hashlib.sha256(raw).hexdigest() != 'ac70abced7faa17e230743ef67aca3353b81ce3e6fd771203fa7c5b4208f0cfe':
    raise SystemExit('Payload checksum mismatch')
data = json.loads(raw)
if git('status', '--porcelain'):
    raise SystemExit('Dirty review checkout')
for path, expected in data['baseline'].items():
    if expected is None:
        if Path(path).exists():
            raise SystemExit(f'New path already exists: {path}')
    elif git('rev-parse', f'HEAD:{path}') != expected or git('rev-parse', f'{BASE}:{path}') != expected:
        raise SystemExit(f'Baseline changed: {path}')
git('config', 'user.name', 'github-actions[bot]')
git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
with tempfile.TemporaryDirectory() as directory:
    for index, part in enumerate(data['parts'], 1):
        patch = Path(directory) / f'{index}.patch'
        patch.write_text(part['patch'], encoding='utf-8')
        git('apply', '--check', str(patch))
        git('apply', str(patch))
        git('add', '--', *data['baseline'].keys())
        git('commit', '-m', part['message'])
        print(git('log', '-1', '--oneline'))
subprocess.run(['git', 'push', 'origin', 'HEAD:refs/heads/' + BRANCH], check=True)
with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
    output.write('sha=' + git('rev-parse', 'HEAD') + '\n')
