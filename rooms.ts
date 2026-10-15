import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as E from "./engine.ts";

/**
 * Authoritative room/match logic. Everything that decides outcomes (orders, combat,
 * funds, victory) runs here; clients only send intentions and receive a per-team view.
 * No Express / I/O in this file so it can be unit-tested directly.
 */

export type Mode = "coop" | "solo" | "team";
export type RoomStatus = "lobby" | "playing" | "finished";

export type LobbyPlayer = {
  id: string;
  token: string;
  name: string;
  role: E.Role;
  team: string;
  /** Lobby: ready to start. In a match: finished planning this round. */
  ready: boolean;
  lastSeen: number;
};

export type ChatMessage = { id: string; senderId: string; senderName: string; body: string; sentAt: number };

export type Room = {
  code: string;
  mode: Mode;
  hostId: string;
  players: LobbyPlayer[];
  status: RoomStatus;
  match: E.GameState | null;
  version: number;
  /** Team chat. Messages are stored per team and only ever returned to that team. */
  chat: Record<string, ChatMessage[]>;
  createdAt: number;
  updatedAt: number;
  chatTimes: Record<string, number[]>;
};

export type Registry = { rooms: Map<string, Room> };
export const createRegistry = (): Registry => ({ rooms: new Map() });

export const PLAN_MS = 45_000;
export const EXEC_MS = 8_000;
export const ROOM_TTL_MS = 3 * 60 * 60 * 1000;
export const MAX_ROOMS = 200;
const MAX_NAME = 20;
const CHAT_MAX = 300;
const CHAT_BURST = 5;
const CHAT_WINDOW_MS = 10_000;
const ROLES: E.Role[] = ["assault", "scout", "hacker", "medic", "engineer", "commander"];
const ITEMS: E.Equipment[] = ["precision-rifle", "light-armor", "heavy-armor", "night-vision", "medkit", "ammo"];
const HIRES: E.ReinforcementType[] = ["rifle", "scout", "support", "guard"];
const COMMANDS = ["follow", "defend", "support", "scout", "retreat"] as const;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class RoomError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const fail = (status: number, message: string): never => {
  throw new RoomError(status, message);
};

function cleanName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, MAX_NAME) : "";
  return name || "オペレーター";
}

function cleanRole(raw: unknown): E.Role {
  return ROLES.includes(raw as E.Role) ? (raw as E.Role) : "assault";
}

function newCode(registry: Registry): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = Array.from(randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    if (!registry.rooms.has(code)) return code;
  }
  return fail(503, "ルームコードを生成できません。");
}

export function maxPlayers(mode: Mode): number {
  return mode === "coop" ? 2 : 8;
}

function nextTeam(room: Room): string {
  if (room.mode === "coop") return "ally";
  if (room.mode === "solo") {
    return E.TEAM_IDS.find((team) => !room.players.some((p) => p.team === team)) ?? E.TEAM_IDS[0];
  }
  for (const team of E.TEAM_IDS) {
    if (room.players.filter((p) => p.team === team).length < 2) return team;
  }
  return E.TEAM_IDS[0];
}

function touch(room: Room, now: number): void {
  room.version += 1;
  room.updatedAt = now;
}

export function pruneRooms(registry: Registry, now: number): void {
  for (const [code, room] of registry.rooms) {
    if (now - room.updatedAt > ROOM_TTL_MS) registry.rooms.delete(code);
  }
}

export function createRoom(
  registry: Registry,
  input: { name?: unknown; mode?: unknown; role?: unknown },
  now: number,
): { room: Room; player: LobbyPlayer } {
  pruneRooms(registry, now);
  if (registry.rooms.size >= MAX_ROOMS) fail(503, "サーバーが混み合っています。しばらくしてから再試行してください。");
  const mode = input.mode;
  if (mode !== "coop" && mode !== "solo" && mode !== "team") return fail(400, "ゲームモードが正しくありません。");
  const player: LobbyPlayer = {
    id: randomUUID(),
    token: randomBytes(24).toString("hex"),
    name: cleanName(input.name),
    role: cleanRole(input.role),
    team: mode === "coop" ? "ally" : E.TEAM_IDS[0],
    ready: false,
    lastSeen: now,
  };
  const room: Room = {
    code: newCode(registry),
    mode,
    hostId: player.id,
    players: [player],
    status: "lobby",
    match: null,
    version: 0,
    chat: {},
    createdAt: now,
    updatedAt: now,
    chatTimes: {},
  };
  registry.rooms.set(room.code, room);
  return { room, player };
}

