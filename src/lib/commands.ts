// src/lib/commands.ts
import { ensureDataFolders, readText, writeText, exists } from './fs';
import { parseJSONL, stringifyJSONL, type Task, type Block, type AICommandEnvelope, type ChecklistItem } from './data';
import { DateTime } from 'luxon';

function nid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;
}

export async function loadTasks(): Promise<Task[]> {
  if (!(await exists('tasks.jsonl'))) return [];
  return parseJSONL<Task>(await readText('tasks.jsonl'));
}
export async function loadBlocks(): Promise<Block[]> {
  if (!(await exists('blocks.jsonl'))) return [];
  return parseJSONL<Block>(await readText('blocks.jsonl'));
}
export async function saveTasks(tasks: Task[]) {
  await writeText('tasks.jsonl', stringifyJSONL(tasks));
}
export async function saveBlocks(blocks: Block[]) {
  await writeText('blocks.jsonl', stringifyJSONL(blocks));
}

// --- Command executor remains (optional minimal) ---
type ApplyResult = { for: string; ok: boolean; error?: string; effects?: any[] };

export async function applyCommandsFromInbox(filename = 'ai_inbox/commands.jsonl') {
  await ensureDataFolders();
  const tasks = await loadTasks();
  const blocks = await loadBlocks();
  const out: ApplyResult[] = [];

  let raw = '';
  try {
    raw = await readText(filename);
  } catch (e: any) {
    out.push({ for: 'N/A', ok: false, error: `READ_FAIL: ${String(e)}` });
  }

  if (raw) {
    const lines = parseJSONL<AICommandEnvelope>(raw);
    for (const cmd of lines) {
      try {
        const t = (cmd as any).command.type as string;
        const p: any = (cmd as any).command.payload;
        switch (t) {
          case 'create_task': {
            const id = p.task_id ?? nid('tsk');
            tasks.push({
              task_id: id, title: p.title ?? '未命名任务',
              notes: p.notes, priority: p.priority ?? 0, tags: p.tags ?? [],
              created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
              recurrence: p.recurrence ?? null, checklist: p.checklist ?? []
            });
            out.push({ for: (cmd as any).id, ok: true, effects: [{ task_id: id, created: true }] });
            break;
          }
          case 'create_block': {
            const id = p.block_id ?? nid('blk');
            blocks.push({
              block_id: id, task_id: p.task_id, title: p.title,
              start: p.start, end: p.end, status: 'planned', rev: 1
            });
            out.push({ for: (cmd as any).id, ok: true, effects: [{ block_id: id, created: true }] });
            break;
          }
          case 'move_block': {
            const b = blocks.find(x => x.block_id === p.block_id);
            if (!b) throw new Error('NOT_FOUND: block');
            const start = DateTime.fromISO(b.start);
            const end = DateTime.fromISO(b.end);
            const dur = end.diff(start, 'minutes').minutes;
            b.start = p.new_start;
            b.end = DateTime.fromISO(p.new_start).plus({ minutes: dur }).toISO()!;
            b.rev = (b.rev || 0) + 1;
            out.push({ for: (cmd as any).id, ok: true, effects: [{ block_id: b.block_id, new_start: b.start, new_end: b.end }] });
            break;
          }
          case 'resize_block': {
            const b = blocks.find(x => x.block_id === p.block_id);
            if (!b) throw new Error('NOT_FOUND: block');
            b.end = p.new_end;
            b.rev = (b.rev || 0) + 1;
            out.push({ for: (cmd as any).id, ok: true, effects: [{ block_id: b.block_id, new_end: b.end }] });
            break;
          }
          case 'complete_block': {
            const b = blocks.find(x => x.block_id === p.block_id);
            if (!b) throw new Error('NOT_FOUND: block');
            b.status = 'done';
            out.push({ for: (cmd as any).id, ok: true, effects: [{ block_id: b.block_id, status: 'done' }] });
            break;
          }
          case 'update_task': {
            const tsk = tasks.find(x => x.task_id === p.task_id);
            if (!tsk) throw new Error('NOT_FOUND: task');
            Object.assign(tsk, p.patch ?? {});
            out.push({ for: (cmd as any).id, ok: true, effects: [{ task_id: tsk.task_id, patched: true }] });
            break;
          }
          case 'set_recurrence': {
            const tsk = tasks.find(x => x.task_id === p.task_id);
            if (!tsk) throw new Error('NOT_FOUND: task');
            tsk.recurrence = { ...(tsk.recurrence ?? {}), rrule: p.rrule };
            out.push({ for: (cmd as any).id, ok: true, effects: [{ task_id: tsk.task_id, rrule: p.rrule }] });
            break;
          }
          default: {
            out.push({ for: (cmd as any).id, ok: false, error: `UNSUPPORTED: ${t}` });
          }
        }
      } catch (e: any) {
        out.push({ for: (cmd as any)?.id ?? 'N/A', ok: false, error: String(e) });
      }
    }
  }

  await saveTasks(tasks);
  await saveBlocks(blocks);
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  await writeText(`ai_outbox/result_${stamp}.jsonl`, out.map(r => JSON.stringify(r)).join('\n') + '\n');
  return out;
}

// --- Simple update helpers for UI ---
export async function updateTask(task_id: string, patch: Partial<Task>) {
  const tasks = await loadTasks();
  const t = tasks.find(x => x.task_id === task_id);
  if (!t) throw new Error('NOT_FOUND: task');
  Object.assign(t, patch);
  t.updated_at = new Date().toISOString();
  await saveTasks(tasks);
}

export async function updateBlock(block_id: string, patch: Partial<Block>) {
  const blocks = await loadBlocks();
  const b = blocks.find(x => x.block_id === block_id);
  if (!b) throw new Error('NOT_FOUND: block');
  Object.assign(b, patch);
  b.rev = (b.rev || 0) + 1;
  await saveBlocks(blocks);
}

export async function toggleBlockDone(block_id: string) {
  const blocks = await loadBlocks();
  const b = blocks.find(x => x.block_id === block_id);
  if (!b) throw new Error('NOT_FOUND: block');
  b.status = (b.status === 'done') ? 'planned' : 'done';
  await saveBlocks(blocks);
  return b.status;
}

export async function moveBlock(block_id: string, newStartISO: string) {
  const blocks = await loadBlocks();
  const b = blocks.find(x => x.block_id === block_id);
  if (!b) throw new Error('NOT_FOUND: block');
  const start = DateTime.fromISO(b.start);
  const end = DateTime.fromISO(b.end);
  const dur = end.diff(start, 'minutes').minutes;
  b.start = newStartISO;
  b.end = DateTime.fromISO(newStartISO).plus({ minutes: dur }).toISO()!;
  b.rev = (b.rev || 0) + 1;
  await saveBlocks(blocks);
}

export async function resizeBlock(block_id: string, newEndISO: string) {
  const blocks = await loadBlocks();
  const b = blocks.find(x => x.block_id === block_id);
  if (!b) throw new Error('NOT_FOUND: block');
  b.end = newEndISO;
  b.rev = (b.rev || 0) + 1;
  await saveBlocks(blocks);
}
