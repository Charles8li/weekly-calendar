// src/lib/commands.ts
import { ensureDataFolders, readText, writeText, exists } from './fs';
import { parseJSONL, stringifyJSONL, type Task, type Block, type BlockRecurrence, type AICommandEnvelope } from './data';
import { DateTime } from 'luxon';

function nid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;
}

export async function loadTasks(): Promise<Task[]> {
  if (!(await exists('tasks.jsonl'))) return [];
  return parseJSONL<Task>(await readText('tasks.jsonl'));
}
function cloneRecurrence(rec?: BlockRecurrence | null): BlockRecurrence | null | undefined {
  if (!rec) return rec;
  return {
    id: rec.id,
    type: rec.type,
    interval: rec.interval,
    daysOfWeek: rec.daysOfWeek ? [...rec.daysOfWeek] : undefined,
    startDate: rec.startDate,
    startMinute: rec.startMinute,
    duration: rec.duration,
    until: rec.until ?? null,
    exceptions: rec.exceptions ? [...rec.exceptions] : undefined,
  };
}

function ensureExceptions(rec: BlockRecurrence | null | undefined) {
  if (rec && !rec.exceptions) rec.exceptions = [];
  return rec;
}

function shouldIncludeDate(rec: BlockRecurrence, date: DateTime) {
  const anchor = DateTime.fromISO(rec.startDate);
  if (!anchor.isValid) return false;
  const limit = rec.until ? DateTime.fromISO(rec.until) : null;
  if (limit && date.startOf('day') > limit.endOf('day')) return false;
  if (date < anchor) return false;
  const exceptions = rec.exceptions ?? [];
  if (exceptions.includes(date.toISODate()!)) return false;
  if (rec.type === 'daily') {
    const diff = Math.floor(date.startOf('day').diff(anchor.startOf('day'), 'days').days);
    return diff >= 0 && diff % Math.max(1, rec.interval) === 0;
  }
  const days = rec.daysOfWeek && rec.daysOfWeek.length ? rec.daysOfWeek : [anchor.weekday];
  if (!days.includes(date.weekday)) return false;
  const diffWeeks = Math.floor(date.startOf('week').diff(anchor.startOf('week'), 'weeks').weeks);
  return diffWeeks >= 0 && diffWeeks % Math.max(1, rec.interval) === 0;
}

function setRecurrenceAnchor(rec: BlockRecurrence, anchor: DateTime) {
  rec.startDate = anchor.toISODate()!;
  rec.startMinute = anchor.hour * 60 + anchor.minute;
}

function extendRecurringBlocks(blocks: Block[]) {
  const byId = new Map<string, { rec: BlockRecurrence; blocks: Block[] }>();
  for (const blk of blocks) {
    if (blk.recurrence?.id) {
      const id = blk.recurrence.id;
      if (!byId.has(id)) {
        byId.set(id, { rec: cloneRecurrence(blk.recurrence)!, blocks: [] });
      }
      byId.get(id)!.blocks.push(blk);
    }
  }
  if (!byId.size) return false;
  let mutated = false;
  const horizon = DateTime.now().plus({ days: 35 }).startOf('day');
  for (const [, data] of byId) {
    const { rec } = data;
    const existingByDate = new Map<string, Block>();
    for (const blk of data.blocks) {
      existingByDate.set(DateTime.fromISO(blk.start).toISODate()!, blk);
    }
    const anchor = DateTime.fromISO(rec.startDate);
    if (!anchor.isValid) continue;
    let cursor = anchor.startOf('day');
    const limitStart = DateTime.now().minus({ days: 7 }).startOf('day');
    if (cursor < limitStart) cursor = limitStart;
    while (cursor <= horizon) {
      if (shouldIncludeDate(rec, cursor)) {
        const isoDate = cursor.toISODate()!;
        if (!existingByDate.has(isoDate)) {
          const start = cursor.plus({ minutes: rec.startMinute });
          const end = start.plus({ minutes: rec.duration });
          const block: Block = {
            block_id: nid('blk'),
            task_id: data.blocks[0]?.task_id,
            title: data.blocks[0]?.title,
            notes_override: data.blocks[0]?.notes_override,
            start: start.toISO()!,
            end: end.toISO()!,
            status: 'planned',
            rev: 1,
            recurrence: cloneRecurrence(rec),
          };
          blocks.push(block);
          data.blocks.push(block);
          existingByDate.set(isoDate, block);
          mutated = true;
        }
      }
      cursor = cursor.plus({ days: 1 });
    }
    if (rec.until) {
      const limit = DateTime.fromISO(rec.until);
      if (limit.isValid) {
        for (const blk of data.blocks) {
          if (DateTime.fromISO(blk.start) > limit.endOf('day')) {
            // remove blocks beyond until
            const idx = blocks.indexOf(blk);
            if (idx >= 0) {
              blocks.splice(idx, 1);
              mutated = true;
            }
          }
        }
      }
    }
  }
  return mutated;
}

