import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'wouter';
import { ArrowLeft, Crosshair, HeartPulse, Radio, RotateCcw, Shield, Target, Timer, Wifi } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetGameRoomQueryKey, useGetGameRoom, useSendGameRoomMessage, useUpdateGameRoomState,
} from './api-client';
import { advanceRound, buyEquipment, createMission, executeRound, hireReinforcement, queueAction, setUnitCommand } from './engine';
import type { Direction, Equipment, GameAction, GameState, ReinforcementType, Role, Unit } from './engine';
import { getDeployableTiles, getReachableTiles, reinforcementStatus } from './engine';

const roleNames: Record<Role, string> = { assault:'突撃兵', scout:'偵察兵', hacker:'ハッカー', medic:'衛生兵', engineer:'工兵', commander:'指揮官' };
const localPrefix = 'LOCAL-';
const isLocalCode = (code: string) => code.startsWith(localPrefix);

function safeInitial(code: string): GameState {
  if (isLocalCode(code)) {
    const saved = localStorage.getItem(`ff-state-${code}`);
    if (saved) { try { return JSON.parse(saved) as GameState; } catch { /* discarded below */ } }
  }
  const role = (localStorage.getItem(`ff-role-${code}`) || localStorage.getItem('ff-role') || 'assault') as Role;
  return createMission(role);
}

