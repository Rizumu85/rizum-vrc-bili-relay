"""One-shot repair-branch editing transport; excluded from the release tree."""
import os
import subprocess
from pathlib import Path

BRANCH = 'fix/session-expiry-list-state'
BASE = '79f16a4cbb4ea492ef46054f4f942de9111c4175'
if os.environ.get('GITHUB_REF') != 'refs/heads/' + BRANCH:
    raise SystemExit('Not the isolated repair branch')

def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()

baseline = {
    'src/app.tsx': 'dc2c126f2ca6d7edb996a9fda5e23686232e5e56',
    'src/relay/playback-flow.ts': 'c8b3e9f240463a30d3fbbab39f677ee98752e476',
    'src/relay/worker-diagnostics.ts': '29a91db67790d44df550d7a2e7d9408c1fcd4940',
    'src/relay/worker-rpc.ts': '6b66261d5cf2d7ef8a2138db5a39522ec3880b14',
}
expected = {
    'src/app.tsx': 'a6a5c126cfb97c5636f930944e6944b28deb37ce',
    'src/relay/playback-flow.ts': '4fcdb0c5a52c0d33b0e2a217e176698c659bb902',
    'src/relay/worker-diagnostics.ts': 'a9c93b4a6b74aa5c87794c0664f5b70a5f31f4f8',
    'src/relay/worker-rpc.ts': '62af81b1a1141aa169f1c9093fb5c50b4110a3e3',
}
if git('status', '--porcelain'):
    raise SystemExit('Dirty checkout')
for path, sha in baseline.items():
    if git('rev-parse', 'HEAD:' + path) != sha or git('rev-parse', BASE + ':' + path) != sha:
        raise SystemExit('Baseline changed: ' + path)

p = Path('src/relay/playback-flow.ts')
s = p.read_text()
s = s.replace('          (resolution) => this.remember(resolution, generation!),\n', '          (resolution) => this.remember(resolution, generation!),\n          (id, error) => this.retireMissingSession(id, generation!, intent.id, error),\n')
s = s.replace('''              this.trace("ui_stale_release_unconfirmed", { lease_id: stale.number });
              this.backend.invalidateGeneration(stale.generation);
              throw error;''', '''              if (!this.retireMissingSession(stale.status.session_id, stale.generation, intent.id, error)) {
                this.trace("ui_stale_release_unconfirmed", { lease_id: stale.number });
                this.backend.invalidateGeneration(stale.generation);
                throw error;
              }''')
s = s.replace('''          if (this.lease === stale) this.lease = null;
          this.invalidated();''', '''          if (this.lease === stale) {
            this.lease = null;
            this.invalidated();
          }''')
s = s.replace('''        // Generation loss is broadcast by the process adapter. A transient
        // status-read failure keeps the lease so polling/stop can still own it.
        throw error;''', '''        if (this.retireMissingSession(lease.status.session_id, lease.generation, revision, error)) return null;
        // Generation loss is broadcast by the process adapter. A transient
        // status-read failure keeps the lease so polling/stop can still own it.
        throw error;''')
pos = s.index('  private remember(')
s = s[:pos] + '''  /** Only an explicit reply from the same live generation proves absence.
   * Expired metadata is not an unknown process: stop is already satisfied.
   * Remove only this session, never another lease or a new prepared selection.
   * Do not cancel the current intent; a replacement can now proceed normally.
   */
  private retireMissingSession(id: string, generation: number, operationId: number, error: unknown): boolean {
    if (!(error instanceof RelayWorkerError) || error.code !== "media_session_not_found"
      || !this.backend.isGenerationCurrent(generation)) return false;
    const lease = this.lease;
    const owned = lease?.generation === generation && lease.status.session_id === id;
    if (this.prepared.get(id) === generation) this.prepared.delete(id);
    if (owned) {
      this.lease = null;
      this.invalidated();
    }
    this.trace("ui_session_absence_confirmed", {
      operation_id: operationId, generation, ...(owned ? { lease_id: lease.number } : {}),
    });
    return true;
  }

''' + s[pos:]
s = s.replace('''    } catch {
      this.trace("ui_failure_state_unknown", { lease_id: lease.number, generation });''', '''    } catch (error) {
      if (this.retireMissingSession(lease.status.session_id, generation, operationId, error)) return null;
      this.trace("ui_failure_state_unknown", { lease_id: lease.number, generation });''')
s = s.replace('''    private readonly remember: (resolution: SourceResolution) => void,
  ) {}''', '''    private readonly remember: (resolution: SourceResolution) => void,
    private readonly retireMissing: (id: string, error: unknown) => boolean,
  ) {}''')
s = s.replace('''    const status = await this.backend.startRelay(id, options, start, paused, this.generation, this.operationId);
    this.adopt(status, true); this.check(); return status;''', '''    let status: RelayStatus;
    try { status = await this.backend.startRelay(id, options, start, paused, this.generation, this.operationId); }
    catch (error) { this.retireMissing(id, error); throw error; }
    this.adopt(status, true); this.check(); return status;''')
s = s.replace('''    const status = await this.backend.stopRelay(lease.status.session_id, this.generation, this.operationId);
    this.adopt(status, false); this.check(); return status;''', '''    try {
      const status = await this.backend.stopRelay(lease.status.session_id, this.generation, this.operationId);
      this.adopt(status, false); this.check(); return status;
    } catch (error) {
      if (!this.retireMissing(lease.status.session_id, error)) throw error;
      this.check();
      return null;
    }''')
