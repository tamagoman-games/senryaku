import { type FormEvent, useState } from 'react';
import { useLocation, useParams } from 'wouter';
import { ArrowLeft, Copy, MessageSquare, Radio, Send, ShieldCheck, Users } from 'lucide-react';
import { useGetGameRoom, getGetGameRoomQueryKey, useSendGameRoomMessage } from './api-client';
import { useQueryClient } from '@tanstack/react-query';

export default function RoomPage() {
  const { code = '' } = useParams<{ code: string }>();
  const [, navigate] = useLocation();
  const cache = useQueryClient();
  const playerId = localStorage.getItem(`ff-player-${code}`) || '';
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const roomQuery = useGetGameRoom(code, { query: { queryKey: getGetGameRoomQueryKey(code), refetchInterval: 1800 } });
  const envelope = roomQuery.data;
  const sendMessage = useSendGameRoomMessage();
  const players = envelope?.room.players || [];
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || !playerId) return;
    setError('');
    sendMessage.mutate({ code, data: { playerId, body: draft.trim() } }, {
      onSuccess: next => { cache.setQueryData(getGetGameRoomQueryKey(code), next); setDraft(''); },
      onError: () => setError('送信できませんでした。通信を確認してください。'),
    });
  };
  const copyCode = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); window.setTimeout(() => setCopied(false), 1600); }
    catch { setError('コードをコピーできませんでした。'); }
  };
  if (roomQuery.isLoading) return <div className="min-h-[100dvh] bg-[#e9e5da] p-6"><div className="mx-auto max-w-4xl animate-pulse"><div className="h-8 w-48 bg-[#d7d2c7]"/><div className="mt-8 h-72 bg-[#e1ddd2]"/></div></div>;
  if (roomQuery.isError || !envelope) return <main className="grid min-h-[100dvh] place-items-center bg-[#e9e5da] p-6"><section className="max-w-md border border-[#c4bfb3] bg-[#f0ede4] p-7"><p className="mono text-xs tracking-widest text-[#bd4c35]">LINK ERROR / 01</p><h1 className="display text-4xl">ルームを取得できません</h1><p className="text-sm text-[#626c6d]">コードを確認して再接続してください。</p><button onClick={() => roomQuery.refetch()} data-testid="button-retry-room" className="mt-4 bg-[#20282c] px-4 py-3 text-sm text-[#f0ede4]">再接続</button></section></main>;

  const messages = envelope.messages || [];
  return <main className="min-h-[100dvh] bg-[#e9e5da] text-[#20282c]">
    <header className="flex items-center justify-between border-b border-[#bcb8ad] px-4 py-4 md:px-10">
      <button onClick={() => navigate('/')} data-testid="button-back-home" className="flex items-center gap-2 text-xs text-[#596368] hover:text-[#c84b32]"><ArrowLeft size={15}/> 作戦選択へ</button>
      <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#567960]"/><span className="mono text-[9px] tracking-[.18em]">SECURE CHANNEL / CO-OP</span></div>
    </header>
    <div className="mx-auto max-w-6xl px-4 py-7 md:px-8 md:py-12">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div><p className="mono mb-1 text-[10px] tracking-[.2em] text-[#bd4c35]">OPERATION ROOM / {envelope.room.status === 'active' ? 'ACTIVE' : 'STANDBY'}</p><h1 className="display m-0 text-5xl md:text-7xl">二人で作戦を組む。</h1></div>
        <div className="border border-[#bcb8ad] bg-[#e2ded2] px-4 py-3"><span className="mono block text-[9px] tracking-widest text-[#7a807d]">ROOM CODE</span><div className="flex items-center gap-3"><strong className="mono text-2xl tracking-[.16em]">{code}</strong><button onClick={copyCode} data-testid="button-copy-room-code" aria-label="コードをコピー" className="border border-[#bcb8ad] p-2 hover:border-[#c84b32]"><Copy size={15}/></button></div>{copied && <span className="mono text-[9px] text-[#567960]">COPIED</span>}</div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <section className="border border-[#bcb8ad] bg-[#e2ded2]">
          <div className="flex items-center justify-between border-b border-[#bcb8ad] px-5 py-4"><div className="flex items-center gap-2"><Users size={16}/><h2 className="m-0 text-sm font-bold">オペレーターロスター</h2></div><span className="mono text-[10px]">{players.length} / 2 LINKED</span></div>
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            {[0, 1].map(i => {
              const player = players[i];
              const mine = player?.id === playerId;
              return <div key={i} data-testid={`card-player-slot-${i + 1}`} className={`relative min-h-[160px] border p-5 ${player ? 'border-[#9a9f94] bg-[#f0ede4]' : 'border-dashed border-[#bcb8ad] bg-[#e9e5da]'}`}>
                <span className="mono text-[9px] tracking-widest text-[#858b85]">OPERATOR / 0{i + 1}</span>
                {player ? <><div className="mt-5 flex items-center gap-3"><div className="grid h-10 w-10 place-items-center border border-[#c84b32] text-sm font-bold text-[#c84b32]">{player.name.slice(0, 1)}</div><div><b className="text-sm">{player.name}</b><p className="mono m-0 mt-1 text-[9px] tracking-widest text-[#708074]">{mine ? 'YOU / CONNECTED' : 'ALLY / CONNECTED'}</p></div></div><ShieldCheck className="absolute right-4 top-4 text-[#567960]" size={17}/></> :
                  <div className="mt-5 flex items-center gap-3 text-[#989a91]"><div className="grid h-10 w-10 place-items-center border border-dashed border-[#bcb8ad]"><Radio size={16}/></div><div><b className="text-sm">参加者を待機中</b><p className="mono m-0 mt-1 text-[9px] tracking-widest">AWAITING LINK</p></div></div>}
              </div>;
            })}
          </div>
          <div className="mx-4 mb-4 flex items-start gap-3 border-l-2 border-[#c84b32] bg-[#e9e5da] p-4"><span className="mono text-[9px] text-[#c84b32]">RULE</span><p className="m-0 text-xs leading-6 text-[#687174]">味方が接続すると作戦状態が共有されます。ルーム内のメッセージで役割と最初の一手を確認してください。</p></div>
          <div className="border-t border-[#bcb8ad] p-4">
            {envelope.room.status === 'active' ? <button onClick={() => navigate(`/game/${code}`)} data-testid="button-enter-operation" className="flex w-full items-center justify-between bg-[#c84b32] px-5 py-4 text-left text-[#f7f2e9] hover:bg-[#a83d2a]"><span><span className="mono block text-[9px] tracking-[.18em] opacity-75">BOTH OPERATORS LINKED</span><b className="mt-1 block text-sm">作戦画面へ進む</b></span><ArrowLeft className="rotate-180" size={17}/></button> :
              <div data-testid="status-waiting-player" className="mono flex items-center gap-3 bg-[#20282c] px-5 py-4 text-[10px] tracking-widest text-[#e9e5da]"><span className="h-2 w-2 animate-pulse rounded-full bg-[#d0ad5b]"/> SECOND OPERATOR REQUIRED / コードを共有してください</div>}
          </div>
        </section>
        {players.length === 2 && <section className="flex min-h-[430px] flex-col border border-[#bcb8ad] bg-[#e2ded2]">
          <div className="flex items-center justify-between border-b border-[#bcb8ad] px-4 py-4"><div className="flex items-center gap-2"><MessageSquare size={15}/><h2 className="m-0 text-sm font-bold">チーム通信</h2></div><span className="mono text-[9px] tracking-widest text-[#808781]">LIVE / {messages.length}</span></div>
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {messages.length ? messages.map(message => <article key={message.id} data-testid={`message-chat-${message.id}`} className={`max-w-[92%] border p-3 ${message.senderId === playerId ? 'ml-auto border-[#bd4c35] bg-[#f0ede4]' : 'border-[#bcb8ad] bg-[#e9e5da]'}`}><div className="mb-2 flex justify-between gap-3"><b className="text-xs">{message.senderName}</b><time className="mono text-[9px] text-[#858b85]">{new Date(message.sentAt).toLocaleTimeString('ja-JP', {hour:'2-digit', minute:'2-digit'})}</time></div><p className="m-0 whitespace-pre-wrap break-words text-xs leading-5">{message.body}</p></article>) :
            <div className="grid h-full min-h-[220px] place-items-center text-center"><div><span className="mono text-[9px] tracking-widest text-[#bd4c35]">CHANNEL CLEAR</span><p className="mt-2 text-xs text-[#77807d]">作戦前の確認をここで共有。</p></div></div>}
          </div>
          {error && <p role="alert" className="mx-4 text-xs text-[#a83d2a]">{error}</p>}
          <form onSubmit={send} className="flex gap-2 border-t border-[#bcb8ad] p-3"><input data-testid="input-chat-message" value={draft} maxLength={400} onChange={e => setDraft(e.target.value)} placeholder="通信メッセージ…" className="min-w-0 flex-1 border border-[#bcb8ad] bg-[#f0ede4] px-3 py-3 text-xs outline-none focus:border-[#c84b32]"/><button disabled={sendMessage.isPending || !draft.trim()} data-testid="button-send-message" aria-label="メッセージを送信" className="bg-[#20282c] px-4 text-[#f0ede4] disabled:opacity-40"><Send size={16}/></button></form>
        </section>}
        {players.length < 2 && <section className="flex min-h-[260px] flex-col items-center justify-center border border-dashed border-[#bcb8ad] bg-[#e2ded2] p-6 text-center"><MessageSquare size={19} className="text-[#999c91]"/><p className="mb-1 mt-3 text-sm font-semibold">チーム通信は接続後に開通</p><p className="m-0 max-w-[230px] text-xs leading-5 text-[#78807c]">二人目のオペレーターが参加すると、作戦用チャンネルが利用できます。</p><span className="mono mt-4 text-[9px] tracking-widest text-[#bd4c35]">CHANNEL SEALED / 01 OF 02 LINKED</span></section>}
      </div>
      {roomQuery.isFetching && <p className="mono mt-4 text-right text-[9px] tracking-widest text-[#96998e]">SYNCING ROOM STATE · v{envelope.room.version}</p>}
    </div>
  </main>;
}