export function getRoom(registry: Registry, code: unknown): Room {
  const key = typeof code === "string" ? code.trim().toUpperCase() : "";
  return registry.rooms.get(key) ?? fail(404, "ルームが見つかりません。コードを確認してください。");
}

export function joinRoom(
  registry: Registry,
  code: unknown,
  input: { name?: unknown; role?: unknown },
  now: number,
): { room: Room; player: LobbyPlayer } {
  const room = getRoom(registry, code);
  if (room.status !== "lobby") fail(409, "このルームはすでに作戦中です。");
  if (room.players.length >= maxPlayers(room.mode)) fail(409, "このルームは満員です。");
  const player: LobbyPlayer = {
    id: randomUUID(),
    token: randomBytes(24).toString("hex"),
    name: cleanName(input.name),
    role: cleanRole(input.role),
    team: nextTeam(room),
    ready: false,
    lastSeen: now,
  };
  room.players.push(player);
  for (const other of room.players) other.ready = false;
  touch(room, now);
  return { room, player };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function authenticate(room: Room, playerId: unknown, token: unknown): LobbyPlayer {
  const player = room.players.find((p) => p.id === playerId);
  if (!player || typeof token !== "string" || !safeEqual(player.token, token)) {
    return fail(403, "認証に失敗しました。このルームの参加者ではありません。");
  }
  return player;
}

export function setLobby(
  room: Room,
  player: LobbyPlayer,
  patch: { team?: unknown; role?: unknown; ready?: unknown },
  now: number,
): void {
  if (room.status !== "lobby") fail(409, "作戦開始後はロビー設定を変更できません。");
  if (patch.role !== undefined) {
    if (!ROLES.includes(patch.role as E.Role)) fail(400, "役職が正しくありません。");
    player.role = patch.role as E.Role;
  }
  if (patch.team !== undefined) {
    if (room.mode !== "team") fail(400, "チーム分けを変更できるのはチーム戦だけです。");
    const team = patch.team as string;
    if (!(E.TEAM_IDS as readonly string[]).includes(team)) fail(400, "チームが正しくありません。");
    if (team !== player.team && room.players.filter((p) => p.team === team).length >= 2) {
      fail(409, "そのチームは満員です(1チーム2人)。");
    }
    player.team = team;
  }
  if (patch.ready !== undefined) player.ready = patch.ready === true;
  if (patch.team !== undefined || patch.role !== undefined) {
    for (const other of room.players) if (other !== player) other.ready = false;
  }
  touch(room, now);
}

/** Human-readable reason the match cannot start yet, or null. */
export function startBlocker(room: Room): string | null {
  const n = room.players.length;
  if (room.mode === "coop" && n !== 2) return "協力戦は2人そろってから開始できます。";
  if (room.mode === "solo" && (n < 2 || n > 8)) return "ソロ戦は2〜8人で開始できます。";
  if (room.mode === "team") {
    if (![4, 6, 8].includes(n)) return "チーム戦は4・6・8人で開始できます。";
    const teams = new Map<string, number>();
    for (const p of room.players) teams.set(p.team, (teams.get(p.team) ?? 0) + 1);
    if ([...teams.values()].some((count) => count !== 2)) return "すべてのチームを2人にそろえてください。";
  }
  if (room.players.some((p) => !p.ready)) return "全員の準備完了を待っています。";
  return null;
}

export function startMatch(room: Room, player: LobbyPlayer, now: number): void {
  if (room.status !== "lobby") fail(409, "すでに開始されています。");
  if (player.id !== room.hostId) fail(403, "作戦を開始できるのはホストだけです。");
  const blocker = startBlocker(room);
  if (blocker) fail(409, blocker);
  if (room.mode === "coop") {
    const [a, b] = room.players as [LobbyPlayer, LobbyPlayer];
    room.match = E.createMission(a.role, b.role, [a.id, b.id]);
  } else {
    room.match = E.createMatch(
      room.mode,
      room.players.map((p) => ({ id: p.id, name: p.name, role: p.role, team: p.team })),
    );
  }
  room.match.phaseEndsAt = now + PLAN_MS;
  room.status = "playing";
  for (const p of room.players) p.ready = false;
  touch(room, now);
}

function ownUnit(room: Room, player: LobbyPlayer, unitId: unknown): E.Unit {
  const unit = room.match?.soldiers.find((u) => u.id === unitId);
  if (!unit || unit.isNpc || unit.ownerId !== player.id) return fail(403, "このオペレーターの操作権限がありません。");
  return unit;
}

function requirePlaying(room: Room): E.GameState {
  if (room.status !== "playing" || !room.match) return fail(409, "作戦は進行中ではありません。");
  return room.match;
}

const unitTeam = (unit: E.Unit): string => unit.team ?? "ally";

/**
 * Replaces the player's own unit orders for the current planning phase. Every action is
 * re-validated by the engine; anything it refuses is reported back instead of silently kept.
 */
export function submitOrders(
  room: Room,
  player: LobbyPlayer,
  input: { round?: unknown; unitId?: unknown; actions?: unknown },
  now: number,
): { accepted: number; rejected: number } {
  let match = requirePlaying(room);
  if (match.phase !== "planning") fail(409, "計画フェーズではありません。");
  if (input.round !== match.round) fail(409, "ラウンドが更新されています。最新の状態を取得してください。");
  const unit = ownUnit(room, player, input.unitId);
  if (!Array.isArray(input.actions) || input.actions.length > 8) fail(400, "行動データが正しくありません。");
  const actions = input.actions as unknown[];
  match = structuredClone(match);
  const mine = match.soldiers.find((u) => u.id === unit.id)!;
  mine.orders = [];
  let accepted = 0;
  for (const raw of actions) {
    const action = sanitizeAction(raw);
    if (!action) continue;
    const before = match.soldiers.find((u) => u.id === unit.id)!.orders.length;
    match = E.queueAction(match, unit.id, action);
    if (match.soldiers.find((u) => u.id === unit.id)!.orders.length > before) accepted += 1;
  }
  room.match = match;
  player.ready = false;
  touch(room, now);
  return { accepted, rejected: actions.length - accepted };
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= -1 && v < 64;
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length < 64;
const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function sanitizeAction(raw: unknown): E.GameAction | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  switch (a.type) {
    case "move":
    case "door":
    case "loot":
    case "hack":
    case "deploy":
      return isInt(a.x) && isInt(a.y) ? ({ type: a.type, x: a.x, y: a.y } as E.GameAction) : null;
    case "shoot":
    case "heal":
    case "rescue":
      return isId(a.targetId) ? ({ type: a.type, targetId: a.targetId } as E.GameAction) : null;
    case "overwatch":
      return a.direction === undefined
        ? { type: "overwatch" }
        : DIRS.includes(a.direction as string)
          ? { type: "overwatch", direction: a.direction as E.Direction }
          : null;
    case "reload":
      return { type: "reload" };
    default:
      return null;
  }
}

export type TeamAction =
  | { kind: "buy"; unitId: unknown; item: unknown }
  | { kind: "hire"; type: unknown; command?: unknown }
  | { kind: "command"; unitId: unknown; command: unknown; x?: unknown; y?: unknown };

export function teamAction(room: Room, player: LobbyPlayer, input: TeamAction, now: number): void {
  const match = requirePlaying(room);
  if (match.phase !== "planning") fail(409, "計画フェーズではありません。");
  const myUnit = match.soldiers.find((u) => u.ownerId === player.id);
  if (!myUnit) return fail(403, "操作できるオペレーターがいません。");
  const team = unitTeam(myUnit);
  if (input.kind === "buy") {
    const unit = ownUnit(room, player, input.unitId);
    if (!ITEMS.includes(input.item as E.Equipment)) fail(400, "装備が正しくありません。");
    room.match = E.buyEquipment(match, unit.id, input.item as E.Equipment);
  } else if (input.kind === "hire") {
    if (!HIRES.includes(input.type as E.ReinforcementType)) fail(400, "増援の種類が正しくありません。");
    const command = COMMANDS.includes(input.command as never) ? (input.command as (typeof COMMANDS)[number]) : "follow";
    room.match = E.hireReinforcement(match, input.type as E.ReinforcementType, command, team);
  } else if (input.kind === "command") {
    const npc = match.soldiers.find((u) => u.id === input.unitId);
    if (!npc || !npc.isNpc || unitTeam(npc) !== team) return fail(403, "命令できるのは自チームのNPCだけです。");
    if (!COMMANDS.includes(input.command as never)) fail(400, "命令が正しくありません。");
    const target = isInt(input.x) && isInt(input.y) ? { x: input.x, y: input.y } : undefined;
    room.match = E.setUnitCommand(match, npc.id, input.command as (typeof COMMANDS)[number], target);
  } else {
    fail(400, "操作が正しくありません。");
  }
  touch(room, now);
}

export function setPlanningReady(room: Room, player: LobbyPlayer, ready: boolean, now: number): void {
  const match = requirePlaying(room);
  if (match.phase !== "planning") fail(409, "計画フェーズではありません。");
  player.ready = ready;
  touch(room, now);
}

export function sendChat(room: Room, player: LobbyPlayer, body: unknown, now: number): void {
  if (typeof body !== "string" || !body.trim()) fail(400, "メッセージが空です。");
  const text = (body as string).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, CHAT_MAX);
  const times = (room.chatTimes[player.id] ?? []).filter((t) => now - t < CHAT_WINDOW_MS);
  if (times.length >= CHAT_BURST) fail(429, "送信が早すぎます。少し待ってください。");
  times.push(now);
  room.chatTimes[player.id] = times;
  const team = player.team;
  const list = (room.chat[team] ??= []);
  list.push({ id: randomUUID(), senderId: player.id, senderName: player.name, body: text, sentAt: now });
  if (list.length > 150) list.splice(0, list.length - 150);
  touch(room, now);
}