p.write_text(s)

p = Path('src/app.tsx')
s = p.read_text()
s = s.replace('import { CoverLoader } from "./relay/cover-loader";', 'import { CoverLoader } from "./relay/cover-loader";\nimport { ListRequestOwner, listLoadPending, type ListLoadPhase } from "./relay/list-request";')
s = s.replace('  const [foldersLoading, setFoldersLoading] = useState(false);', '  const [foldersPhase, setFoldersPhase] = useState<ListLoadPhase>("idle");\n  const foldersLoading = listLoadPending(foldersPhase);')
s = s.replace('  const [videosLoading, setVideosLoading] = useState(false);', '  const [videosPhase, setVideosPhase] = useState<ListLoadPhase>("idle");\n  const videosLoading = listLoadPending(videosPhase);')
s = s.replace('  const foldersEpoch = useRef(0);\n  const videosEpoch = useRef(0);', '''  const foldersRequest = useRef<ListRequestOwner | null>(null);
  const videosRequest = useRef<ListRequestOwner | null>(null);''')
s = s.replace('''  useEffect(() => () => {
    ++foldersEpoch.current; ++videosEpoch.current; ++searchEpoch.current; ++coversEpoch.current;
  }, []);''', '''  useEffect(() => {
    const folders = new ListRequestOwner(setFoldersPhase, recordUiState);
    const videos = new ListRequestOwner(setVideosPhase, recordUiState);
    foldersRequest.current = folders;
    videosRequest.current = videos;
    return () => {
      folders.dispose(); videos.dispose();
      foldersRequest.current = null; videosRequest.current = null;
      ++searchEpoch.current; ++coversEpoch.current;
    };
  }, []);''')
start = s.index('  const loadFolders = async () => {')
end = s.index('\n\n  useEffect(', start)
s = s[:start] + '''  const loadFolders = async () => {
    setFoldersError(null);
    await foldersRequest.current?.load(
      cache.read<FavoriteFolder[]>("folders"),
      () => cache.fill("folders", listFolders),
      setFolders,
      (error) => setFoldersError(favoriteErrorMessage(error)),
    );
  };''' + s[end:]
start = s.index('  const loadVideos = async (folder:')
end = s.index('\n\n  const openFolder', start)
s = s[:start] + '''  const loadVideos = async (folder: FavoriteFolder, page: number, append: boolean) => {
    setVideosError(null);
    const cacheKey = `folder:${folder.id}:${page}`;
    await videosRequest.current?.load(
      !append ? cache.read<FavoriteResourcePage>(cacheKey) : null,
      () => page === 1
        ? cache.fill(cacheKey, () => listResources(folder.id, page))
        : cache.scoped(() => listResources(folder.id, page)),
      (result) => {
        setVideos((current) => (append ? [...current, ...result.items] : result.items));
        setVideosPage(result.page);
        setVideosHasMore(result.hasMore);
      },
      (error) => setVideosError(favoriteErrorMessage(error)),
    );
  };''' + s[end:]
s = s.replace('    videosEpoch.current += 1;', '    videosRequest.current?.cancel();')
start = s.index('  const loadFlat = async (page:')
end = s.index('\n\n  useEffect(', start)
s = s[:start] + '''  const loadFlat = async (page: number, append: boolean) => {
    setVideosError(null);
    const cacheKey = source === "watchLater" ? "watch-later" : `history:${page}`;
    const cacheable = source === "watchLater" || page === 1;
    const fetchPage = () => (source === "watchLater" ? listWatchLater() : listHistory(page));
    await videosRequest.current?.load(
      !append && cacheable ? cache.read<FavoriteResourcePage>(cacheKey) : null,
      () => cacheable ? cache.fill(cacheKey, fetchPage) : cache.scoped(fetchPage),
      (result) => {
        setVideos((current) => (append ? [...current, ...result.items] : result.items));
        setVideosPage(result.page);
        setVideosHasMore(result.hasMore);
      },
      (error) => setVideosError(favoriteErrorMessage(error)),
    );
  };''' + s[end:]
p.write_text(s)
p = Path('src/relay/worker-rpc.ts')
s = p.read_text().replace('  lease_id?: number;', '  lease_id?: number;\n  list_id?: number;\n  list_revision?: number;')
p.write_text(s)
p = Path('src/relay/worker-diagnostics.ts')
s = p.read_text().replace('"lease_id", "scope_epoch"', '"lease_id", "list_id", "list_revision", "scope_epoch"')
p.write_text(s)
for path, sha in expected.items():
    if git('hash-object', path) != sha:
        raise SystemExit('Result differs from locally reviewed bytes: ' + path)
git('config', 'user.name', 'github-actions[bot]')
git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
git('add', '--', *expected)
git('commit', '-m', 'fix: retire confirmed missing sessions and bind cached list state to requests', '-m', 'AI-assisted implementation. Baseline and resulting source blobs checked; no timeout or media-clock changes.')
subprocess.run(['git', 'push', 'origin', 'HEAD:refs/heads/' + BRANCH], check=True)
with open(os.environ['GITHUB_OUTPUT'], 'a') as out:
    out.write('sha=' + git('rev-parse', 'HEAD') + '\n')
