import { useEffect, useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { ensureDataFolders, readText, writeText } from './lib/fs';
import { parseJSONL, type Block, type Task, type BlockRecurrence } from './lib/data';
import {
  applyCommandsFromInbox,
  toggleBlockDone,
  moveBlock as moveBlockCmd,
  resizeBlock as resizeBlockCmd,
  updateTask,
  updateBlock,
  createTask,
  createBlock,
  deleteBlock,
  duplicateBlock,
} from './lib/commands';
import { minutesToTimeString, timeStringToMinutes } from './lib/schedule';
import WeekGrid from './components/WeekGrid';
import DetailsDrawer from './components/DetailsDrawer';
import AIAssistant from './components/AIAssistant';

type Strategy = 'allow'|'block'|'push'|'clip';
type ViewMode = 'week'|'day';
type RepeatMode = 'none'|'daily'|'weekly';

const buttonStyle: React.CSSProperties = { padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff' };

function hashStr(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return h.toString();
}

function defaultWeekStart() {
  return DateTime.now().startOf('week').plus({ days: 1 });
}

function makeRecurrenceId() {
  return `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function isWithinSleep(startMinutes: number, sleepStart: string, sleepEnd: string) {
  const start = timeStringToMinutes(sleepStart);
  const end = timeStringToMinutes(sleepEnd);
  if (start === end) return false;
  if (start < end) {
    return startMinutes >= start && startMinutes < end;
  }
  return startMinutes >= start || startMinutes < end;
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [weekStart, setWeekStart] = useState(defaultWeekStart);
  const [focusDate, setFocusDate] = useState(DateTime.now());
  const [viewMode, setViewMode] = useState<ViewMode>('week');
  const [message, setMessage] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [autoApply, setAutoApply] = useState(true);
  const [lastSig, setLastSig] = useState('');
  const [strategy, setStrategy] = useState<Strategy>(() => (localStorage.getItem('overlapStrategy') as Strategy) || 'allow');
  const [statusFilter, setStatusFilter] = useState<'all'|'planned'|'in_progress'|'done'|'skipped'>('all');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [showQuick, setShowQuick] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskTags, setNewTaskTags] = useState('');
  const [blockForm, setBlockForm] = useState({
    title: '',
    taskId: '',
    notes: '',
    dateISO: DateTime.now().toISODate()!,
    startTime: '09:00',
    duration: 60,
    repeat: 'none' as RepeatMode,
    weeklyDays: [DateTime.now().weekday],
    interval: 1,
  });
  const [sleepStart, setSleepStart] = useState(() => localStorage.getItem('sleepStart') || '23:00');
  const [sleepEnd, setSleepEnd] = useState(() => localStorage.getItem('sleepEnd') || '07:00');
  const [aiOpen, setAiOpen] = useState(false);

  useEffect(() => { localStorage.setItem('overlapStrategy', strategy); }, [strategy]);
  useEffect(() => { localStorage.setItem('sleepStart', sleepStart); }, [sleepStart]);
  useEffect(() => { localStorage.setItem('sleepEnd', sleepEnd); }, [sleepEnd]);

  async function reload() {
    await ensureDataFolders();
    try {
      const t = await readText('tasks.jsonl').catch(() => '');
      const b = await readText('blocks.jsonl').catch(() => '');
      setTasks(t ? parseJSONL<Task>(t) : []);
      setBlocks(b ? parseJSONL<Block>(b) : []);
    } catch (e) {
      console.error('读取数据失败', e);
      setMessage('读取数据失败，请检查日志');
    }
  }

  useEffect(() => { reload(); }, []);

  useEffect(() => {
    if (viewMode === 'week') {
      const end = weekStart.plus({ days: 6 });
      if (focusDate < weekStart || focusDate > end) {
        setFocusDate(weekStart);
      }
    }
  }, [viewMode, weekStart, focusDate]);

  const selectedBlock = useMemo(() => blocks.find(x => x.block_id === (selectedId ?? '')) ?? null, [blocks, selectedId]);
  const selectedTask = useMemo(() => tasks.find(x => x.task_id === selectedBlock?.task_id) ?? null, [tasks, selectedBlock]);

  const taskMap = useMemo(() => {
    const map = new Map<string, Task>();
    for (const t of tasks) map.set(t.task_id, t);
    return map;
  }, [tasks]);

  const availableTags = useMemo(() => {
    const set = new Set<string>();
    tasks.forEach(t => (t.tags ?? []).forEach(tag => set.add(tag)));
    return Array.from(set).sort();
  }, [tasks]);

  const visibleDays = useMemo(() => {
    if (viewMode === 'week') {
      return Array.from({ length: 7 }, (_, i) => weekStart.plus({ days: i }).toISODate()!);
    }
    return [focusDate.toISODate()!];
  }, [viewMode, weekStart, focusDate]);

  const filteredBlocks = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return blocks.filter(b => {
      if (statusFilter !== 'all' && b.status !== statusFilter) return false;
      if (tagFilter !== 'all') {
        const t = b.task_id ? taskMap.get(b.task_id) : undefined;
        if (!t || !(t.tags ?? []).includes(tagFilter)) return false;
      }
      if (term) {
        const t = b.task_id ? taskMap.get(b.task_id) : undefined;
        const label = (b.title ?? t?.title ?? '').toLowerCase();
        const notes = (b.notes_override ?? t?.notes ?? '').toLowerCase();
        if (!label.includes(term) && !notes.includes(term)) return false;
      }
      return true;
    });
  }, [blocks, taskMap, statusFilter, tagFilter, searchTerm]);

  const visibleCount = useMemo(() => {
    const daySet = new Set(visibleDays);
    return filteredBlocks.filter(b => daySet.has(DateTime.fromISO(b.start).toISODate()!)).length;
  }, [filteredBlocks, visibleDays]);

  const rangeLabel = useMemo(() => {
    if (viewMode === 'week') {
      const end = weekStart.plus({ days: 6 });
      return `${weekStart.toFormat('LL月dd日')} - ${end.toFormat('LL月dd日')}`;
    }
    return focusDate.toFormat('yyyy-LL-dd ccc');
  }, [viewMode, weekStart, focusDate]);

  async function onApplyCommands() {
    setMessage('应用命令中…');
    const raw = await readText('ai_inbox/commands.jsonl').catch(() => '');
    const sig = raw ? `${raw.length}:${hashStr(raw)}` : '';
    if (sig && sig === lastSig) {
      setMessage('已是最新命令，跳过。');
      return;
    }
    const result = await applyCommandsFromInbox('ai_inbox/commands.jsonl');
    if (sig) {
      await writeText('ai_outbox/last_sig.txt', sig);
      setLastSig(sig);
    }
    setMessage(`完成：${result.filter(r => r.ok).length} 成功，${result.filter(r => !r.ok).length} 失败`);
    await reload();
  }

  useEffect(() => {
    if (!autoApply) return;
    const timer = setInterval(async () => {
      try {
        const raw = await readText('ai_inbox/commands.jsonl');
        const sig = raw ? `${raw.length}:${hashStr(raw)}` : '';
        if (sig && sig !== lastSig) {
          const result = await applyCommandsFromInbox('ai_inbox/commands.jsonl');
          await writeText('ai_outbox/last_sig.txt', sig);
          setLastSig(sig);
          setMessage(`自动应用：${result.filter(r => r.ok).length} 成功，${result.filter(r => !r.ok).length} 失败`);
          await reload();
        }
      } catch {
        /* ignore */
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [autoApply, lastSig]);

  const selectedBlockTask = useMemo(() => ({ block: selectedBlock, task: selectedTask }), [selectedBlock, selectedTask]);

  async function handleToggle(block_id: string) {
    const status = await toggleBlockDone(block_id);
    setMessage(status === 'done' ? '已标记完成' : '已恢复为未完成');
    await reload();
  }

  async function handleMove(block_id: string, newStartISO: string) {
    await moveBlockCmd(block_id, newStartISO);
    await reload();
  }

  async function handleResize(block_id: string, newEndISO: string) {
    await resizeBlockCmd(block_id, newEndISO);
    await reload();
  }

  async function handleDuplicate(block_id: string) {
    await duplicateBlock(block_id);
    setMessage('已复制一个块');
    await reload();
  }

  async function handleDelete(block_id: string, scope: 'single'|'series') {
    await deleteBlock(block_id, scope);
    setMessage(scope === 'series' ? '已删除整个重复系列' : '已删除块');
    await reload();
  }

  async function handleSaveTask(changes: Partial<Task>) {
    if (!selectedTask) return;
    await updateTask(selectedTask.task_id, changes);
    await reload();
  }

  async function handleSaveBlock(changes: Partial<Block>) {
    if (!selectedBlock) return;
    await updateBlock(selectedBlock.block_id, changes);
    await reload();
  }

  async function handleCreateTask() {
    if (!newTaskTitle.trim()) {
      setMessage('请填写任务标题');
      return;
    }
    const tags = newTaskTags.split(',').map(t => t.trim()).filter(Boolean);
    await createTask({ title: newTaskTitle.trim(), tags });
    setNewTaskTitle('');
    setNewTaskTags('');
    setMessage('任务已创建');
    await reload();
  }

  function openBlockForm(dateISO?: string, startMinutes?: number, endMinutes?: number) {
    setShowQuick(true);
    const date = dateISO ?? DateTime.now().toISODate()!;
    const start = startMinutes ?? timeStringToMinutes('09:00');
    const end = endMinutes ?? start + 60;
    const duration = Math.max(15, end - start);
    setBlockForm(prev => ({
      ...prev,
      dateISO: date,
      startTime: minutesToTimeString(start),
      duration,
      repeat: prev.repeat,
      weeklyDays: [DateTime.fromISO(date).weekday],
    }));
  }

  async function handleCreateBlock() {
    if (!blockForm.title.trim() && !blockForm.taskId) {
      setMessage('请填写块标题或选择关联任务');
      return;
    }
    const date = DateTime.fromISO(blockForm.dateISO);
    const startMinute = timeStringToMinutes(blockForm.startTime);
    const duration = Math.max(15, Number(blockForm.duration) || 0);
    const start = date.set({ hour: Math.floor(startMinute / 60), minute: startMinute % 60, second: 0, millisecond: 0 });
    if (!start.isValid) {
      setMessage('请选择有效的日期和时间');
      return;
    }
    const end = start.plus({ minutes: duration });
    let recurrence: BlockRecurrence | null = null;
    if (blockForm.repeat === 'daily') {
      recurrence = {
        id: makeRecurrenceId(),
        type: 'daily',
        interval: Math.max(1, Number(blockForm.interval) || 1),
        startDate: date.toISODate()!,
        startMinute,
        duration,
      };
    } else if (blockForm.repeat === 'weekly') {
      const days = blockForm.weeklyDays.length ? blockForm.weeklyDays : [date.weekday];
      recurrence = {
        id: makeRecurrenceId(),
        type: 'weekly',
        interval: Math.max(1, Number(blockForm.interval) || 1),
        daysOfWeek: Array.from(new Set(days)).sort(),
        startDate: date.toISODate()!,
        startMinute,
        duration,
      };
    }

    await createBlock({
      task_id: blockForm.taskId || undefined,
      title: blockForm.title.trim() || undefined,
      notes_override: blockForm.notes.trim() || undefined,
      start: start.toISO()!,
      end: end.toISO()!,
      recurrence,
    });

    const sleepWarn = isWithinSleep(startMinute, sleepStart, sleepEnd);
    setBlockForm(prev => ({
      ...prev,
      title: '',
      taskId: '',
      notes: '',
      repeat: 'none',
      weeklyDays: [DateTime.now().weekday],
      interval: 1,
    }));
    setMessage(sleepWarn ? '已创建块（注意：位于睡眠时段）' : '已创建块');
    await reload();
  }

  const quickPanel = showQuick ? (
    <div style={{ display: 'grid', gap: 12, paddingTop: 8, borderTop: '1px dashed #e5e7eb' }}>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        <form
          onSubmit={async (e) => { e.preventDefault(); await handleCreateTask(); }}
          style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, background: '#fafafa' }}
        >
          <h4 style={{ margin: '0 0 8px 0' }}>新建任务</h4>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            标题
            <input value={newTaskTitle} onChange={e => setNewTaskTitle(e.target.value)} style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6 }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, marginTop: 8 }}>
            标签（逗号分隔）
            <input value={newTaskTags} onChange={e => setNewTaskTags(e.target.value)} style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6 }} />
          </label>
          <button type="submit" style={{ ...buttonStyle, marginTop: 12 }}>创建任务</button>
        </form>

        <form
          onSubmit={async (e) => { e.preventDefault(); await handleCreateBlock(); }}
          style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, background: '#fafafa', display: 'grid', gap: 8 }}
        >
          <h4 style={{ margin: '0 0 8px 0' }}>新建日程块</h4>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            标题（可留空以继承任务）
            <input value={blockForm.title} onChange={e => setBlockForm(prev => ({ ...prev, title: e.target.value }))} style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6 }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            关联任务
            <select value={blockForm.taskId} onChange={e => setBlockForm(prev => ({ ...prev, taskId: e.target.value }))} style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6 }}>
              <option value="">（不关联）</option>
              {tasks.map(t => (
                <option key={t.task_id} value={t.task_id}>{t.title}</option>
              ))}
            </select>
          </label>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', fontSize: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              日期
              <input type="date" value={blockForm.dateISO} onChange={e => setBlockForm(prev => ({ ...prev, dateISO: e.target.value }))} style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              开始时间
              <input type="time" value={blockForm.startTime} onChange={e => setBlockForm(prev => ({ ...prev, startTime: e.target.value }))} style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              时长（分钟）
              <input type="number" min={15} step={15} value={blockForm.duration} onChange={e => setBlockForm(prev => ({ ...prev, duration: Number(e.target.value) }))} style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6 }} />
            </label>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            备注（仅此块）
            <textarea value={blockForm.notes} onChange={e => setBlockForm(prev => ({ ...prev, notes: e.target.value }))} style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, minHeight: 60 }} />
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              重复
              <select value={blockForm.repeat} onChange={e => setBlockForm(prev => ({ ...prev, repeat: e.target.value as RepeatMode }))} style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6 }}>
                <option value="none">不重复</option>
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
              </select>
            </label>
            {(blockForm.repeat === 'daily' || blockForm.repeat === 'weekly') && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                间隔
                <input type="number" min={1} value={blockForm.interval} onChange={e => setBlockForm(prev => ({ ...prev, interval: Number(e.target.value) }))} style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, width: 100 }} />
              </label>
            )}
          </div>
          {blockForm.repeat === 'weekly' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 12 }}>
              {[1,2,3,4,5,6,7].map(d => {
                const names = ['一','二','三','四','五','六','日'];
                const checked = blockForm.weeklyDays.includes(d);
                return (
                  <label key={d} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={e => {
                        setBlockForm(prev => {
                          const set = new Set(prev.weeklyDays);
                          if (e.target.checked) set.add(d); else set.delete(d);
                          const arr = Array.from(set);
                          return { ...prev, weeklyDays: arr.length ? arr : [DateTime.fromISO(prev.dateISO).weekday] };
                        });
                      }}
                    />
                    周{names[d-1]}
                  </label>
                );
              })}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            <button type="submit" style={buttonStyle}>创建块</button>
            <button type="button" style={buttonStyle} onClick={() => setBlockForm(prev => ({ ...prev, title: '', taskId: '', notes: '', repeat: 'none' }))}>清空</button>
          </div>
        </form>
      </div>
    </div>
  ) : null;

  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto auto 1fr', height: '100vh', background: '#fff' }}>
      <div style={{ borderBottom: '1px solid #e5e7eb', padding: '8px 12px', display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button style={buttonStyle} onClick={() => {
              if (viewMode === 'week') setWeekStart(weekStart.minus({ weeks: 1 }));
              else setFocusDate(focusDate.minus({ days: 1 }));
            }}>◀</button>
            <div style={{ fontWeight: 600 }}>{rangeLabel}</div>
            <button style={buttonStyle} onClick={() => {
              if (viewMode === 'week') setWeekStart(weekStart.plus({ weeks: 1 }));
              else setFocusDate(focusDate.plus({ days: 1 }));
            }}>▶</button>
            <button style={buttonStyle} onClick={() => { setWeekStart(defaultWeekStart()); setFocusDate(DateTime.now()); }}>回到今天</button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              视图
              <select value={viewMode} onChange={e => setViewMode(e.target.value as ViewMode)} style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6 }}>
                <option value="week">周视图</option>
                <option value="day">日视图</option>
              </select>
            </label>
            {viewMode === 'day' && (
              <input type="date" value={focusDate.toISODate()!} onChange={e => setFocusDate(DateTime.fromISO(e.target.value))} style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6 }} />
            )}
            <div style={{ fontSize: 12, opacity: 0.8 }}>任务：{tasks.length} · 块：{blocks.length} · 筛选后：{filteredBlocks.length} · 当前视图：{visibleCount}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button style={buttonStyle} onClick={() => setAiOpen(true)}>AI 助手</button>
            <button style={buttonStyle} onClick={onApplyCommands}>应用命令</button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
              <input type="checkbox" checked={autoApply} onChange={e => setAutoApply(e.target.checked)} />
              自动监听
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              重叠策略
              <select value={strategy} onChange={e => setStrategy(e.target.value as Strategy)} style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6 }}>
                <option value="allow">允许</option>
                <option value="block">禁止</option>
                <option value="push">顺延</option>
                <option value="clip">裁剪</option>
              </select>
            </label>
          </div>
        </div>
        <div style={{ fontSize: 12, color: '#2563eb', minHeight: 16 }}>{message}</div>
      </div>

      <div style={{ borderBottom: '1px solid #e5e7eb', padding: '8px 12px', display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            状态
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)} style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6 }}>
              <option value="all">全部</option>
              <option value="planned">planned</option>
              <option value="in_progress">in_progress</option>
              <option value="done">done</option>
              <option value="skipped">skipped</option>
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            标签
            <select value={tagFilter} onChange={e => setTagFilter(e.target.value)} style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6 }}>
              <option value="all">全部</option>
              {availableTags.map(tag => (
                <option key={tag} value={tag}>{tag}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            搜索
            <input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="标题或备注" style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6 }} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            睡眠开始
            <input type="time" value={sleepStart} onChange={e => setSleepStart(e.target.value)} style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6 }} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            睡眠结束
            <input type="time" value={sleepEnd} onChange={e => setSleepEnd(e.target.value)} style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6 }} />
          </label>
          <button style={buttonStyle} onClick={() => openBlockForm()}>新建块</button>
          <button style={buttonStyle} onClick={() => setShowQuick(v => !v)}>{showQuick ? '隐藏快速面板' : '显示快速面板'}</button>
        </div>
        {quickPanel}
      </div>

      <div style={{ position: 'relative' }}>
        <WeekGrid
          weekStartISO={weekStart.toISODate()!}
          tasks={tasks}
          blocks={filteredBlocks}
          visibleDays={visibleDays}
          onMove={handleMove}
          onResize={handleResize}
          onToggle={handleToggle}
          onSelect={id => setSelectedId(id)}
          onDuplicate={handleDuplicate}
          onDelete={handleDelete}
          onRequestCreate={({ dayISO, startMinutes, endMinutes }) => {
            
            openBlockForm(dayISO, startMinutes, endMinutes);
          }}
          strategy={strategy}
          onNotify={msg => setMessage(msg)}
          sleepRange={{ start: sleepStart, end: sleepEnd }}
        />
      </div>

      <DetailsDrawer
        open={!!selectedBlockTask.block}
        block={selectedBlockTask.block}
        task={selectedBlockTask.task}
        onClose={() => setSelectedId(null)}
        onSaveTask={handleSaveTask}
        onSaveBlock={handleSaveBlock}
        onToggleDone={async () => { if (selectedBlock) { await handleToggle(selectedBlock.block_id); } }}
      />

      <AIAssistant
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        tasks={tasks}
        blocks={blocks}
        onCommandsSaved={async () => {
          setMessage('已写入 AI 命令，请在工具栏中应用。');
          await reload();
        }}
      />
    </div>
  );
}
