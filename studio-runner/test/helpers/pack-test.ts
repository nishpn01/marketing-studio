import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO_ROOT } from '../../src/runner.ts';

export function copyPacks(prefix = 'studio-packs-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cpSync(join(REPO_ROOT, 'packs'), root, { recursive: true });
  return root;
}
export function packManifest(root: string, id: string) {
  const file = join(root, id, 'pack.json');
  return { file, value: JSON.parse(readFileSync(file, 'utf8')) as any };
}
export function savePackManifest(file: string, value: any) { writeFileSync(file, JSON.stringify(value)); }
