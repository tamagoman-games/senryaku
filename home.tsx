import { useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowUpRight, Crosshair, Radio, Shield, Signal, Users, Wifi } from 'lucide-react';
import { getHealthCheckQueryKey, useCreateGameRoom, useHealthCheck, useJoinGameRoom } from './api-client';
import type { Role } from './engine';

const roles: { id: Role; jp: string; en: string; mark: string; detail: string }[] = [
  { id: 'assault', jp: '突撃兵', en: 'ASSAULT', mark: '01', detail: '前線を押し上げる火力担当' },
  { id: 'scout', jp: '偵察兵', en: 'SCOUT', mark: '02', detail: '視界を切り開き、敵を捕捉' },
  { id: 'hacker', jp: 'ハッカー', en: 'HACKER', mark: '03', detail: '端末と防衛網を無力化' },
  { id: 'medic', jp: '衛生兵', en: 'MEDIC', mark: '04', detail: '負傷者を救出し、隊を維持' },
  { id: 'engineer', jp: '工兵', en: 'ENGINEER', mark: '05', detail: '装備と地形を戦力に変える' },
  { id: 'commander', jp: '指揮官', en: 'COMMANDER', mark: '06', detail: '戦況を読み、作戦を統率' },
];

export default function Home() {
  const [, navigate] = useLocation();
  const [mode, setMode] = useState<'solo' | 'coop'>('solo');
  const [role, setRole] = useState<Role>('assault');
  const [name, setName] = useState(localStorage.getItem('ff-name') || 'オペレーター');
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');
  const health = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 20000 } });
  const createRoom = useCreateGameRoom();
  const joinRoom = useJoinGameRoom();
  const busy = createRoom.isPending || joinRoom.isPending;

  const startSolo = () => {
    localStorage.setItem('ff-role', role);
    localStorage.setItem('ff-mode', 'solo');
    const code = `LOCAL-${Date.now().toString(36).toUpperCase()}`;
    navigate(`/game/${code}`);
  };
  const create = () => {
    setError('');
    localStorage.setItem('ff-name', name.trim());
    localStorage.setItem('ff-role', role);
    createRoom.mutate({ data: { name: name.trim() || 'オペレーター', role } }, {
      onSuccess: (envelope) => {
        localStorage.setItem(`ff-player-${envelope.room.code}`, envelope.playerId);
        localStorage.setItem(`ff-role-${envelope.room.code}`, role);
        navigate(`/room/${envelope.room.code}`);
      },
      onError: () => setError('通信を確立できませんでした。接続を確認して再試行してください。'),
    });
  };
  const join = () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) { setError('ルームコードを入力してください。'); return; }
    setError('');
    localStorage.setItem('ff-name', name.trim());
    joinRoom.mutate({ code, data: { name: name.trim() || 'オペレーター', role } }, {
      onSuccess: (envelope) => {
        localStorage.setItem(`ff-player-${code}`, envelope.playerId);
        localStorage.setItem(`ff-role-${code}`, role);
        navigate(`/room/${code}`);
      },
      onError: () => setError('参加できませんでした。コードが正しいか確認してください。'),
    });
  };

  return <main className="min-h-[100dvh] overflow-hidden bg-[#e9e5da] text-[#20282c]">
    <header className="flex items-center justify-between border-b border-[#bcb8ad] px-5 py-4 md:px-10">
      <a href="/" className="flex items-center gap-3 no-underline text-inherit" data-testid="link-home">
        <span className="grid h-9 w-9 place-items-center bg-[#c84b32] text-[#f6f1e6]"><Crosshair size={19}/></span>
        <span><b className="display text-xl leading-none">FALSE FRONT</b><span className="mono ml-3 text-[9px] tracking-[.18em] text-[#697276]">TACTICAL SIMULATION / 04</span></span>
      </a>
      <div className="mono flex items-center gap-2 text-[10px] uppercase tracking-widest text-[#596368]" data-testid="status-server">
        <span className={`h-2 w-2 rounded-full ${health.isError ? 'bg-[#bf4031]' : 'bg-[#567960]'}`}/>
        {health.isLoading ? 'CHECKING LINK' : health.isError ? 'LINK OFFLINE' : 'SYSTEM NOMINAL'}
      </div>
    </header>
    <div className="mx-auto grid max-w-[1440px] lg:grid-cols-[1fr_380px]">
      <section className="relative px-5 pb-10 pt-9 md:px-10 md:pt-14">
        <div className="absolute right-8 top-8 hidden select-none font-mono text-[9px] leading-5 tracking-[.22em] text-[#8d8c82] md:block">FIELD MANUAL 07<br/>KANTO EXCLUSION ZONE<br/>35°40' N / 139°42' E</div>
        <p className="mono mb-3 flex items-center gap-2 text-[10px] font-medium tracking-[.2em] text-[#bd4c35]"><span className="h-px w-8 bg-[#bd4c35]"/>OPERATION: FALSE FRONT</p>
        <h1 className="display max-w-[780px] text-[clamp(4.6rem,12vw,10.8rem)] leading-[.79] tracking-[-.035em]">NO ONE<br/><span className="text-[#c84b32]">MOVES</span><br/>ALONE.</h1>
        <div className="mt-8 flex max-w-2xl items-start gap-4 border-l-2 border-[#c84b32] pl-4">
          <span className="mono pt-1 text-[10px] text-[#c84b32]">BRIEF/01</span>
          <p className="m-0 max-w-lg text-sm leading-7 text-[#525d5f]">敵の視界に入る前に、二人のオペレーターで一手を組み立てる。短い計画、短い実行。その数秒が帰還を分ける。</p>
        </div>
        <div className="paper-grid relative mt-10 min-h-[190px] overflow-hidden border border-[#c9c4b8] bg-[#dedbcf] p-5 md:mt-14 md:min-h-[230px] md:p-8">
          <div className="absolute inset-0 opacity-50" style={{background:'radial-gradient(ellipse at 76% 50%, transparent 0 18%, #73837b 18.3% 18.7%, transparent 19% 30%, #73837b 30.3% 30.7%, transparent 31%)'}}/>
          <div className="relative flex h-full min-h-[150px] flex-col justify-between">
            <div className="flex justify-between"><span className="mono text-[9px] tracking-[.2em] text-[#707976]">AO / SHINJUKU-04</span><span className="mono text-[9px] text-[#707976]">MAP REF. K-19</span></div>
            <div className="flex items-end justify-between">
              <div><div className="mono mb-1 text-[9px] tracking-[.18em] text-[#bd4c35]">TACTICAL READOUT</div><div className="display text-3xl">計画して、実行する。</div></div>
              <div className="hidden items-center gap-2 md:flex"><span className="h-2 w-2 bg-[#c84b32]"/><span className="mono text-[9px] tracking-widest">FRIENDLY</span><span className="ml-4 h-2 w-2 bg-[#20282c]"/><span className="mono text-[9px] tracking-widest">HOSTILE</span></div>
            </div>
          </div>
          <div className="absolute left-[57%] top-[45%] h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border-2 border-[#c84b32] bg-[#dedbcf]"/>
          <div className="absolute left-[64%] top-[60%] h-2 w-2 rounded-full bg-[#20282c]"/>
          <div className="absolute left-[78%] top-[36%] h-2 w-2 rounded-full bg-[#20282c]"/>
           <div className="mono absolute bottom-5 right-5 text-[9px] text-[#727872]">GRID / 20 × 20</div>
        </div>
      </section>
      <aside className="border-t border-[#bcb8ad] bg-[#e2ded2] px-5 py-7 md:px-8 lg:border-l lg:border-t-0 lg:py-10">
        <div className="mb-6 flex items-center justify-between"><div><p className="mono m-0 text-[9px] tracking-[.2em] text-[#8b4a3a]">DEPLOYMENT</p><h2 className="display mb-0 mt-1 text-3xl">出撃準備</h2></div><span className="mono text-xs text-[#788080]">01 / 03</span></div>
        <div className="mb-5 grid grid-cols-2 border border-[#bcb8ad] p-1">
          <button onClick={() => setMode('solo')} data-testid="button-mode-solo" className={`flex items-center justify-center gap-2 py-3 text-xs font-bold transition ${mode === 'solo' ? 'bg-[#20282c] text-[#f0ece2]' : 'text-[#596368]'}`}><Shield size={14}/> ソロ作戦</button>
          <button onClick={() => setMode('coop')} data-testid="button-mode-coop" className={`flex items-center justify-center gap-2 py-3 text-xs font-bold transition ${mode === 'coop' ? 'bg-[#20282c] text-[#f0ece2]' : 'text-[#596368]'}`}><Users size={14}/> 協力作戦</button>
        </div>
        <label className="mono mb-2 block text-[9px] tracking-[.17em] text-[#687174]" htmlFor="operator-name">CALLSIGN / 通信名</label>
        <input id="operator-name" data-testid="input-operator-name" value={name} maxLength={24} onChange={e => setName(e.target.value)} className="mb-6 w-full border border-[#bcb8ad] bg-[#f0ede4] px-3 py-3 text-sm outline-none focus:border-[#c84b32]" placeholder="オペレーター" />
        <div className="mb-2 flex items-center justify-between"><label className="mono text-[9px] tracking-[.17em] text-[#687174]">ROLE / 担当</label><span className="mono text-[9px] text-[#90938c]">SELECT ONE</span></div>
        <div className="grid grid-cols-2 gap-2">
          {roles.map(r => <button key={r.id} onClick={() => setRole(r.id)} data-testid={`button-role-${r.id}`} className={`group relative min-h-[84px] border p-3 text-left transition ${role === r.id ? 'border-[#c84b32] bg-[#f2eee4]' : 'border-[#c8c3b7] bg-[#e9e5da] hover:border-[#8e9189]'}`}>
            <span className={`mono absolute right-2 top-2 text-[9px] ${role === r.id ? 'text-[#c84b32]' : 'text-[#9b9b91]'}`}>{r.mark}</span>
            <span className="display block text-lg leading-none">{r.jp}</span><span className="mono mt-1 block text-[9px] tracking-widest text-[#687174]">{r.en}</span><span className="mt-2 block text-[10px] text-[#777d7b]">{r.detail}</span>
          </button>)}
        </div>
        {mode === 'solo' ? <button onClick={startSolo} data-testid="button-start-solo" className="mt-6 flex w-full items-center justify-between bg-[#c84b32] px-5 py-4 text-left text-[#f7f2e9] transition hover:bg-[#a83d2a]"><span><span className="mono block text-[9px] tracking-[.2em] opacity-75">QUICK DEPLOYMENT</span><b className="mt-1 block text-sm">単独で作戦を開始</b></span><ArrowUpRight size={19}/></button> :
          <div className="mt-6 space-y-3">
            <button disabled={busy} onClick={create} data-testid="button-create-room" className="flex w-full items-center justify-between bg-[#c84b32] px-5 py-4 text-left text-[#f7f2e9] transition hover:bg-[#a83d2a] disabled:opacity-50"><span><span className="mono block text-[9px] tracking-[.2em] opacity-75">HOST A ROOM</span><b className="mt-1 block text-sm">{createRoom.isPending ? '回線を開いています…' : 'ルームを作成'}</b></span><Radio size={18}/></button>
            <div className="flex gap-2"><input aria-label="ルームコード" data-testid="input-room-code" value={joinCode} maxLength={12} onChange={e => setJoinCode(e.target.value.toUpperCase())} placeholder="ROOM CODE" className="min-w-0 flex-1 border border-[#bcb8ad] bg-[#f0ede4] px-3 py-3 font-mono text-xs tracking-widest outline-none focus:border-[#c84b32]"/><button disabled={busy} onClick={join} data-testid="button-join-room" className="flex items-center gap-2 border border-[#20282c] px-4 text-xs font-bold hover:bg-[#20282c] hover:text-[#f0ece2] disabled:opacity-50"><Wifi size={14}/>参加</button></div>
          </div>}
        {error && <p role="alert" data-testid="status-home-error" className="mt-3 border-l-2 border-[#c84b32] pl-3 text-xs leading-5 text-[#9f3f2f]">{error}</p>}
        <div className="mono mt-7 flex items-center justify-between border-t border-[#c9c4b8] pt-4 text-[9px] tracking-widest text-[#858981]"><span>ROUND-BASED / REAL-TIME EXECUTION</span><span>V. 0.4.1</span></div>
      </aside>
    </div>
    <footer className="flex flex-wrap justify-between gap-2 border-t border-[#bcb8ad] px-5 py-3 text-[9px] text-[#84877f] md:px-10"><span className="mono">FALSE FRONT / FIELD OPERATIONS SYSTEM</span><span>計画は静かに。実行は一瞬。</span><span className="mono flex items-center gap-2"><Signal size={12}/> 2-OPERATOR PROTOCOL</span></footer>
  </main>;
}