function humansStillPlanning(room: Room): LobbyPlayer[] {
  const match = room.match;
  if (!match) return [];
  return room.players.filter((p) =>
    match.soldiers.some((u) => u.ownerId === p.id && !u.downed && !u.eliminated),
  );
}

/** Advances timers. Call about twice a second. Returns true if the match state changed. */
export function tickRoom(room: Room, now: number): boolean {
  const match = room.match;
  if (room.status !== "playing" || !match) return false;
  if (match.phase === "planning") {
    const active = humansStillPlanning(room);
    const allReady = active.length > 0 && active.every((p) => p.ready);
    if (now < match.phaseEndsAt && !allReady) return false;
    const next = E.executeRound(match);
    next.phaseEndsAt = now + EXEC_MS;
    room.match = next;
  } else if (match.phase === "execution") {
    if (now < match.phaseEndsAt) return false;
    const next = E.advanceRound(match);
    next.phaseEndsAt = now + PLAN_MS;
    room.match = next;
    for (const p of room.players) p.ready = false;
  } else {
    room.status = "finished";
  }
  const phase = room.match!.phase;
  if (phase === "victory" || phase === "defeat") room.status = "finished";
  touch(room, now);
  return true;
}

export function tickAll(registry: Registry, now: number): void {
  for (const room of registry.rooms.values()) {
    try {
      tickRoom(room, now);
    } catch {
      room.status = "finished";
    }
  }
  pruneRooms(registry, now);
}

/** Everything a player may see. Never includes tokens, other teams' state, or other teams' chat. */
export function viewForPlayer(room: Room, player: LobbyPlayer, now: number) {
  player.lastSeen = now;
  const inLobby = room.status === "lobby";
  const visiblePlayers = inLobby ? room.players : room.players.filter((p) => p.team === player.team);
  return {
    code: room.code,
    mode: room.mode,
    status: room.status,
    version: room.version,
    serverNow: now,
    hostId: room.hostId,
    you: { id: player.id, team: player.team, role: player.role },
    players: visiblePlayers.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      team: p.team,
      ready: p.ready,
      connected: now - p.lastSeen < 15_000,
    })),
    startBlocker: inLobby ? startBlocker(room) : null,
    match: room.match ? E.viewFor(room.match, player.team) : null,
    chat: room.chat[player.team] ?? [],
  };
}
