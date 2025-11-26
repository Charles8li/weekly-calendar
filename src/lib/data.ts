// src/lib/data.ts
export type BlockStatus = 'planned'|'in_progress'|'done'|'skipped';

export type BlockRecurrence = {
  id: string;
  type: 'daily'|'weekly';
  interval: number;
  daysOfWeek?: number[];
  startDate: string;      // ISO date of the first occurrence
  startMinute: number;    // minutes since midnight
  duration: number;       // duration minutes
  until?: string | null;  // optional ISO date limit
  exceptions?: string[];  // ISO dates to skip
};

export type Block = {
  block_id: string;
  task_id?: string;
  title?: string;           // block 级别标题（可覆盖任务标题）
  notes_override?: string;  // block 级别备注覆盖
  start: string;
  end: string;
  status: BlockStatus;
  rev: number;
  recurrence?: BlockRecurrence | null;
};

export type ChecklistItem = { id: string; text: string; done: boolean };

export type Task = {
  task_id: string;
  title: string;
  notes?: string;
  checklist?: ChecklistItem[];
  priority?: 0|1|2;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
  recurrence?: any | null;
};

export function parseJSONL<T=any>(text: string): T[] {
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

export function stringifyJSONL<T=any>(rows: T[]): string {
  return rows.map(r => JSON.stringify(r)).join('\n') + '\n';
}

// AI command envelope (简化版)
export type AICommandEnvelope =
  | { id: string; actor: 'ai'|'human'; issued_at: string; command:
      { type: 'create_task'; payload: any } }
  | { id: string; actor: 'ai'|'human'; issued_at: string; command:
      { type: 'create_block'; payload: any } }
  | { id: string; actor: 'ai'|'human'; issued_at: string; command:
      { type: 'move_block'; payload: { block_id: string; new_start: string } } }
  | { id: string; actor: 'ai'|'human'; issued_at: string; command:
      { type: 'resize_block'; payload: { block_id: string; new_end: string } } }
  | { id: string; actor: 'ai'|'human'; issued_at: string; command:
      { type: 'complete_block'; payload: { block_id: string } } }
  | { id: string; actor: 'ai'|'human'; issued_at: string; command:
      { type: 'update_task'; payload: { task_id: string; patch: any; rev?: number } } }
  | { id: string; actor: 'ai'|'human'; issued_at: string; command:
      { type: 'set_recurrence'; payload: { task_id: string; rrule: string } } }
  | { id: string; actor: 'ai'|'human'; issued_at: string; command:
      { type: 'add_checklist_item' | 'set_checklist_state'; payload: any } };
