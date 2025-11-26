import { useMemo, useState, useEffect } from 'react';
import type { Block, Task } from '../lib/data';
import { writeText } from '../lib/fs';

type Mode = 'manual' | 'api';

type Props = {
  open: boolean;
  onClose: () => void;
  tasks: Task[];
  blocks: Block[];
  onCommandsSaved?: () => Promise<void> | void;
};

const backdrop: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 998 };
const panel: React.CSSProperties = {
  position: 'fixed', right: 0, top: 0, bottom: 0, width: 420,
  background: '#fff', boxShadow: '-4px 0 12px rgba(0,0,0,0.12)',
  padding: 16, overflow: 'auto', zIndex: 999,
};
const section: React.CSSProperties = { border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, background: '#fafafa' };

const defaultSystemPrompt = `你是一个帮助用户维护周历与任务的助理。请阅读提供的数据后，生成可以写入 ai_inbox/commands.jsonl 的 JSON Lines 命令，每行一个。命令类型包括 create_task、create_block、move_block、resize_block、complete_block、update_task 等，字段需与现有数据结构一致。`;

export default function AIAssistant({ open, onClose, tasks, blocks, onCommandsSaved }: Props) {
  const [mode, setMode] = useState<Mode>('manual');
  const [manualText, setManualText] = useState('');
  const [feedback, setFeedback] = useState('');
  const [apiEndpoint, setApiEndpoint] = useState(() => localStorage.getItem('aiEndpoint') || 'https://api.openai.com/v1/chat/completions');
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('aiApiKey') || '');
  const [model, setModel] = useState(() => localStorage.getItem('aiModel') || 'gpt-4o-mini');
  const [systemPrompt, setSystemPrompt] = useState(() => localStorage.getItem('aiSystemPrompt') || defaultSystemPrompt);
  const [userPrompt, setUserPrompt] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => { localStorage.setItem('aiEndpoint', apiEndpoint); }, [apiEndpoint]);
  useEffect(() => { localStorage.setItem('aiApiKey', apiKey); }, [apiKey]);
  useEffect(() => { localStorage.setItem('aiModel', model); }, [model]);
  useEffect(() => { localStorage.setItem('aiSystemPrompt', systemPrompt); }, [systemPrompt]);

  const context = useMemo(() => JSON.stringify({ tasks, blocks }, null, 2), [tasks, blocks]);

  if (!open) return null;

  async function copyContext() {
    try {
      await navigator.clipboard.writeText(context);
      setFeedback('已复制当前数据，可粘贴到聊天机器人。');
    } catch (e) {
      console.error(e);
      setFeedback('复制失败，请手动选择文本。');
    }
  }

  async function saveCommands() {
    if (!manualText.trim()) {
      setFeedback('请填写命令文本。');
      return;
    }
    await writeText('ai_inbox/commands.jsonl', manualText.trim() + (manualText.endsWith('\n') ? '' : '\n'));
    setFeedback('已写入 ai_inbox/commands.jsonl');
    if (onCommandsSaved) await onCommandsSaved();
  }

  async function callAPI() {
    setLoading(true);
    setFeedback('');
    try {
      const res = await fetch(apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `${userPrompt}\n\n当前数据：\n${context}` },
          ],
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      const json: any = await res.json();
      const content = json?.choices?.[0]?.message?.content ?? JSON.stringify(json, null, 2);
      setManualText(content);
      setFeedback('已收到响应，已填入命令区。请核对后写入。');
    } catch (e: any) {
      setFeedback(`调用失败：${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div style={backdrop} onClick={onClose} />
      <div style={panel}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>AI 助手</h3>
          <button onClick={onClose} style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6 }}>关闭</button>
        </div>

        <div style={{ marginBottom: 12, display: 'flex', gap: 8 }}>
          <button onClick={() => setMode('manual')} style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #d1d5db', background: mode === 'manual' ? '#2563eb' : '#fff', color: mode === 'manual' ? '#fff' : '#000' }}>手动模式</button>
          <button onClick={() => setMode('api')} style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #d1d5db', background: mode === 'api' ? '#2563eb' : '#fff', color: mode === 'api' ? '#fff' : '#000' }}>API 模式</button>
        </div>

        <div style={{ ...section, marginBottom: 12 }}>
          <h4 style={{ margin: '0 0 8px 0' }}>上下文数据</h4>
          <p style={{ fontSize: 12, marginTop: 0 }}>可复制以下 JSON，粘贴到聊天机器人以获取建议。</p>
          <button onClick={copyContext} style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, marginBottom: 8 }}>复制上下文</button>
          <pre style={{ maxHeight: 160, overflow: 'auto', background: '#f3f4f6', padding: 8, borderRadius: 6, fontSize: 11 }}>{context}</pre>
        </div>

        {mode === 'api' && (
          <div style={{ ...section, marginBottom: 12, display: 'grid', gap: 8 }}>
            <h4 style={{ margin: '0 0 4px 0' }}>调用 API 生成命令</h4>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              接口地址
              <input value={apiEndpoint} onChange={e => setApiEndpoint(e.target.value)} style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              API Key（如需）
              <input value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Bearer token" style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              模型
              <input value={model} onChange={e => setModel(e.target.value)} style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              System Prompt
              <textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, minHeight: 80 }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              用户需求
              <textarea value={userPrompt} onChange={e => setUserPrompt(e.target.value)} placeholder="描述你希望调整的内容" style={{ padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, minHeight: 80 }} />
            </label>
            <button onClick={callAPI} disabled={loading} style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, background: loading ? '#f3f4f6' : '#fff' }}>{loading ? '调用中…' : '调用 API 并填入命令'}</button>
          </div>
        )}

        <div style={section}>
          <h4 style={{ margin: '0 0 8px 0' }}>命令编辑</h4>
          <textarea value={manualText} onChange={e => setManualText(e.target.value)} placeholder="在此粘贴或编辑 JSON Lines 命令" style={{ width: '100%', minHeight: 200, padding: 8, border: '1px solid #d1d5db', borderRadius: 6, fontFamily: 'monospace', fontSize: 12 }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={saveCommands} style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}>写入 ai_inbox</button>
            <button onClick={() => setManualText('')} style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}>清空</button>
          </div>
        </div>

        {feedback && <div style={{ marginTop: 12, fontSize: 12, color: '#2563eb' }}>{feedback}</div>}
      </div>
    </>
  );
}