export default function GamePage() {
  const { code = '' } = useParams<{ code: string }>();
  const [, navigate] = useLocation();
  const cache = useQueryClient();
  const local = isLocalCode(code);
  const playerId = localStorage.getItem(`ff-player-${code}`) || '';
  const query = useGetGameRoom(code, { query: { queryKey: getGetGameRoomQueryKey(code), enabled: !local, refetchInterval: local ? false : 1800 } });
  const updateRoom = useUpdateGameRoomState();
  const sendMessage = useSendGameRoomMessage();
  const [state, setState] = useState<GameState>(() => safeInitial(code));
  const [selectedId, setSelectedId] = useState('');
  const [selectedTile, setSelectedTile] = useState<{x:number;y:number} | null>(null);
  const [notice, setNotice] = useState('');
  const [chatDraft, setChatDraft] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(30);
  const [aimDirection, setAimDirection] = useState<Direction>('E');
  const appliedSnapshot = useRef<string | null>(null);
  const initializedRoom = useRef(false);
  const transitionPending = useRef(false);
  const room = query.data?.room;
  const isRoomHost = Boolean(room?.players[0]?.id && room.players[0].id === playerId);
  const units = state.soldiers || [];
  const defaultUnit = units.find(unit => local || !unit.ownerId || unit.ownerId === playerId) || units[0];
  const selected = units.find(unit => unit.id === selectedId) || defaultUnit;
  const canControlSelected = Boolean(selected && (local || !selected.ownerId || selected.ownerId === playerId));
  const reachable = useMemo(
    () => new Set(getReachableTiles(state, selected?.id || '').map(tile => `${tile.x},${tile.y}`)),
    [state, selected?.id],
  );

  const deployable = useMemo(
    () => new Set(getDeployableTiles(state, selected?.id || '').map(tile => `${tile.x},${tile.y}`)),
    [state, selected?.id],
  );
  const reinforcement = reinforcementStatus(state);

  useEffect(() => {
    if (local) { localStorage.setItem(`ff-state-${code}`, JSON.stringify(state)); return; }
    const snapshot = query.data?.room.snapshot;
    if (!snapshot || snapshot === appliedSnapshot.current) return;
    try { const remote = JSON.parse(snapshot) as GameState; appliedSnapshot.current = snapshot; setState(remote); }
    catch { setNotice('共有データを読み込めません。再同期してください。'); }
  }, [code, local, query.data?.room.snapshot, state]);

  const publish = (next: GameState) => {
    setState(next);
    if (local) { localStorage.setItem(`ff-state-${code}`, JSON.stringify(next)); return; }
    const room = query.data?.room;
    if (!room || !playerId) { setNotice('ルーム情報を同期しています。'); return; }
    const snapshot = JSON.stringify(next);
    updateRoom.mutate({ code, data: { playerId, expectedVersion: room.version, snapshot } }, {
      onSuccess: envelope => { appliedSnapshot.current = envelope.room.snapshot; cache.setQueryData(getGetGameRoomQueryKey(code), envelope); setNotice('作戦状態を共有しました。'); },
      onError: () => { if (!query.data?.room.snapshot) initializedRoom.current = false; setNotice('状態が更新されています。最新データを取得しました。'); query.refetch(); },
    });
  };

  useEffect(() => {
    if (local || !room || room.status !== 'active' || room.snapshot || !isRoomHost || initializedRoom.current) return;
    initializedRoom.current = true;
    const next = createMission(
      room.players[0]?.role || 'assault',
      room.players[1]?.role || 'medic',
      [room.players[0]?.id || playerId, room.players[1]?.id || ''],
    );
    publish(next);
  }, [local, room?.status, room?.snapshot, room?.version, isRoomHost, playerId]);

  useEffect(() => {
    if (state.phase === 'victory' || state.phase === 'defeat') return;
    const endAt = state.phaseEndsAt || Date.now() + (state.phase === 'planning' ? 30_000 : 15_000);
    const canAdvance = local || isRoomHost;
    transitionPending.current = false;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (canAdvance && remaining === 0 && !transitionPending.current) {
        transitionPending.current = true;
        publish(state.phase === 'planning' ? executeRound(state) : advanceRound(state));
      }
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [state.phase, state.phaseEndsAt, local, isRoomHost, playerId]);

  const queue = (action: GameAction) => {
    if (!selected || selected.downed || state.phase !== 'planning') return;
    if (!canControlSelected) { setNotice('このオペレーターには割り当てられていません。'); return; }
    if (updateRoom.isPending) { setNotice('同期中です。少し待ってから次の指示を出してください。'); return; }
    const next = queueAction(state, selected.id, action);
    publish(next);
  };
  const execute = () => publish(executeRound(state));
  const purchase = (item: Equipment) => {
    if (!selected || updateRoom.isPending) return;
    if (!canControlSelected) { setNotice('装備は担当オペレーターごとに購入します。'); return; }
    publish(buyEquipment(state, selected.id, item));
  };
  const hire = (type: ReinforcementType) => {
    if (updateRoom.isPending) return;
    publish(hireReinforcement(state, type));
  };
  const changeNpcCommand = (command: NonNullable<Unit['command']>) => {
    if (!selected || updateRoom.isPending) return;
    publish(setUnitCommand(state, selected.id, command));
  };
  const sendTeamMessage = (body: string) => {
    if (local || !body.trim() || !playerId) return;
    sendMessage.mutate({ code, data: { playerId, body: body.trim() } }, {
      onSuccess: envelope => cache.setQueryData(getGetGameRoomQueryKey(code), envelope),
    });
  };
  const submitTeamMessage = (event: FormEvent) => {
    event.preventDefault();
    if (!chatDraft.trim()) return;
    sendTeamMessage(chatDraft);
    setChatDraft('');
  };
  const makeAction = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra } as unknown as GameAction);
  const tileAction = (x: number, y: number) => {
    setSelectedTile({x,y});
    queue(makeAction('move', {x,y}));
  };
  const selectedOrders = useMemo(() => selected?.orders || [], [selected]);
  const refresh = () => query.refetch();

  if (!local && (query.isLoading || (room && room.status !== 'active') || (room?.status === 'active' && !room.snapshot && !isRoomHost))) return <main className="grid min-h-[100dvh] place-items-center bg-[#e9e5da] p-5"><section className="w-full max-w-md border border-[#c4bfb3] bg-[#f0ede4] p-7"><p className="mono text-[10px] tracking-widest text-[#bd4c35]">OPERATION LINK / STANDBY</p><h1 className="display text-4xl">作戦開始を待機中</h1><p className="text-sm leading-6 text-[#667171]">{room?.status === 'active' ? 'ホストが共有作戦状態を準備しています。' : 'もう一人のオペレーターが参加すると、共有作戦状態が有効になります。'}</p><button onClick={refresh} data-testid="button-refresh-operation" className="bg-[#20282c] px-4 py-3 text-sm text-[#f0ede4]">状態を更新</button></section></main>;
  if (!local && query.isError) return <main className="grid min-h-[100dvh] place-items-center bg-[#e9e5da] p-5"><section className="border border-[#c4bfb3] bg-[#f0ede4] p-7"><p className="mono text-xs text-[#bd4c35]">LINK LOST</p><h1 className="display text-4xl">作戦回線が切断</h1><button onClick={refresh} data-testid="button-retry-game" className="mt-3 bg-[#20282c] px-4 py-3 text-sm text-[#f0ede4]">再接続</button></section></main>;

  const cellAt = (x:number,y:number) => state.map?.[y]?.[x];
  const terrainName = (cell: unknown) => {
    const terrain = (cell as {terrain?: unknown} | undefined)?.terrain;
    return typeof terrain === 'string' ? terrain.toLowerCase() : '';
  };
  const actionTitle = (order: GameAction) => {
    const type = (order as unknown as {type?:string}).type;
    return ({move:'移動',shoot:'射撃',overwatch:'警戒',door:'扉操作',loot:'回収',heal:'治療',rescue:'救出',hack:'ハック',deploy:'展開',reload:'再装填'} as Record<string,string>)[type || ''] || '行動';
  };
  const entryText = (entry: unknown) => {
    if (typeof entry === 'string') return entry;
    const item = entry as Record<string, unknown>;
    return String(item.message || item.text || item.description || item.event || '作戦ログ更新');
  };

  return <main className="min-h-[100dvh] bg-[#e9e5da] text-[#20282c]">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#bcb8ad] bg-[#e2ded2] px-4 py-3 md:px-7">
      <div className="flex items-center gap-3"><button onClick={() => navigate(local ? '/' : `/room/${code}`)} data-testid="button-exit-game" aria-label="戻る" className="border border-[#bcb8ad] p-2"><ArrowLeft size={16}/></button><span className="grid h-8 w-8 place-items-center bg-[#c84b32] text-[#f7f2e9]"><Crosshair size={17}/></span><div><b className="display text-lg">FALSE FRONT</b><span className="mono ml-3 hidden text-[9px] tracking-widest text-[#7c827d] sm:inline">{local ? 'SOLO LOCAL SESSION' : `CO-OP / ${code}`}</span></div></div>
      <div className="flex items-center gap-4"><span className="mono flex items-center gap-2 text-[9px] tracking-widest text-[#607567]"><span className="h-2 w-2 rounded-full bg-[#567960]"/>{local ? 'LOCAL' : `SYNC v${query.data?.room.version ?? '—'}`}</span><span className="mono border border-[#bcb8ad] px-3 py-2 text-[10px]">CREDITS <b className="ml-2">{state.credits}</b></span></div>
    </header>
    <div className="mx-auto grid max-w-[1600px] gap-4 p-3 md:p-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <section className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border border-[#bcb8ad] bg-[#f0ede4] px-4 py-3">
          <div className="flex items-center gap-4"><div><span className="mono block text-[9px] tracking-[.18em] text-[#8b4a3a]">OPERATION / {String(state.phase).toUpperCase()}</span><strong className="display text-2xl">{state.objective?.title || '作戦目標'}</strong></div><div className="hidden h-9 w-px bg-[#c9c4b8] sm:block"/><p className="hidden max-w-[300px] text-xs leading-5 text-[#697170] md:block">{state.objective?.description}</p></div>
          <div className="flex items-center gap-2"><span className="mono flex items-center gap-2 text-[10px]"><Timer size={14}/>ROUND {String(state.round).padStart(2,'0')}</span><span className={`mono border px-2 py-1 text-[9px] tracking-widest ${state.phase === 'execution' ? 'border-[#c84b32] text-[#c84b32]' : 'border-[#a9aa9f] text-[#626c6b]'}`}>{state.phase === 'planning' ? 'PLANNING' : state.phase.toUpperCase()} · {secondsLeft}s</span></div>
        </div>
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_245px]">
          <div className="scanline paper-grid relative overflow-auto border border-[#b5b1a6] bg-[#d8d5c9] p-2 md:p-4">
            <div className="mx-auto grid w-max gap-[2px]" style={{gridTemplateColumns:`repeat(${state.map?.[0]?.length || 8}, minmax(34px, 1fr))`}} data-testid="grid-tactical-map">
              {(state.map || []).flatMap((row, y) => row.map((cell, x) => {
                const soldier = units.find(u => u.x === x && u.y === y && !u.downed && !u.eliminated);
                const fallen = !soldier && units.find(u => u.x === x && u.y === y && u.downed && !u.eliminated);
                const enemy = (state.enemies || []).find(u => u.x === x && u.y === y && !u.downed && u.visible);
                const lastSeen = !enemy && (state.enemies || []).some(u => !u.downed && !u.visible && u.lastKnown?.x === x && u.lastKnown?.y === y);
                const chosen = selected?.id === soldier?.id;
                const terrain = terrainName(cell);
                return <button key={`${x}-${y}`} aria-label={`マス ${x + 1}, ${y + 1}`} data-testid={`tile-${x}-${y}`} onClick={() => soldier ? setSelectedId(soldier.id) : tileAction(x,y)} className={`relative grid aspect-square min-h-[35px] w-[min(9vw,62px)] place-items-center border transition md:min-h-[48px] ${chosen ? 'z-10 border-2 border-[#c84b32] bg-[#edc2af]' : deployable.has(`${x},${y}`) && state.phase === 'planning' ? 'border-[#c8923a] bg-[#f1e0bd]' : reachable.has(`${x},${y}`) && state.phase === 'planning' ? 'border-[#829787] bg-[#d4dfd1]' : 'border-[#b8b8aa]'} ${terrain.includes('wall') || terrain.includes('cover') ? 'bg-[#b9beb0]' : terrain.includes('water') ? 'bg-[#b7c5bd]' : 'bg-[#e4e1d6]'} ${cell.visible ? '' : 'opacity-40'}`} title={`${terrain || 'open'} · ${x},${y}`}>
                  <span className="mono absolute left-1 top-0.5 text-[7px] text-[#a2a49a]">{x + 1}</span>
                  {soldier && <span className={`z-10 grid h-6 w-6 place-items-center border-2 text-[10px] font-bold md:h-8 md:w-8 ${chosen ? 'border-[#c84b32] bg-[#c84b32] text-white' : 'border-[#567960] bg-[#e5e8dc] text-[#365240]'}`}>{soldier.name.slice(0,1)}</span>}
                  {fallen && <span aria-label="ダウン中" className="z-10 grid h-6 w-6 place-items-center border-2 border-dashed border-[#8b4b43] text-[9px] font-bold text-[#8b4b43]">✚</span>}
                  {enemy && <span className="z-10 grid h-5 w-5 place-items-center rounded-full bg-[#20282c] text-[9px] text-[#e9e5da]"><Target size={12}/></span>}
                  {lastSeen && <span aria-label="最終確認位置" className="z-10 grid h-5 w-5 place-items-center rounded-full border border-dashed border-[#20282c] text-[9px] text-[#20282c]"><Target size={11}/></span>}
                  {terrain === 'door' && !soldier && !enemy && <span className="mono z-10 text-[10px] font-bold text-[#7a5c46]">{cell.openDoor ? '／' : '▥'}</span>}
                  {terrain === 'loot' && <span className="mono z-10 text-[9px] font-bold text-[#8a6b31]">+</span>}
                  {terrain === 'terminal' && <span className="mono z-10 text-[9px] font-bold text-[#567960]">T</span>}
                  {terrain === 'objective' && <span className="mono z-10 text-[9px] font-bold text-[#bd4c35]">OBJ</span>}
                  {state.extraction?.x === x && state.extraction?.y === y && <span className="absolute bottom-1 right-1 h-2 w-2 rotate-45 border border-[#c84b32]"/>}
                  {selectedTile?.x === x && selectedTile?.y === y && !soldier && <span className="absolute inset-1 border border-dashed border-[#c84b32]"/>}
                </button>;
              }))}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#b8b8aa] pt-3"><div className="flex gap-4 text-[9px] text-[#626b68]"><span className="flex items-center gap-1.5"><span className="h-2 w-2 bg-[#567960]"/>味方</span><span className="flex items-center gap-1.5"><span className="h-2 w-2 bg-[#20282c]"/>敵影</span><span className="flex items-center gap-1.5"><span className="h-2 w-2 border border-[#c84b32]"/>脱出地点</span></div><span className="mono text-[9px] text-[#8d9187]">TACTICAL GRID / CLICK TILE TO ORDER MOVE</span></div>
          </div>
          <aside className="space-y-3">
            <div className="border border-[#bcb8ad] bg-[#e2ded2]">
              <div className="flex items-center justify-between border-b border-[#bcb8ad] px-3 py-3"><b className="text-xs">スクワッド</b><span className="mono text-[9px]">{units.length} OPERATORS</span></div>
              <div className="space-y-1 p-2">{units.map(unit => <UnitCard key={unit.id} unit={unit} selected={unit.id === selected?.id} onSelect={() => setSelectedId(unit.id)}/>)}</div>
            </div>
            <div className="border border-[#bcb8ad] bg-[#f0ede4] p-3">
              <div className="mb-2 flex items-center justify-between"><b className="text-xs">{selected?.name || '隊員を選択'}</b><span className="mono text-[9px] text-[#bd4b35]">{selected ? roleNames[selected.role] : ''}</span></div>
              {selected && <div className="mono mb-3 flex justify-between text-[9px] text-[#66706e]"><span>HP {selected.hp}</span><span>AMMO {selected.ammo}/{selected.maxAmmo}</span></div>}
              <div className="grid grid-cols-2 gap-1.5">
                <ActionButton label="射撃" onClick={() => { const target = state.enemies.filter(enemy => !enemy.downed && enemy.visible).sort((a,b) => Math.max(Math.abs(a.x-(selected?.x ?? 0)),Math.abs(a.y-(selected?.y ?? 0))) - Math.max(Math.abs(b.x-(selected?.x ?? 0)),Math.abs(b.y-(selected?.y ?? 0))))[0]; if (target) queue(makeAction('shoot',{targetId:target.id})); else setNotice('射撃可能な敵影がありません。'); }} disabled={!selected || state.phase !== 'planning'} icon={<Target size={13}/>}/>
                <ActionButton label="警戒" onClick={() => queue(makeAction('overwatch',{direction:aimDirection}))} disabled={!selected || state.phase !== 'planning'} icon={<Shield size={13}/>}/>
                <ActionButton label="再装填" onClick={() => queue(makeAction('reload'))} disabled={!selected || state.phase !== 'planning' || selected.ammo === selected.maxAmmo} icon={<RotateCcw size={13}/>}/>
                <ActionButton label="扉操作" onClick={() => queue(makeAction('door',{x:selectedTile?.x ?? selected?.x,y:selectedTile?.y ?? selected?.y}))} disabled={!selected || state.phase !== 'planning'} icon={<Radio size={13}/>}/>
                <ActionButton label="回収" onClick={() => queue(makeAction('loot',{x:selectedTile?.x ?? selected?.x,y:selectedTile?.y ?? selected?.y}))} disabled={!selected || state.phase !== 'planning'} icon={<Radio size={13}/>}/>
                <ActionButton label="治療" onClick={() => { const target = units.filter(unit => !unit.downed && !unit.eliminated && unit.hp < 100 && Math.max(Math.abs(unit.x-(selected?.x ?? -9)),Math.abs(unit.y-(selected?.y ?? -9))) <= 1).sort((a,b) => a.hp - b.hp)[0]; if (target) queue(makeAction('heal',{targetId:target.id})); else setNotice('隣接した治療対象(負傷した生存者)がいません。'); }} disabled={!selected || state.phase !== 'planning'} icon={<HeartPulse size={13}/>}/>
                <ActionButton label="救出" onClick={() => { const target = units.find(unit => unit.downed && !unit.eliminated && Math.max(Math.abs(unit.x-(selected?.x ?? -9)),Math.abs(unit.y-(selected?.y ?? -9))) <= 1); if (target) queue(makeAction('rescue',{targetId:target.id})); else setNotice('隣接したダウン中の味方がいません。救出には隣のマスまで移動してください。'); }} disabled={!selected || state.phase !== 'planning'} icon={<Shield size={13}/>}/>
                <ActionButton label="ハック" onClick={() => queue(makeAction('hack',{x:selectedTile?.x ?? selected?.x,y:selectedTile?.y ?? selected?.y}))} disabled={!selected || state.phase !== 'planning'} icon={<Wifi size={13}/>}/>
                <ActionButton label="展開" onClick={() => queue(makeAction('deploy',{x:selectedTile?.x ?? selected?.x,y:selectedTile?.y ?? selected?.y}))} disabled={!selected || state.phase !== 'planning'} icon={<Crosshair size={13}/>}/>
              </div>
              <label className="mono mt-3 block text-[9px] tracking-widest text-[#69716d]">警戒方向
                <select value={aimDirection} onChange={e => setAimDirection(e.target.value as Direction)} className="mt-1 w-full border border-[#c4bfb3] bg-[#e9e5da] px-2 py-2 text-xs text-[#20282c]">
                  <option value="N">北</option><option value="NE">北東</option><option value="E">東</option><option value="SE">南東</option><option value="S">南</option><option value="SW">南西</option><option value="W">西</option><option value="NW">北西</option>
                </select>
              </label>
              {selected?.isNpc && <label className="mono mt-3 block text-[9px] tracking-widest text-[#69716d]">NPC COMMAND
                <select value={selected.command || 'follow'} onChange={e => changeNpcCommand(e.target.value as NonNullable<Unit['command']>)} className="mt-1 w-full border border-[#c4bfb3] bg-[#f0ede4] px-2 py-2 text-xs text-[#20282c]">
                  <option value="follow">追従</option><option value="defend">守備</option><option value="support">援護</option><option value="scout">偵察</option><option value="retreat">撤退</option>
                </select>
              </label>}
            </div>
            <div className="border border-[#bcb8ad] bg-[#e2ded2] p-3">
              <div className="mb-2 flex items-center justify-between"><b className="text-xs">補給・増援</b><span className="mono text-[9px]">{state.credits} CR</span></div>
              <div className="grid grid-cols-2 gap-1.5">
                {([
                  ['precision-rifle','精密ライフル',300],['light-armor','軽装甲',200],
                  ['heavy-armor','重装甲',500],['night-vision','暗視装置',250],
                  ['medkit','医療キット',150],['ammo','弾薬補給',100],
                ] as [Equipment,string,number][]).map(([item,label,cost]) => <button key={item} onClick={() => purchase(item)} disabled={!selected || state.phase !== 'planning' || state.credits < cost || updateRoom.isPending} className="border border-[#c4bfb3] bg-[#f0ede4] px-2 py-2 text-left text-[9px] hover:border-[#c84b32] disabled:opacity-40">{label}<span className="mono ml-1 text-[#8a6b4f]">{cost}</span></button>)}
              </div>
              <div className="mt-3 border-t border-[#bcb8ad] pt-2">
                <div className="mb-2 flex items-center justify-between"><span className="mono text-[9px] tracking-widest text-[#69716d]">増援枠 {reinforcement.used}/{reinforcement.limit}</span><span className="mono text-[8px] text-[#8b9189]">{reinforcement.commanderActive ? '指揮官: 枠+1' : reinforcement.commanderDown ? '指揮官ダウン中: 枠2・到着済みは残留' : '指揮官なし: 枠2'}</span></div>
                <div className="grid grid-cols-2 gap-1.5">{([
                  ['rifle','ライフル兵',400],['scout','偵察兵',350],['support','支援兵',450],['guard','守備兵',300],
                ] as [ReinforcementType,string,number][]).map(([type,label,cost]) => <button key={type} onClick={() => hire(type)} disabled={state.phase !== 'planning' || state.credits < cost || updateRoom.isPending} className="border border-[#c4bfb3] bg-[#e9e5da] px-2 py-2 text-left text-[9px] hover:border-[#c84b32] disabled:opacity-40">{label}<span className="mono ml-1 text-[#8a6b4f]">{cost}</span></button>)}</div>
                {state.reinforcements.length > 0 && <ul className="mt-2 space-y-1 pl-4 text-[9px] text-[#69716d]">{state.reinforcements.map(item => <li key={item.id}>{item.type} — 第{item.arrivesOn}ラウンド到着予定</li>)}</ul>}
              </div>
            </div>
            <div className="border border-[#bcb8ad] bg-[#e2ded2] p-3"><div className="mb-2 flex justify-between"><b className="text-xs">目標進捗</b><span className="mono text-[10px]">{state.objective?.progress ?? 0} / {state.objective?.target ?? 0}</span></div><div className="h-1.5 bg-[#cac7bc]"><div className="h-full bg-[#567960] transition-all" style={{width:`${Math.min(100,((state.objective?.progress || 0) / Math.max(1,state.objective?.target || 1))*100)}%`}}/></div><p className="mb-0 mt-2 text-[10px] leading-4 text-[#737c78]">{state.objective?.description}</p></div>
          </aside>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto]">
          <div className="flex min-h-[76px] items-center justify-between gap-4 border border-[#bcb8ad] bg-[#e2ded2] px-4 py-3">
            <div className="min-w-0"><div className="mono mb-2 text-[9px] tracking-widest text-[#7b827e]">QUEUED ORDERS / {selectedOrders.length}</div><div className="flex flex-wrap gap-1.5">{selectedOrders.length ? selectedOrders.map((order,index)=><span key={index} className="border border-[#b9b7aa] bg-[#f0ede4] px-2 py-1 text-[10px]">{index+1}. {actionTitle(order)}</span>) : <span className="text-[10px] text-[#858a83]">まだ指示はありません。マスを選んで移動を指示。</span>}</div></div>
            <button onClick={() => selected && publish({ ...state, soldiers: state.soldiers.map(unit => unit.id === selected.id ? { ...unit, orders: [] } : unit) })} disabled={!selected || state.phase !== 'planning' || !selectedOrders.length} data-testid="button-clear-orders" className="shrink-0 border border-[#bcb8ad] px-3 py-2 text-[10px] disabled:opacity-40"><RotateCcw size={13}/></button>
          </div>
          <button onClick={execute} disabled={state.phase !== 'planning' || updateRoom.isPending} data-testid="button-execute-round" className="flex min-h-[76px] min-w-[210px] items-center justify-between bg-[#c84b32] px-5 text-left text-[#f7f2e9] transition hover:bg-[#a83d2a] disabled:cursor-not-allowed disabled:bg-[#8c8e84]"><span><span className="mono block text-[9px] tracking-[.2em] opacity-75">{updateRoom.isPending ? 'SYNCING...' : 'EXECUTION WINDOW'}</span><b className="display mt-1 block text-2xl">{state.phase === 'planning' ? 'ラウンド実行' : state.phase === 'execution' ? '処理中' : '作戦終了'}</b></span><ArrowLeft className="rotate-180" size={18}/></button>
        </div>
        {notice && <div className="mt-2 flex items-center justify-between border-l-2 border-[#c84b32] bg-[#f0ede4] px-3 py-2 text-xs" role="status" data-testid="status-game-notice">{notice}<button onClick={() => setNotice('')} className="mono text-[9px] text-[#858a83]">DISMISS</button></div>}
      </section>
      <aside className="border border-[#bcb8ad] bg-[#20282c] text-[#e9e5da] xl:col-start-2 xl:row-start-1">
        <div className="flex items-center justify-between border-b border-[#3a4446] px-4 py-3"><div><span className="mono block text-[9px] tracking-widest text-[#d17a62]">FIELD LOG</span><b className="text-xs">戦況記録</b></div><span className="mono text-[9px] text-[#8e9b91]">LIVE FEED</span></div>
        <div className="max-h-[230px] space-y-2 overflow-auto p-3 xl:max-h-[calc(100dvh-230px)]">{state.log?.length ? [...state.log].reverse().map((entry,index)=><div key={index} className="flex gap-2 border-b border-[#384246] pb-2 text-[10px] leading-5"><span className="mono shrink-0 text-[#bd7860]">{String(index+1).padStart(2,'0')}</span><span className="text-[#c5ccc3]">{entryText(entry)}</span></div>) : <p className="text-xs leading-6 text-[#9da79d]">ログはまだありません。作戦行動を実行するとここに記録されます。</p>}</div>
        <div className="border-t border-[#3a4446] p-3">
          <div className="mono mb-2 flex justify-between text-[9px] tracking-widest text-[#91a095]"><span>ALLIED SIGNAL</span><span>{local ? 'LOCAL ONLY' : 'TEAM / PRIVATE'}</span></div>
          {!local ? <>
            <div className="mb-2 flex max-h-36 flex-col gap-2 overflow-auto">
              {(query.data?.messages || []).slice(-8).map(message => <div key={message.id} className="border-l border-[#65756a] pl-2 text-[9px] leading-4"><span className="mono text-[#bd7860]">{message.senderName} · {new Date(message.sentAt).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})}</span><p className="m-0 break-words text-[#d0d5cc]">{message.body}</p></div>)}
              {!query.data?.messages?.length && <p className="m-0 text-[9px] text-[#9da79d]">チーム専用通信。ここに全体チャットはありません。</p>}
            </div>
            <div className="mb-2 flex flex-wrap gap-1">{['敵発見','援護要請','物資発見','集合','撤退','ここを守れ','構えろ'].map(text => <button key={text} onClick={() => sendTeamMessage(text)} disabled={sendMessage.isPending} className="border border-[#46514e] px-1.5 py-1 text-[8px] text-[#d0d5cc] hover:border-[#bd7860] disabled:opacity-50">{text}</button>)}</div>
            <form onSubmit={submitTeamMessage} className="flex gap-1.5"><input value={chatDraft} onChange={event => setChatDraft(event.target.value)} maxLength={400} aria-label="チーム通信" placeholder="味方へメッセージ…" className="min-w-0 flex-1 border border-[#46514e] bg-[#283235] px-2 py-2 text-[9px] text-[#f0ede4] outline-none focus:border-[#bd7860]"/><button disabled={sendMessage.isPending || !chatDraft.trim()} aria-label="送信" className="border border-[#46514e] px-2 text-[9px] text-[#d0d5cc] disabled:opacity-40">送信</button></form>
          </> : <p className="m-0 text-[10px] leading-5 text-[#c5ccc3]">ソロ作戦では他のプレイヤーへの通信は無効です。</p>}
        </div>
      </aside>
    </div>
  </main>;
}

