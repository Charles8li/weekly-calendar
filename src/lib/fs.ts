// src/lib/fs.ts
import { BaseDirectory, readFile, writeFile, mkdir } from '@tauri-apps/plugin-fs';

export const DATA_DIR = 'data'; // AppLocalData/data

export async function ensureDataFolders() {
  await mkdir(DATA_DIR, { baseDir: BaseDirectory.AppLocalData, recursive: true });
  await mkdir(`${DATA_DIR}/ai_inbox`, { baseDir: BaseDirectory.AppLocalData, recursive: true });
  await mkdir(`${DATA_DIR}/ai_outbox`, { baseDir: BaseDirectory.AppLocalData, recursive: true });
  await mkdir(`${DATA_DIR}/export`,   { baseDir: BaseDirectory.AppLocalData, recursive: true });
}

export async function readText(relPath: string) {
  const bytes = await readFile(`${DATA_DIR}/${relPath}`, { baseDir: BaseDirectory.AppLocalData });
  return new TextDecoder().decode(bytes);
}

export async function writeText(relPath: string, text: string) {
  await writeFile(`${DATA_DIR}/${relPath}`, new TextEncoder().encode(text), { baseDir: BaseDirectory.AppLocalData });
}

// Utility: check existence by trying to read
export async function exists(relPath: string) {
  try {
    await readFile(`${DATA_DIR}/${relPath}`, { baseDir: BaseDirectory.AppLocalData });
    return true;
  } catch { return false; }
}
