// src/components/WeekGrid.tsx (add strategy handling)
import React, { useMemo, useRef, useState } from 'react';
import { DateTime } from 'luxon';
import {
  minutesSinceMidnight, durationMinutes, snapMinutes, clamp,
  isoForDateAndMinutes, MINUTES_PER_DAY, SNAP_MIN, overlaps,
  timeStringToMinutes
} from '../lib/schedule';
import type { Block, Task } from '../lib/data';

type Strategy = 'allow'|'block'|'push'|'clip';

type Props = {
  weekStartISO: string;
  tasks: Task[];
  blocks: Block[];
  visibleDays?: string[];
  onMove: (block_id: string, newStartISO: string) => Promise<void>;
  onResize: (block_id: string, newEndISO: string) => Promise<void>;
  onToggle: (block_id: string) => Promise<void>;
  onSelect?: (block_id: string) => void;
  onDuplicate?: (block_id: string) => Promise<void>;
  onDelete?: (block_id: string, scope: 'single'|'series') => Promise<void>;
  onRequestCreate?: (opts: { dayISO: string; startMinutes: number; endMinutes: number }) => void;
  strategy?: Strategy;
  onNotify?: (msg: string) => void;
  sleepRange?: { start: string; end: string } | null;
};

const HOUR_PX = 64; // 每小时像素（可调）
const MINUTE_PX = HOUR_PX / 60;

const borderColor = '#e5e7eb'; // 灰色边线
const cardBorder = '#d1d5db';
const danger = '#ef4444';
const sleepColor = 'rgba(59,130,246,0.12)';

type DragState = null | {
  id: string;
  mode: 'move'|'resize';
  originalDay: number;
  targetDay: number;
  startM: number;
  endM: number;
  duration: number;
  previewStartM: number;
  previewEndM: number;
  overlapping: boolean;
  timeColWidth: number;
  colWidth: number;
};