function UnitCard({ unit, selected, onSelect }: { unit: Unit; selected: boolean; onSelect: () => void }) {
  return <button onClick={onSelect} data-testid={`button-unit-${unit.id}`} className={`w-full border px-3 py-2 text-left ${selected ? 'border-[#c84b32] bg-[#f0ede4]' : 'border-transparent bg-[#ebe7dc] hover:border-[#bcb8ad]'} ${unit.downed ? 'opacity-55' : ''}`}>
    <div className="flex items-center justify-between gap-2"><span className="truncate text-xs font-bold">{unit.name}</span><span className="mono text-[8px] text-[#7a817d]">{roleNames[unit.role]}</span></div>
    <div className="mt-2 flex items-center gap-2"><div className="h-1 flex-1 bg-[#d1cec2]"><div className={`h-full ${unit.downed ? 'bg-[#8b4b43]' : 'bg-[#567960]'}`} style={{width:`${Math.max(0,Math.min(100,unit.hp))}%`}}/></div><span className="mono text-[8px]">{unit.eliminated ? '退場' : unit.downed ? `DOWN ${unit.bleedRounds ?? ''}R` : `${unit.hp} HP`}</span><span className="mono text-[8px] text-[#727a76]">{unit.ammo}/{unit.maxAmmo}</span></div>
  </button>;
}

function ActionButton({label,onClick,disabled,icon}:{label:string;onClick:()=>void;disabled:boolean;icon:ReactNode}) {
  return <button onClick={onClick} disabled={disabled} data-testid={`button-action-${label}`} className="flex items-center justify-center gap-1.5 border border-[#c4bfb3] bg-[#e9e5da] py-2 text-[10px] hover:border-[#c84b32] disabled:cursor-not-allowed disabled:opacity-40">{icon}{label}</button>;
}
