// src/App.tsx (add overlap strategy switch + notification passthrough)
import { useEffect, useState, useMemo } from 'react';
import { DateTime } from 'luxon';
import { ensureDataFolders, readText, writeText } from './lib/fs';
import { parseJSONL, type Block, type Task } from './lib/data';
import { applyCommandsFromInbox, toggleBlockDone, moveBlock as moveBlockCmd, resizeBlock as resizeBlockCmd, updateTask, updateBlock } from './lib/commands';
import WeekGrid from './components/WeekGrid';
import DetailsDrawer from './components/DetailsDrawer';

type Strategy = 'allow'|'block'|'push'|'clip';

function hashStr(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
  return h.toString();
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [weekStart, setWeekStart] = useState(
    DateTime.now().startOf('week').plus({ days: 1 })
  );
  const [message, setMessage] = useState('');
  const [selectedId, setSelectedId] = useState<string| null>(null);

  // 自动监听
  const [autoApply, setAutoApply] = useState(true);
  const [lastSig, setLastSig] = useState<string>('');

  // 重叠策略
  const [strategy, setStrategy] = useState<Strategy>(() => (localStorage.getItem('overlapStrategy') as Strategy) || 'allow');
  useEffect(()=>{ localStorage.setItem('overlapStrategy', strategy); }, [strategy]);

  async function reload() {
    await ensureDataFolders();
    try {
      const t = await readText('tasks.jsonl');
      const b = await readText('blocks.jsonl');
      setTasks(parseJSONL<Task>(t));
      setBlocks(parseJSONL<Block>(b));
    } catch (e) {
      console.error('读取数据失败', e);
    }
  }

  // 读取上次签名（避免重复应用）
  useEffect(() => {
    (async () => {
      try {
        const sig = await readText('ai_outbox/last_sig.txt');
        setLastSig(sig.trim());
      } catch {}
    })();
  }, []);

  useEffect(() => { reload(); }, []);

  const selectedBlock = useMemo(()=> blocks.find(x => x.block_id === (selectedId ?? '')), [blocks, selectedId]);
  const selectedTask = useMemo(()=> tasks.find(x => x.task_id === selectedBlock?.task_id), [tasks, selectedBlock]);

  async function onApplyCommands() {
    setMessage('应用命令中…');
    const raw = await readText('ai_inbox/commands.jsonl').catch(()=>'');
    const sig = raw ? (raw.length + ':' + hashStr(raw)) : '';
    if (sig && sig === lastSig) {
      setMessage('已是最新命令，跳过。');
      return;
    }
    const result = await applyCommandsFromInbox('ai_inbox/commands.jsonl');
    if (sig) {
      await writeText('ai_outbox/last_sig.txt', sig);
      setLastSig(sig);
    }
    setMessage(`完成：${result.filter(r=>r.ok).length} 成功，${result.filter(r=>!r.ok).length} 失败`);
    await reload();
  }

  // 轮询监听 ai_inbox/commands.jsonl
  useEffect(() => {
    if (!autoApply) return;
    const timer = setInterval(async () => {
      try {
        const raw = await readText('ai_inbox/commands.jsonl');
        const sig = raw ? (raw.length + ':' + hashStr(raw)) : '';
        if (sig && sig !== lastSig) {
          const result = await applyCommandsFromInbox('ai_inbox/commands.jsonl');
          await writeText('ai_outbox/last_sig.txt', sig);
          setLastSig(sig);
          setMessage(`自动应用：${result.filter(r=>r.ok).length} 成功，${result.filter(r=>!r.ok).length} 失败`);
          await reload();
        }
      } catch { /* 文件不存在则忽略 */ }
    }, 3000);
    return () => clearInterval(timer);
  }, [autoApply, lastSig]);

  return (
    <div style={{display:'grid', gridTemplateRows:'auto 1fr', height:'100vh'}}>
      <div style={{borderBottom:'1px solid #e5e7eb', padding:8, display:'flex', alignItems:'center', gap:8, fontSize:12}}>
        <button style={{padding:'4px 8px', border:'1px solid #d1d5db', borderRadius:6}} onClick={()=>setWeekStart(DateTime.now().startOf('week').plus({days:1}))}>回到本周</button>
        <div>任务数：{tasks.length}</div>
        <div>块数：{blocks.length}</div>
        <button style={{padding:'4px 8px', border:'1px solid #d1d5db', borderRadius:6}} onClick={onApplyCommands}>应用 ai_inbox/commands.jsonl</button>
        <label style={{display:'flex', alignItems:'center', gap:4}}>
          <input type="checkbox" checked={autoApply} onChange={e=>setAutoApply(e.target.checked)} />
          自动监听 ai_inbox
        </label>
        <label style={{display:'flex', alignItems:'center', gap:6}}>
          <span>重叠策略</span>
          <select value={strategy} onChange={e=>setStrategy(e.target.value as Strategy)} style={{padding:'4px 8px', border:'1px solid #d1d5db', borderRadius:6}}>
            <option value="allow">允许重叠</option>
            <option value="block">禁止保存</option>
            <option value="push">自动顺延</option>
            <option value="clip">自动裁剪</option>
          </select>
        </label>
        <div style={{opacity:0.7}}>{message}</div>
      </div>
      <WeekGrid
        weekStartISO={weekStart.toISODate()!}
        tasks={tasks}
        blocks={blocks}
        onMove={async (id, ns) => { await moveBlockCmd(id, ns); await reload(); }}
        onResize={async (id, ne) => { await resizeBlockCmd(id, ne); await reload(); }}
        onToggle={async (id) => { await toggleBlockDone(id); await reload(); }}
        onSelect={(id)=> setSelectedId(id)}
        strategy={strategy}
        onNotify={(msg)=> setMessage(msg)}
      />
      <DetailsDrawer
        open={!!selectedBlock}
        block={selectedBlock}
        task={selectedTask ?? null}
        onClose={()=> setSelectedId(null)}
        onToggleDone={async ()=>{ if (selectedBlock) { await toggleBlockDone(selectedBlock.block_id); await reload(); } }}
        onSaveBlock={async (changes)=>{ if (selectedBlock) { await updateBlock(selectedBlock.block_id, changes); await reload(); } }}
        onSaveTask={async (changes)=>{ if (selectedTask) { await updateTask(selectedTask.task_id, changes); await reload(); } }}
      />
    </div>
  );
}
