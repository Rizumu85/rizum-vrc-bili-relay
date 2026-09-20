import type { ProductSettings, SettingsUpdate, ThemePreference, OutputResolution } from "./protocol";
export interface SettingsDraft {
  host: string; key: string; playbackUrl: string; theme: ThemePreference; outputResolution: OutputResolution;
}
type Field = keyof SettingsDraft;
const FIELDS: Field[] = ["host", "key", "playbackUrl", "theme", "outputResolution"];
export interface DraftSnapshot {
  readonly revisions: Readonly<Record<Field, number>>;
  readonly update: SettingsUpdate;
}
function visible(stored: ProductSettings): SettingsDraft {
  return { host: stored.host, key: "", playbackUrl: stored.playbackUrl, theme: stored.theme, outputResolution: stored.outputResolution };
}
/** Field revisions distinguish the snapshot being saved from newer editing.
 * Server snapshots hydrate only clean fields; secret drafts are cleared only
 * by the acknowledgement for the exact version that included that secret.
 */
export class SettingsDraftState {
  private values: SettingsDraft;
  private revisions: Record<Field, number> = { host: 0, key: 0, playbackUrl: 0, theme: 0, outputResolution: 0 };
  private dirtyFields = new Set<Field>();
  constructor(stored: ProductSettings, theme = stored.theme) {
    this.values = visible(stored);
    if (theme !== stored.theme) this.edit("theme", theme);
  }
  get value(): SettingsDraft { return { ...this.values }; }
  get dirty(): boolean { return this.dirtyFields.size > 0; }
  get keyDirty(): boolean { return this.dirtyFields.has("key"); }
  edit<K extends Field>(field: K, value: SettingsDraft[K]): void {
    this.values[field] = value;
    this.revisions[field]++;
    this.dirtyFields.add(field);
  }
  hydrate(stored: ProductSettings): void {
    const server = visible(stored);
    for (const field of FIELDS) {
      if (!this.dirtyFields.has(field)) Object.assign(this.values, { [field]: server[field] });
    }
  }
  snapshot(): DraftSnapshot {
    const update: SettingsUpdate = {};
    for (const field of this.dirtyFields) {
      Object.assign(update, { [field === "key" ? "streamKey" : field]: this.values[field] });
    }
    return { revisions: { ...this.revisions }, update };
  }
  acknowledge(snapshot: DraftSnapshot, stored: ProductSettings): boolean {
    const clearsSecret = snapshot.update.streamKey !== undefined && snapshot.revisions.key === this.revisions.key;
    for (const field of FIELDS) {
      if (snapshot.revisions[field] === this.revisions[field]) this.dirtyFields.delete(field);
    }
    this.hydrate(stored);
    return clearsSecret;
  }
}
