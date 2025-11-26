// src/components/DetailsDrawer.tsx
import React, { useEffect, useState } from 'react';
import type { Block, Task, ChecklistItem } from '../lib/data';
import { DateTime } from 'luxon';

type Props = {
  open: boolean;
  block?: Block | null;
  task?: Task | null;
  onClose: () => void;
  onSaveTask: (changes: Partial<Task>) => Promise<void>;
  onSaveBlock: (changes: Partial<Block>) => Promise<void>;
  onToggleDone: () => Promise<void>;
};

const backdrop: React.CSSProperties = {
  position:'fixed', inset:0, background:'rgba(0,0,0,0.25)', zIndex: 9998
};
const panel: React.CSSProperties = {
  position:'fixed', top:0, right:0, width:380, height:'100vh',
  background:'#fff', boxShadow:'-4px 0 12px rgba(0,0,0,0.12)', padding:16, overflow:'auto',
  zIndex: 9999
};
const label: React.CSSProperties = { fontSize:12, opacity:0.8 };
const input: React.CSSProperties = { width:'100%', padding:'6px 8px', border:'1px solid #d1d5db', borderRadius:6 };
const textarea: React.CSSProperties = { width:'100%', padding:'6px 8px', border:'1px solid #d1d5db', borderRadius:6, minHeight:80 };

export default function DetailsDrawer({ open, block, task, onClose, onSaveTask, onSaveBlock, onToggleDone }: Props) {
  const [taskTitle, setTaskTitle] = useState('');
  const [taskNotes, setTaskNotes] = useState('');
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [blockTitle, setBlockTitle] = useState('');
  const [blockNotes, setBlockNotes] = useState('');
  const [status, setStatus] = useState<'planned'|'in_progress'|'done'|'skipped'>('planned');

  useEffect(() => {
    setTaskTitle(task?.title ?? '');
    setTaskNotes(task?.notes ?? '');
    setChecklist(task?.checklist ?? []);
    setBlockTitle(block?.title ?? '');
    setBlockNotes(block?.notes_override ?? '');
    setStatus(block?.status ?? 'planned');
  }, [task, block, open]);

  if (!open || !block) return null;
  const s = DateTime.fromISO(block.start).toFormat('yyyy-LL-dd HH:mm');
  const e = DateTime.fromISO(block.end).toFormat('yyyy-LL-dd HH:mm');

  return (
    <div>
      <div style={backdrop} onClick={onClose} />
      <div style={panel}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
          <h3 style={{margin:0}}>块详情</h3>
          <button onClick={onClose} style={{border:'1px solid #d1d5db', borderRadius:6, padding:'2px 8px'}}>关闭</button>
        </div>

        <div style={{marginTop:12}}>
          <div style={label}>时间</div>
          <div>{s} → {e}</div>
        </div>

        <div style={{marginTop:12}}>
          <div style={label}>块标题（可覆盖任务标题）</div>
          <input style={input} value={blockTitle} onChange={e=>setBlockTitle(e.target.value)} placeholder="留空则继承任务标题" />
        </div>

        <div style={{marginTop:12}}>
          <div style={label}>块备注</div>
          <textarea style={textarea} value={blockNotes} onChange={e=>setBlockNotes(e.target.value)} placeholder="仅对这个块生效" />
        </div>

        <div style={{marginTop:12, display:'flex', gap:8, alignItems:'center'}}>
          <div style={label}>状态</div>
          <select value={status} onChange={e=>setStatus(e.target.value as any)} style={{...input, width:140}}>
            <option value="planned">planned</option>
            <option value="in_progress">in_progress</option>
            <option value="done">done</option>
            <option value="skipped">skipped</option>
          </select>
          <button onClick={onToggleDone} style={{border:'1px solid #d1d5db', borderRadius:6, padding:'4px 8px'}}>
            {status==='done' ? '↩︎ 取消完成' : '✅ 标记完成'}
          </button>
          <button onClick={async ()=>{ await onSaveBlock({ title: blockTitle || undefined, notes_override: blockNotes || undefined, status }); }} style={{border:'1px solid #d1d5db', borderRadius:6, padding:'4px 8px'}}>
            保存块
          </button>
        </div>

        <hr style={{margin:'16px 0'}} />
        <h3 style={{marginTop:0}}>任务</h3>

        <div style={{marginTop:12}}>
          <div style={label}>任务标题</div>
          <input style={input} value={taskTitle} onChange={e=>setTaskTitle(e.target.value)} />
        </div>
        <div style={{marginTop:12}}>
          <div style={label}>任务备注</div>
          <textarea style={textarea} value={taskNotes} onChange={e=>setTaskNotes(e.target.value)} />
        </div>

        <div style={{marginTop:12}}>
          <div style={label}>清单</div>
          {checklist.length===0 && <div style={{opacity:0.6}}>（无清单）</div>}
          {checklist.map((ci, idx) => (
            <label key={ci.id} style={{display:'flex', alignItems:'center', gap:8}}>
              <input type="checkbox" checked={ci.done} onChange={e=>{
                const next = [...checklist];
                next[idx] = { ...ci, done: e.target.checked };
                setChecklist(next);
              }} />
              <input style={{...input, flex:1}} value={ci.text} onChange={e=>{
                const next = [...checklist];
                next[idx] = { ...ci, text: e.target.value };
                setChecklist(next);
              }} />
            </label>
          ))}
        </div>

        <div style={{marginTop:12}}>
          <button onClick={async ()=>{
            await onSaveTask({ title: taskTitle, notes: taskNotes, checklist });
          }} style={{border:'1px solid #d1d5db', borderRadius:6, padding:'6px 10px'}}>
            保存任务
          </button>
        </div>
      </div>
    </div>
  );
}