export async function loadBlocks(): Promise<Block[]> {
  if (!(await exists('blocks.jsonl'))) return [];
  const blocks = parseJSONL<Block>(await readText('blocks.jsonl'));
  const mutated = extendRecurringBlocks(blocks);
  if (mutated) {
    await saveBlocks(blocks);
  }
  return blocks;
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
              start: p.start, end: p.end, status: 'planned', rev: 1,
              recurrence: p.recurrence ? cloneRecurrence(p.recurrence) : null,
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

  if (b.recurrence?.id) {
    const recId = b.recurrence.id;
    const delta = DateTime.fromISO(newStartISO).diff(start, 'minutes').minutes;
    const newDur = DateTime.fromISO(b.end).diff(DateTime.fromISO(b.start), 'minutes').minutes;
    const anchor = DateTime.fromISO(b.recurrence.startDate).plus({ minutes: b.recurrence.startMinute }).plus({ minutes: delta });
    setRecurrenceAnchor(b.recurrence, anchor);
    b.recurrence.duration = newDur;
    for (const other of blocks) {
      if (other.block_id === block_id) continue;
      if (other.recurrence?.id === recId && other.status !== 'done') {
        const os = DateTime.fromISO(other.start).plus({ minutes: delta });
        const oe = DateTime.fromISO(other.end).plus({ minutes: delta });
        other.start = os.toISO()!;
        other.end = oe.toISO()!;
        other.recurrence = cloneRecurrence(b.recurrence);
        other.rev = (other.rev || 0) + 1;
      }
    }
  }
  await saveBlocks(blocks);
}

export async function resizeBlock(block_id: string, newEndISO: string) {
  const blocks = await loadBlocks();
  const b = blocks.find(x => x.block_id === block_id);
  if (!b) throw new Error('NOT_FOUND: block');
  b.end = newEndISO;
  b.rev = (b.rev || 0) + 1;

  if (b.recurrence?.id) {
    const recId = b.recurrence.id;
    const start = DateTime.fromISO(b.start);
    const newDur = DateTime.fromISO(newEndISO).diff(start, 'minutes').minutes;
    b.recurrence.duration = newDur;
    for (const other of blocks) {
      if (other.block_id === block_id) continue;
      if (other.recurrence?.id === recId && other.status !== 'done') {
        const os = DateTime.fromISO(other.start);
        other.end = os.plus({ minutes: newDur }).toISO()!;
        other.recurrence = cloneRecurrence(b.recurrence);
        other.rev = (other.rev || 0) + 1;
      }
    }
  }
  await saveBlocks(blocks);
}

export async function createTask(data: { title: string; notes?: string; tags?: string[]; priority?: 0|1|2 }) {
  const tasks = await loadTasks();
  const id = nid('tsk');
  tasks.push({
    task_id: id,
    title: data.title,
    notes: data.notes,
    tags: data.tags ?? [],
    priority: data.priority ?? 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    recurrence: null,
  });
  await saveTasks(tasks);
  return id;
}

export async function createBlock(data: { task_id?: string; title?: string; notes_override?: string; start: string; end: string; recurrence?: BlockRecurrence | null }) {
  const blocks = await loadBlocks();
  const block: Block = {
    block_id: nid('blk'),
    task_id: data.task_id,
    title: data.title,
    notes_override: data.notes_override,
    start: data.start,
    end: data.end,
    status: 'planned',
    rev: 1,
    recurrence: data.recurrence ? cloneRecurrence(data.recurrence) : null,
  };
  blocks.push(block);
  await saveBlocks(blocks);
  return block.block_id;
}

export async function deleteBlock(block_id: string, scope: 'single'|'series' = 'single') {
  const blocks = await loadBlocks();
  const idx = blocks.findIndex(b => b.block_id === block_id);
  if (idx < 0) throw new Error('NOT_FOUND: block');
  const blk = blocks[idx];
  if (scope === 'series' && blk.recurrence?.id) {
    const recId = blk.recurrence.id;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].recurrence?.id === recId) {
        blocks.splice(i, 1);
      }
    }
  } else if (blk.recurrence?.id) {
    const recId = blk.recurrence.id;
    const dateISO = DateTime.fromISO(blk.start).toISODate();
    blocks.splice(idx, 1);
    const others = blocks.filter(b => b.recurrence?.id === recId);
    if (others.length) {
      const rec = ensureExceptions(others[0].recurrence);
      if (rec && dateISO && !(rec.exceptions ?? []).includes(dateISO)) {
        rec.exceptions!.push(dateISO);
      }
      for (const other of others) {
        other.recurrence = cloneRecurrence(rec ?? other.recurrence);
        other.rev = (other.rev || 0) + 1;
      }
    }
  } else {
    blocks.splice(idx, 1);
  }
  await saveBlocks(blocks);
}

export async function duplicateBlock(block_id: string) {
  const blocks = await loadBlocks();
  const blk = blocks.find(b => b.block_id === block_id);
  if (!blk) throw new Error('NOT_FOUND: block');
  const start = DateTime.fromISO(blk.start);
  const end = DateTime.fromISO(blk.end);
  const copy: Block = {
    block_id: nid('blk'),
    task_id: blk.task_id,
    title: blk.title,
    notes_override: blk.notes_override,
    start: start.toISO()!,
    end: end.toISO()!,
    status: blk.status,
    rev: 1,
    recurrence: null,
  };
  blocks.push(copy);
  await saveBlocks(blocks);
  return copy.block_id;
}