export default function WeekGrid({
  weekStartISO,
  tasks,
  blocks,
  visibleDays,
  onMove,
  onResize,
  onToggle,
  onSelect,
  onDuplicate,
  onDelete,
  onRequestCreate,
  strategy='allow',
  onNotify,
  sleepRange,
}: Props) {
  const days = useMemo(() => {
    if (visibleDays && visibleDays.length) {
      return visibleDays.map(iso => DateTime.fromISO(iso));
    }
    return Array.from({ length: 7 }, (_, i) => DateTime.fromISO(weekStartISO).plus({ days: i }));
  }, [visibleDays, weekStartISO]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, _setDrag] = useState<DragState>(null);
  const dragRef = useRef<DragState>(null);

  const draggingRef = useRef(false);
  const suppressClickRef = useRef(0);

  function setDrag(next: DragState | ((prev: DragState)=>DragState)) {
    if (typeof next === 'function') {
      _setDrag((prev) => {
        const v = (next as any)(prev);
        dragRef.current = v;
        return v;
      });
    } else {
      dragRef.current = next as DragState;
      _setDrag(next as DragState);
    }
  }

  const byDay = useMemo(() => {
    const map: Record<string, Block[]> = {};
    for (const d of days) map[d.toISODate()!] = [];
    for (const b of blocks) {
      const dayISO = DateTime.fromISO(b.start).toISODate();
      if (!dayISO) continue;
      if (!map[dayISO]) continue;
      map[dayISO].push(b);
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => DateTime.fromISO(a.start).toMillis() - DateTime.fromISO(b.start).toMillis());
    }
    return map;
  }, [blocks, days]);

  function labelFor(b: Block) {
    return b.title ?? tasks.find(t => t.task_id === b.task_id)?.title ?? '未命名';
  }

  function computeOverlap(dayIndex: number, selfId: string, sM: number, eM: number) {
    const dayISO = days[dayIndex].toISODate()!;
    const others = (byDay[dayISO] ?? []).filter(x => x.block_id !== selfId);
    for (const ob of others) {
      const os = minutesSinceMidnight(DateTime.fromISO(ob.start));
      const oe = minutesSinceMidnight(DateTime.fromISO(ob.end));
      if (overlaps(sM, eM, os, oe)) return true;
    }
    return false;
  }

  function findNextGap(dayIndex: number, fromM: number, duration: number) {
    const items = (byDay[days[dayIndex].toISODate()!] ?? []).map(b => ({
      s: minutesSinceMidnight(DateTime.fromISO(b.start)),
      e: minutesSinceMidnight(DateTime.fromISO(b.end)),
      id: b.block_id
    }));
    items.unshift({ s: 0, e: 0, id: '__start' });
    items.push({ s: MINUTES_PER_DAY, e: MINUTES_PER_DAY, id: '__end' });
    for (let i=0;i<items.length-1;i++) {
      const curEnd = Math.max(items[i].e, fromM);
      const nextStart = items[i+1].s;
      if (curEnd + duration <= nextStart) {
        return curEnd;
      }
    }
    return -1;
  }

  function clipEndToFirstConflict(dayIndex: number, selfId: string, sM: number, eM: number) {
    const items = (byDay[days[dayIndex].toISODate()!] ?? []).filter(b=>b.block_id!==selfId).map(b => ({
      s: minutesSinceMidnight(DateTime.fromISO(b.start)),
      e: minutesSinceMidnight(DateTime.fromISO(b.end)),
      id: b.block_id
    }));
    let limit = eM;
    for (const it of items) {
      if (overlaps(sM, eM, it.s, it.e) && it.s > sM) {
        limit = Math.min(limit, it.s);
      }
    }
    return limit;
  }

  function onMouseDown(e: React.MouseEvent, b: Block, resizing: boolean) {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;

    const root = containerRef.current!;
    const rect = root.getBoundingClientRect();
    const timeColWidth = 96;
    const gridWidth = rect.width - timeColWidth;
    const dayAreaLeft = rect.left + timeColWidth;
    const colWidth = gridWidth / 7;

    const start = DateTime.fromISO(b.start);
    const end = DateTime.fromISO(b.end);
    const originalDay = days.findIndex(d => d.toISODate() === start.toISODate());
    const startM = minutesSinceMidnight(start);
    const endM = minutesSinceMidnight(end);
    const duration = Math.max(SNAP_MIN, endM - startM);

    setDrag({
      id: b.block_id, mode: resizing ? 'resize' : 'move',
      originalDay, targetDay: originalDay,
      startM, endM, duration,
      previewStartM: startM, previewEndM: endM,
      overlapping: false,
      timeColWidth, colWidth
    });

    function onMoveHandler(ev: MouseEvent) {
      const relX = clamp(ev.clientX - dayAreaLeft, 0, gridWidth - 1);
      const targetDay = clamp(Math.floor(relX / colWidth), 0, 6);
      const dayTop = rect.top;
      const relY = clamp(ev.clientY - dayTop, 0, HOUR_PX * 24);
      const snappedMins = snapMinutes(Math.round(relY / MINUTE_PX), SNAP_MIN);
      let previewStartM = startM;
      let previewEndM = endM;

      if (resizing) {
        previewEndM = clamp(snappedMins, startM + SNAP_MIN, MINUTES_PER_DAY);
      } else {
        previewStartM = clamp(snappedMins, 0, MINUTES_PER_DAY - duration);
        previewEndM = previewStartM + duration;
      }

      const overlapping = computeOverlap(targetDay, b.block_id, previewStartM, previewEndM);
      setDrag(prev => prev && ({ ...prev, targetDay, previewStartM, previewEndM, overlapping }));
    }

    async function onUp() {
      window.removeEventListener('mousemove', onMoveHandler);
      window.removeEventListener('mouseup', onUp);

      const d = dragRef.current;
      if (d) {
        let targetDay = d.targetDay;
        let sM = d.previewStartM;
        let eM = d.previewEndM;
        let overlapNow = computeOverlap(targetDay, b.block_id, sM, eM);

        const targetISO = days[targetDay]?.toISODate();
        const originalISO = days[d.originalDay]?.toISODate();
        if (overlapNow) {
          if (strategy === 'block') {
            onNotify && onNotify('与其它块重叠，已取消保存。');
          } else if (strategy === 'push' && d.mode === 'move') {
            const ng = findNextGap(targetDay, sM, d.duration);
            if (ng >= 0 && targetISO) {
              sM = ng;
              eM = sM + d.duration;
              const newISO = isoForDateAndMinutes(targetISO, sM);
              await onMove(b.block_id, newISO);
            } else {
              onNotify && onNotify('当天没有足够的空档，无法顺延。');
            }
          } else if (strategy === 'clip') {
            if (d.mode === 'resize' && originalISO) {
              const lim = clipEndToFirstConflict(d.originalDay, b.block_id, d.startM, eM);
              const newEndISO = isoForDateAndMinutes(originalISO, Math.max(lim, d.startM + SNAP_MIN));
              await onResize(b.block_id, newEndISO);
            } else if (targetISO) {
              const lim = clipEndToFirstConflict(targetDay, b.block_id, sM, eM);
              eM = Math.max(lim, sM + SNAP_MIN);
              const newEndISO = isoForDateAndMinutes(targetISO, eM);
              const newStartISO = isoForDateAndMinutes(targetISO, sM);
              await onMove(b.block_id, newStartISO);
              await onResize(b.block_id, newEndISO);
            }
          } else {
            if (d.mode === 'move' && targetISO) {
              const newISO = isoForDateAndMinutes(targetISO, sM);
              await onMove(b.block_id, newISO);
            } else if (originalISO) {
              const newEndISO = isoForDateAndMinutes(originalISO, eM);
              await onResize(b.block_id, newEndISO);
            }
          }
        } else {
          if (d.mode === 'move' && targetISO) {
            const newISO = isoForDateAndMinutes(targetISO, sM);
            await onMove(b.block_id, newISO);
          } else if (originalISO) {
            const newEndISO = isoForDateAndMinutes(originalISO, eM);
            await onResize(b.block_id, newEndISO);
          }
        }
      }
      draggingRef.current = false;
      suppressClickRef.current = Date.now() + 250;
      setDrag(null);
    }

    window.addEventListener('mousemove', onMoveHandler);
    window.addEventListener('mouseup', onUp);
  }

  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `96px repeat(${days.length}, 1fr)`,
    height: '100%',
    userSelect: drag ? 'none' : 'auto',
    fontSize: 12,
    position: 'relative'
  };
  const timeColStyle: React.CSSProperties = { borderRight: `1px solid ${borderColor}`, padding: 8 };
  const dayColStyle: React.CSSProperties = { position: 'relative', borderRight: `1px solid ${borderColor}`, overflow: 'hidden' };
  const stickyHeaderStyle: React.CSSProperties = { position: 'sticky', top: 0, background: 'rgba(255,255,255,0.85)', padding: 4, textAlign: 'center', fontWeight: 600, zIndex: 1 };
  const hourLineStyle = (h: number): React.CSSProperties => ({ position: 'absolute', top: h * HOUR_PX, left: 0, right: 0, height: 1, borderTop: `1px solid ${borderColor}` });

  // Overlay 预览
  const overlay = (() => {
    if (!drag) return null;
    const top = drag.previewStartM * MINUTE_PX;
    const height = Math.max((drag.previewEndM - drag.previewStartM) * MINUTE_PX, SNAP_MIN * MINUTE_PX);
    const left = drag.timeColWidth + drag.colWidth * drag.targetDay + 6;
    const width = drag.colWidth - 12;
    return (
      <div
        key="overlay"
        style={{
          position:'absolute', top, left, width, height,
          border:`1px solid ${drag.overlapping ? danger : cardBorder}`,
          borderRadius:8, padding:8, background:'#fff',
          boxShadow:'0 2px 6px rgba(0,0,0,0.12)', opacity:0.95,
          pointerEvents:'none', zIndex:5
        }}
      >
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div style={{ fontWeight:600, marginRight:8, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>(拖拽中)</div>
          <div style={{ fontSize:11, opacity:0.7 }}>
            {drag.mode==='move' ? '移动' : '拉伸'} · {drag.overlapping ? '冲突' : '可用'}
          </div>
        </div>
      </div>
    );
  })();

  function blockVisual(b: Block) {
    const s = DateTime.fromISO(b.start);
    const e = DateTime.fromISO(b.end);
    const top = minutesSinceMidnight(s) * MINUTE_PX;
    const height = Math.max((durationMinutes(s, e)) * MINUTE_PX, SNAP_MIN * MINUTE_PX);
    const done = b.status === 'done';
    const style: React.CSSProperties = {
      position:'absolute', left:6, right:6, top, height,
      border:`1px solid ${cardBorder}`,
      borderRadius:8, padding:8,
      background: done ? '#f3f4f6' : '#fff',
      boxShadow:'0 1px 2px rgba(0,0,0,0.06)'
    };
    return { style, done, s, e };
  }

  return (
    <div ref={containerRef} style={gridStyle}>
      {/* 左侧时间尺 */}
      <div style={timeColStyle}>
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} style={{ height: HOUR_PX, display:'flex', alignItems:'flex-start' }}>
            <span>{String(h).padStart(2,'0')}:00</span>
          </div>
        ))}
      </div>

      {/* 7 天列 */}
      {days.map((d, idx) => {
        const iso = d.toISODate()!;
        const dayBlocks = byDay[iso] ?? [];
        return (
          <div
            key={iso}
            style={dayColStyle}
            onDoubleClick={(e) => {
              if (!onRequestCreate) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const relY = clamp(e.clientY - rect.top, 0, HOUR_PX * 24);
              const startMinutes = clamp(snapMinutes(Math.round(relY / MINUTE_PX), SNAP_MIN), 0, MINUTES_PER_DAY - SNAP_MIN);
              const endMinutes = Math.min(startMinutes + 60, MINUTES_PER_DAY);
              onRequestCreate({ dayISO: iso, startMinutes, endMinutes });
            }}
          >
            {/* 背景小时网格线 */}
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} style={hourLineStyle(h)} />
            ))}
            <div style={stickyHeaderStyle}>{d.toFormat('ccc dd')}</div>

            {sleepRange && (() => {
              const start = timeStringToMinutes(sleepRange.start);
              const end = timeStringToMinutes(sleepRange.end);
              const segments: { start: number; end: number }[] = [];
              if (start !== end) {
                if (start < end) {
                  segments.push({ start, end });
                } else {
                  segments.push({ start, end: MINUTES_PER_DAY });
                  segments.push({ start: 0, end });
                }
              }
              return segments.map((seg, sIdx) => (
                <div
                  key={`sleep-${idx}-${sIdx}`}
                  style={{
                    position:'absolute',
                    left:0,
                    right:0,
                    top: seg.start * MINUTE_PX,
                    height: Math.max((seg.end - seg.start) * MINUTE_PX, 1),
                    background: sleepColor,
                    pointerEvents:'none',
                    zIndex:0,
                  }}
                />
              ));
            })()}

            {/* 渲染块 */}
            {dayBlocks.map(b => {
              const v = blockVisual(b);
              return (
                <div
                  key={b.block_id}
                  onClick={() => {
                    if (draggingRef.current || Date.now() < suppressClickRef.current) return;
                    onSelect && onSelect(b.block_id);
                  }}
                  style={v.style}
                >
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                    <div style={{ fontWeight:600, marginRight:8, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {labelFor(b)}
                      {b.recurrence?.id && <span style={{ marginLeft:4, fontSize:11, color:'#2563eb' }}>↻</span>}
                    </div>
                    <div style={{ display:'flex', gap:4 }} onClick={(ev)=>ev.stopPropagation()}>
                      <button
                        style={{ fontSize:12, padding:'2px 6px', border:'1px solid #d1d5db', borderRadius:6, background:'#fff' }}
                        onClick={() => onToggle(b.block_id)}
                      >
                        {b.status === 'done' ? '↩︎' : '✅'}
                      </button>
                      {onDuplicate && (
                        <button
                          style={{ fontSize:12, padding:'2px 6px', border:'1px solid #d1d5db', borderRadius:6, background:'#fff' }}
                          onClick={async () => { await onDuplicate(b.block_id); }}
                        >
                          复制
                        </button>
                      )}
                      {onDelete && (
                        <button
                          style={{ fontSize:12, padding:'2px 6px', border:'1px solid #d1d5db', borderRadius:6, background:'#fff' }}
                          onClick={async () => {
                            if (b.recurrence?.id) {
                              const whole = window.confirm('删除整个重复系列？取消则仅删除当前块');
                              await onDelete(b.block_id, whole ? 'series' : 'single');
                            } else {
                              const ok = window.confirm('确定删除这个块？');
                              if (ok) await onDelete(b.block_id, 'single');
                            }
                          }}
                        >
                          删除
                        </button>
                      )}
                      <button
                        style={{ fontSize:12, padding:'2px 6px', border:'1px solid #d1d5db', borderRadius:6, background:'#fff',cursor:'grab' }}
                        onMouseDown={(e)=>{ e.preventDefault(); e.stopPropagation(); onMouseDown(e, b, false); }}
                      >
                        拖
                      </button>
                    </div>
                  </div>
                  <div style={{ opacity:0.8 }}>{DateTime.fromISO(b.start).toFormat('HH:mm')}–{DateTime.fromISO(b.end).toFormat('HH:mm')}</div>
                  {/* 右下角拉伸柄 */}
                  <div
                    style={{ position:'absolute', bottom:0, left:0, right:0, height:6, cursor:'ns-resize' }}
                    onMouseDown={(e)=>{ e.preventDefault(); e.stopPropagation(); onMouseDown(e, b, true); }}
                    title="拖动以调整时长"
                  />
                </div>
              );
            })}
            {/* 占位，撑开高度 */}
            <div style={{ height: 24 * HOUR_PX }} />
          </div>
        );
      })}

      {/* 拖拽预览 Overlay */}
      {overlay}
    </div>
  );
}
