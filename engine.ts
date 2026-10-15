export type Role =
  | "assault"
  | "scout"
  | "hacker"
  | "medic"
  | "engineer"
  | "commander";

export type Direction = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

export type Terrain =
  | "floor"
  | "wall"
  | "cover"
  | "door"
  | "objective"
  | "terminal"
  | "extraction"
  | "loot";

export type LootKind = "credits" | "ammo" | "medkit" | "intel";

export type Cell = {
  x: number;
  y: number;
  terrain: Terrain;
  visible: boolean;
  loot?: LootKind;
  lootAmount?: number;
  durability?: number;
  locked?: boolean;
  openDoor?: boolean;
};

type Position = { x: number; y: number };

export type GameAction =
  | ({ type: "move" } & Position)
  | { type: "shoot"; targetId: string }
  | { type: "overwatch"; direction?: Direction }
  | ({ type: "door" } & Position)
  | ({ type: "loot" } & Position)
  | { type: "heal"; targetId: string }
  | { type: "rescue"; targetId: string }
  | ({ type: "hack" } & Position)
  | ({ type: "deploy" } & Position)
  | { type: "reload" };

export type Unit = {
  id: string;
  name: string;
  role: Role;
  x: number;
  y: number;
  hp: number;
  ammo: number;
  maxAmmo: number;
  downed: boolean;
  orders: GameAction[];
  visible?: boolean;
  lastKnown?: Position | null;
  armor?: "none" | "light" | "heavy";
  weapon?: "standard" | "precision";
  medkits?: number;
  materials?: number;
  nightVision?: boolean;
  ownerId?: string;
  isNpc?: boolean;
  command?: "follow" | "defend" | "support" | "scout" | "retreat";
  overwatchDirection?: Direction;
  overwatchBonus?: boolean;
  // --- added in the engine rework (all optional, old snapshots stay valid) ---
  /** Fully removed from play (bled out). */
  eliminated?: boolean;
  /** Rounds left before a downed unit bleeds out. */
  bleedRounds?: number;
  /** 0..1 rescue progress accumulated on a downed unit. */
  rescueProgress?: number;
  rescueByMedic?: boolean;
  /** Round in which an engineer last placed cover. */
  deployedRound?: number;
  reaction?: number;
  cooldown?: number;
  reloading?: number;
  /** Enemy AI memory: where the unit is heading to investigate. */
  chase?: Position | null;
  /** NPC order target / enemy post. */
  commandTarget?: Position | null;
  /** Team id. Defaults: soldiers = "ally", enemies = "enemy". */
  team?: string;
  /** Teams that currently see this unit (maintained by the engine). */
  seenBy?: string[];
};

export type LogEntry = {
  message: string;
  round: number;
  time: string;
  /** If set, only these teams may read the entry. */
  teams?: string[];
};

export type GameMode = "coop" | "solo" | "team";

export type GameState = {
  round: number;
  phase: "planning" | "execution" | "victory" | "defeat";
  phaseEndsAt: number;
  soldiers: Unit[];
  enemies: Unit[];
  map: Cell[][];
  credits: number;
  materials: number;
  objective: {
    title: string;
    description: string;
    progress: number;
    target: number;
    complete: boolean;
  };
  extraction: Position;
  log: LogEntry[];
  reinforcements: Array<{
    id: string;
    type: "rifle" | "scout" | "support" | "guard";
    arrivesOn: number;
    command: NonNullable<Unit["command"]>;
    team?: string;
  }>;
  deployedCover: number;
  // --- multi-team (solo / team battle) extensions; absent in co-op missions ---
  mode?: GameMode;
  /** Funds per team. When absent the single `credits` pool is used. */
  funds?: Record<string, number>;
  teamMaterials?: Record<string, number>;
  /** Last confirmed foe positions per observing team: memory[team][unitId]. */
  memory?: Record<string, Record<string, Position>>;
  /** Tiles each team has ever seen: explored[team][y*20+x] = 1. */
  explored?: Record<string, number[]>;
  spawns?: Record<string, Position[]>;
  /** The team whose cells/units fill `visible` flags (default "ally"). */
  viewTeam?: string;
  winner?: string | null;
};

export type Equipment =
  | "precision-rifle"
  | "light-armor"
  | "heavy-armor"
  | "night-vision"
  | "medkit"
  | "ammo";

export type ReinforcementType = "rifle" | "scout" | "support" | "guard";

const MAP_SIZE = 20;
const MAX_ORDERS = 2;
const COVER_LIMIT = 4;

/** One execution phase = 20 ticks of 0.5 s (10 s of in-game time). */
export const TICKS_PER_ROUND = 20;
export const TICK_SECONDS = 0.5;
/** Rescue takes 3 s (6 ticks); a medic needs 1.5 s (3 ticks). */
export const RESCUE_TICKS = 6;
export const MEDIC_RESCUE_TICKS = 3;
export const BLEED_ROUNDS = 3;
const TILE_TICKS = 2; // 1 tile per second

let rng: () => number = Math.random;
/** Inject a deterministic RNG (tests, and later the authoritative server). */
export function setRandom(fn: () => number): void {
  rng = fn;
}

function addLog(state: GameState, message: string, audience?: string[]): void {
  state.log.push({
    ...(audience ? { teams: audience } : {}),
    message,
    round: state.round,
    time: new Date().toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  });
  if (state.log.length > 120) state.log.splice(0, state.log.length - 120);
}

function teamOf(state: GameState, unit: Unit): string {
  return unit.team ?? (state.soldiers.includes(unit) ? "ally" : "enemy");
}

function allUnits(state: GameState): Unit[] {
  return [...state.soldiers, ...state.enemies];
}

function foesOf(state: GameState, unit: Unit): Unit[] {
  const team = teamOf(state, unit);
  return allUnits(state).filter((other) => !other.eliminated && teamOf(state, other) !== team);
}

function seenByTeam(state: GameState, unit: Unit, team: string): boolean {
  return teamOf(state, unit) === team || (unit.seenBy ?? []).includes(team);
}

/** Teams allowed to read a log line about these units (their own teams + anyone who sees them). */
function audienceOf(state: GameState, units: Unit[]): string[] {
  const teams = new Set<string>();
  for (const unit of units) {
    teams.add(teamOf(state, unit));
    for (const seen of unit.seenBy ?? []) teams.add(seen);
  }
  return [...teams];
}

function fundsOf(state: GameState, team: string): number {
  return state.funds ? (state.funds[team] ?? 0) : state.credits;
}

function addFunds(state: GameState, team: string, amount: number): void {
  if (state.funds) state.funds[team] = (state.funds[team] ?? 0) + amount;
  else state.credits += amount;
}

function matsOf(state: GameState, team: string): number {
  return state.teamMaterials ? (state.teamMaterials[team] ?? 0) : state.materials;
}

function addMats(state: GameState, team: string, amount: number): void {
  if (state.teamMaterials) state.teamMaterials[team] = (state.teamMaterials[team] ?? 0) + amount;
  else state.materials += amount;
}

function makeUnit(
  id: string,
  name: string,
  role: Role,
  position: Position,
  team: "friendly" | "enemy",
): Unit {
  const friendly = team === "friendly";
  return {
    id,
    name,
    role,
    ...position,
    hp: 100,
    ammo: friendly ? 6 : 5,
    maxAmmo: friendly ? 6 : 5,
    downed: false,
    orders: [],
    visible: friendly,
    armor: "none",
    weapon: "standard",
    medkits: role === "medic" ? 2 : 1,
    materials: role === "engineer" ? 2 : 0,
    command: "follow",
    overwatchBonus: false,
  };
}

function makeMap(): Cell[][] {
  const map = Array.from({ length: MAP_SIZE }, (_, y) =>
    Array.from({ length: MAP_SIZE }, (_, x): Cell => ({
      x,
      y,
      terrain:
        x === 0 || y === 0 || x === MAP_SIZE - 1 || y === MAP_SIZE - 1
          ? "wall"
          : "floor",
      visible: false,
    })),
  );

  const set = (x: number, y: number, terrain: Terrain) => {
    map[y]![x]!.terrain = terrain;
  };

  for (let x = 4; x <= 15; x += 1) {
    if (x !== 8 && x !== 13) set(x, 5, "wall");
  }
  set(8, 5, "door");
  set(13, 5, "door");
  for (let y = 7; y <= 14; y += 1) {
    if (y !== 10 && y !== 13) set(9, y, "wall");
  }
  set(9, 10, "door");
  set(9, 13, "door");
  for (let x = 11; x <= 17; x += 1) {
    if (x !== 15) set(x, 12, "wall");
  }
  set(15, 12, "door");
  for (const row of map) {
    for (const cell of row) {
      if (cell.terrain === "door") cell.openDoor = true;
    }
  }
  map[5]![13]!.openDoor = false;
  map[5]![13]!.locked = true;

  for (const [x, y] of [
    [3, 6],
    [6, 8],
    [11, 8],
    [16, 7],
    [5, 14],
    [12, 15],
    [16, 16],
  ]) {
    set(x!, y!, "cover");
    map[y!]![x!]!.durability = 80;
  }

  set(14, 9, "objective");
  set(14, 10, "terminal");
  set(18, 17, "extraction");
  for (const [x, y, loot, amount] of [
    [4, 3, "credits", 180],
    [7, 9, "ammo", 1],
    [15, 15, "medkit", 1],
    [12, 18, "credits", 120],
    [6, 16, "intel", 1],
    [17, 2, "credits", 250],
  ] as const) {
    map[y]![x]!.terrain = "loot";
    map[y]![x]!.loot = loot;
    map[y]![x]!.lootAmount = amount;
  }
  return map;
}

export function createMission(
  role: Role = "assault",
  requestedPartnerRole?: Role,
  owners?: [string, string],
): GameState {
  const partnerRole =
    requestedPartnerRole ?? (role === "medic" ? "scout" : "medic");
  const soldiers = [
    makeUnit("op-01", "RAVEN-01", role, { x: 2, y: 2 }, "friendly"),
    makeUnit("op-02", "RAVEN-02", partnerRole, { x: 2, y: 3 }, "friendly"),
  ];
  if (owners) {
    soldiers[0]!.ownerId = owners[0];
    soldiers[1]!.ownerId = owners[1];
  }
  const enemies = [
    makeUnit("hostile-01", "GUARD-01", "assault", { x: 15, y: 3 }, "enemy"),
    makeUnit("hostile-02", "GUARD-02", "assault", { x: 17, y: 9 }, "enemy"),
    makeUnit("hostile-03", "GUARD-03", "scout", { x: 13, y: 15 }, "enemy"),
  ];
  for (const enemy of enemies) enemy.commandTarget = { x: enemy.x, y: enemy.y };
  const state: GameState = {
    round: 1,
    phase: "planning",
    phaseEndsAt: Date.now() + 30_000,
    soldiers,
    enemies,
    map: makeMap(),
    credits: 350,
    materials: 2,
    objective: {
      title: "データ・リレーを掌握",
      description: "端末に隣接してハックし、データを確保。その後、脱出地点へ。",
      progress: 0,
      target: 2,
      complete: false,
    },
    extraction: { x: 18, y: 17 },
    log: [],
    reinforcements: [],
    deployedCover: 0,
  };
  updateVisibility(state);
  addLog(state, "作戦開始。リレー端末を確保し、南東の脱出地点へ移動せよ。");
  return state;
}

// ---------------------------------------------------------------------------
// Geometry, line of sight
// ---------------------------------------------------------------------------

function distance(a: Position, b: Position): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function manhattan(a: Position, b: Position): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function isActive(unit: Unit): boolean {
  return !unit.downed && !unit.eliminated;
}

function cellAt(state: GameState, x: number, y: number): Cell | undefined {
  return state.map[y]?.[x];
}

function blocksSight(cell: Cell | undefined): boolean {
  if (!cell) return true;
  return (
    cell.terrain === "wall" ||
    cell.terrain === "cover" ||
    (cell.terrain === "door" && !cell.openDoor)
  );
}

/** Symmetric Bresenham: the same cells are traced from A to B and B to A. */
function linePoints(a: Position, b: Position): Position[] {
  const swap = a.x > b.x || (a.x === b.x && a.y > b.y);
  const from = swap ? b : a;
  const to = swap ? a : b;
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  const sx = from.x < to.x ? 1 : -1;
  const sy = from.y < to.y ? 1 : -1;
  let error = dx - dy;
  let x = from.x;
  let y = from.y;
  const points: Position[] = [{ x, y }];
  while (!(x === to.x && y === to.y)) {
    const twice = 2 * error;
    if (twice > -dy) {
      error -= dy;
      x += sx;
    }
    if (twice < dx) {
      error += dx;
      y += sy;
    }
    points.push({ x, y });
  }
  return swap ? points.reverse() : points;
}

/** Cells that stop a shot or sight between two points, nearest to `a` first. */
export function sightBlockers(state: GameState, a: Position, b: Position): Cell[] {
  const points = linePoints(a, b);
  const blockers: Cell[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    if (prev.x !== cur.x && prev.y !== cur.y) {
      // No squeezing diagonally between two blocking cells.
      const c1 = cellAt(state, cur.x, prev.y);
      const c2 = cellAt(state, prev.x, cur.y);
      if (blocksSight(c1) && blocksSight(c2)) {
        const blocker = c1 ?? c2;
        if (blocker) blockers.push(blocker);
      }
    }
    if (i < points.length - 1) {
      const cell = cellAt(state, cur.x, cur.y);
      if (cell && blocksSight(cell)) blockers.push(cell);
    }
  }
  return blockers;
}

export function hasLineOfSight(state: GameState, a: Position, b: Position): boolean {
  return sightBlockers(state, a, b).length === 0;
}

function intermediateCells(a: Position, b: Position): Position[] {
  const points = linePoints(a, b);
  return points.slice(1, points.length - 1);
}

function visionRadius(unit: Unit): number {
  return (unit.role === "scout" ? 9 : 6) + (unit.nightVision ? 2 : 0);
}

function weaponRange(unit: Unit): number {
  return unit.weapon === "precision" ? 10 : 8;
}

function isFriendlyUnit(state: GameState, unit: Unit): boolean {
  return state.soldiers.includes(unit);
}

function findUnit(state: GameState, id: string): Unit | undefined {
  return state.soldiers.find((u) => u.id === id) ?? state.enemies.find((u) => u.id === id);
}

function occupied(state: GameState, x: number, y: number, exceptId?: string): boolean {
  return (
    state.soldiers.some(
      (unit) => !unit.eliminated && unit.id !== exceptId && unit.x === x && unit.y === y,
    ) ||
    state.enemies.some(
      (unit) => !unit.downed && unit.id !== exceptId && unit.x === x && unit.y === y,
    )
  );
}

function isPassable(state: GameState, x: number, y: number): boolean {
  const cell = cellAt(state, x, y);
  if (!cell) return false;
  if (cell.terrain === "wall" || cell.terrain === "cover") return false;
  if (cell.terrain === "door") return cell.openDoor === true && !cell.locked;
  return true;
}

// ---------------------------------------------------------------------------
// Orders (planning phase)
// ---------------------------------------------------------------------------

/** Why an engineer cannot place cover on a tile, or null if it is allowed. */
export function deployBlockReason(
  state: GameState,
  unit: Unit,
  x: number,
  y: number,
  checkRoundLimit = true,
): string | null {
  if (unit.role !== "engineer") return "遮蔽物を設置できるのはエンジニアです。";
  if (!isActive(unit)) return "行動不能です。";
  const cell = cellAt(state, x, y);
  if (!cell) return "マップ外です。";
  if (cell.terrain !== "floor") return "壁・扉・目標・物資などの上には設置できません。";
  if (occupied(state, x, y)) return "人員がいるマスには設置できません。";
  if (distance(unit, { x, y }) > 2) return "設置は自分から2マス以内です。";
  if (!hasLineOfSight(state, unit, { x, y })) return "視線が通らない場所には設置できません。";
  if (matsOf(state, teamOf(state, unit)) < 1) return "資材が足りません。";
  if (state.deployedCover >= COVER_LIMIT) return `設置上限(${COVER_LIMIT}個)に達しています。`;
  if (checkRoundLimit && unit.deployedRound === state.round) return "遮蔽物は1ラウンドに1個までです。";
  return null;
}

export function getDeployableTiles(state: GameState, unitId: string): Position[] {
  const unit = state.soldiers.find((candidate) => candidate.id === unitId);
  if (!unit || unit.role !== "engineer" || !isActive(unit)) return [];
  const pending = unit.orders.some((order) => order.type === "deploy");
  if (pending) return [];
  const tiles: Position[] = [];
  for (let y = unit.y - 2; y <= unit.y + 2; y += 1) {
    for (let x = unit.x - 2; x <= unit.x + 2; x += 1) {
      if (deployBlockReason(state, unit, x, y) === null) tiles.push({ x, y });
    }
  }
  return tiles;
}

export function queueAction(
  source: GameState,
  unitId: string,
  action: GameAction,
): GameState {
  const state = structuredClone(source);
  const unit = state.soldiers.find((candidate) => candidate.id === unitId);
  if (!unit || !isActive(unit) || state.phase !== "planning") return state;
  if (unit.isNpc) {
    addLog(state, `${unit.name}: NPCには個別の行動予約はできません。命令を変更してください。`, audienceOf(state, [unit]));
    return state;
  }
  if (unit.orders.length >= MAX_ORDERS) {
    addLog(state, `${unit.name}: 1ラウンドの行動上限(${MAX_ORDERS})に達しました。`, audienceOf(state, [unit]));
    return state;
  }
  if (unit.overwatchDirection && action.type === "move") {
    addLog(state, `${unit.name}: 構え中は移動できません。`, audienceOf(state, [unit]));
    return state;
  }
  if (action.type === "deploy") {
    if (unit.orders.some((order) => order.type === "deploy")) {
      addLog(state, "遮蔽物は1ラウンドに1個までです。");
      return state;
    }
    const reason = deployBlockReason(state, unit, action.x, action.y);
    if (reason) {
      addLog(state, `設置不可: ${reason}`);
      return state;
    }
  }
  if (action.type === "shoot") {
    const target = foesOf(state, unit).find((enemy) => enemy.id === action.targetId);
    if (!target || !isActive(target) || !seenByTeam(state, target, teamOf(state, unit))) {
      addLog(state, `${unit.name}: 視認できていない敵は撃てません。`, [teamOf(state, unit)]);
      return state;
    }
  }
  if (action.type === "rescue") {
    const target = state.soldiers.find((candidate) => candidate.id === action.targetId);
    if (!target || !target.downed || target.eliminated || teamOf(state, target) !== teamOf(state, unit)) {
      addLog(state, `${unit.name}: 救出対象がいません。`, [teamOf(state, unit)]);
      return state;
    }
  }
  unit.orders.push(action);
  return state;
}

// ---------------------------------------------------------------------------
// Pathfinding
// ---------------------------------------------------------------------------

function findPath(
  state: GameState,
  unit: Unit,
  target: Position,
  allowOccupiedTarget = false,
): Position[] {
  const startKey = `${unit.x},${unit.y}`;
  const queue: Position[] = [{ x: unit.x, y: unit.y }];
  const previous = new Map<string, string | null>([[startKey, null]]);
  let found = false;
  while (queue.length) {
    const current = queue.shift()!;
    if (current.x === target.x && current.y === target.y) {
      found = true;
      break;
    }
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const x = current.x + dx!;
      const y = current.y + dy!;
      const key = `${x},${y}`;
      if (previous.has(key) || !isPassable(state, x, y)) continue;
      const isTarget = x === target.x && y === target.y;
      if (occupied(state, x, y, unit.id) && !(isTarget && allowOccupiedTarget)) continue;
      previous.set(key, `${current.x},${current.y}`);
      queue.push({ x, y });
    }
  }
  const targetKey = `${target.x},${target.y}`;
  if (!found || !previous.has(targetKey)) return [];
  const path: Position[] = [];
  let cursor: string | null = targetKey;
  while (cursor && cursor !== startKey) {
    const [x, y] = cursor.split(",").map(Number);
    path.push({ x: x!, y: y! });
    cursor = previous.get(cursor) ?? null;
  }
  return path.reverse();
}

function moveLimit(unit: Unit, maxSteps = 4): number {
  return Math.max(1, maxSteps - (unit.armor === "heavy" ? 1 : 0));
}

export function getReachableTiles(
  state: GameState,
  unitId: string,
  maxSteps = 4,
): Position[] {
  const unit = state.soldiers.find((candidate) => candidate.id === unitId);
  if (!unit || !isActive(unit) || unit.overwatchDirection || unit.isNpc) return [];
  const limit = moveLimit(unit, maxSteps);
  const start = { x: unit.x, y: unit.y };
  const queue: Array<Position & { steps: number }> = [{ ...start, steps: 0 }];
  const visited = new Set([`${start.x},${start.y}`]);
  const result: Position[] = [];
  while (queue.length) {
    const current = queue.shift()!;
    if (current.steps >= limit) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = current.x + dx!;
      const y = current.y + dy!;
      const key = `${x},${y}`;
      if (visited.has(key) || !isPassable(state, x, y) || occupied(state, x, y, unitId)) continue;
      visited.add(key);
      result.push({ x, y });
      queue.push({ x, y, steps: current.steps + 1 });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Combat rules
// ---------------------------------------------------------------------------

function targetInCover(state: GameState, attacker: Position, target: Position): boolean {
  const here = distance(attacker, target);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const cell = cellAt(state, target.x + dx!, target.y + dy!);
    if (cell?.terrain === "cover" && distance(attacker, cell) < here) return true;
  }
  return false;
}

/**
 * Final hit chance in percent. Base 70, assault +5, far -15, cover -20,
 * aimed +15, wounded shooter (HP below 50) -10, clamped to 5..95.
 */
export function hitChance(
  state: GameState,
  attacker: Unit,
  target: Position,
  aimed: boolean = attacker.overwatchBonus === true,
): number {
  const range = distance(attacker, target);
  let chance = 70;
  if (attacker.role === "assault") chance += 5;
  const farThreshold = attacker.weapon === "precision" ? 7 : 5;
  if (range > farThreshold) chance -= 15;
  if (targetInCover(state, attacker, target)) chance -= 20;
  if (aimed) chance += 15;
  if (attacker.hp < 50) chance -= 10;
  return Math.min(95, Math.max(5, chance));
}

function friendlyBlocking(state: GameState, shooter: Unit, target: Unit): boolean {
  const team = teamOf(state, shooter);
  const mates = allUnits(state).filter((unit) => teamOf(state, unit) === team);
  return intermediateCells(shooter, target).some((cell) =>
    mates.some((unit) => unit !== shooter && isActive(unit) && unit.x === cell.x && unit.y === cell.y),
  );
}

function canEngage(state: GameState, unit: Unit, foe: Unit): boolean {
  if (!isActive(foe)) return false;
  const range = distance(unit, foe);
  if (range > weaponRange(unit)) return false;
  if (!seenByTeam(state, foe, teamOf(state, unit))) return false;
  return hasLineOfSight(state, unit, foe) && !friendlyBlocking(state, unit, foe);
}

const directionAngle: Record<Direction, number> = {
  E: 0,
  SE: 45,
  S: 90,
  SW: 135,
  W: 180,
  NW: -135,
  N: -90,
  NE: -45,
};

function inFiringArc(from: Position, to: Position, direction: Direction): boolean {
  if (from.x === to.x && from.y === to.y) return false;
  const angle = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  let diff = Math.abs(angle - directionAngle[direction]);
  if (diff > 180) diff = 360 - diff;
  return diff <= 35;
}

function directionToward(from: Position, to: Position): Direction {
  const angle = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  let best: Direction = "E";
  let bestDiff = 999;
  for (const [direction, value] of Object.entries(directionAngle) as Array<[Direction, number]>) {
    let diff = Math.abs(angle - value);
    if (diff > 180) diff = 360 - diff;
    if (diff < bestDiff) {
      best = direction;
      bestDiff = diff;
    }
  }
  return best;
}

/** Tiles a unit's overwatch cone covers (used by the UI to draw the arc). */
export function getFiringArcTiles(
  state: GameState,
  unit: Unit,
  direction: Direction,
): Position[] {
  const tiles: Position[] = [];
  const range = weaponRange(unit);
  for (let y = unit.y - range; y <= unit.y + range; y += 1) {
    for (let x = unit.x - range; x <= unit.x + range; x += 1) {
      const pos = { x, y };
      if (!cellAt(state, x, y) || distance(unit, pos) > range) continue;
      if (!inFiringArc(unit, pos, direction)) continue;
      if (hasLineOfSight(state, unit, pos)) tiles.push(pos);
    }
  }
  return tiles;
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

function teamsInPlay(state: GameState): string[] {
  return [...new Set(allUnits(state).map((unit) => teamOf(state, unit)))];
}

function visionGrid(state: GameState, team: string): boolean[][] {
  const grid = Array.from({ length: MAP_SIZE }, () => Array<boolean>(MAP_SIZE).fill(false));
  for (const observer of allUnits(state)) {
    if (!isActive(observer) || teamOf(state, observer) !== team) continue;
    const radius = visionRadius(observer);
    for (
      let y = Math.max(0, observer.y - radius);
      y <= Math.min(MAP_SIZE - 1, observer.y + radius);
      y += 1
    ) {
      for (
        let x = Math.max(0, observer.x - radius);
        x <= Math.min(MAP_SIZE - 1, observer.x + radius);
        x += 1
      ) {
        if (grid[y]![x]) continue;
        const pos = { x, y };
        if (distance(observer, pos) <= radius && hasLineOfSight(state, observer, pos)) grid[y]![x] = true;
      }
    }
  }
  return grid;
}

function updateVisibility(state: GameState): void {
  const viewTeam = state.viewTeam ?? "ally";
  const teams = teamsInPlay(state);
  const grids = new Map<string, boolean[][]>();
  for (const team of teams) grids.set(team, visionGrid(state, team));
  state.memory ??= {};
  state.explored ??= {};
  for (const team of teams) {
    state.memory[team] ??= {};
    state.explored[team] ??= Array<number>(MAP_SIZE * MAP_SIZE).fill(0);
    const grid = grids.get(team)!;
    for (let y = 0; y < MAP_SIZE; y += 1) {
      for (let x = 0; x < MAP_SIZE; x += 1) if (grid[y]![x]) state.explored[team]![y * MAP_SIZE + x] = 1;
    }
  }
  for (const unit of allUnits(state)) {
    const own = teamOf(state, unit);
    unit.seenBy = [];
    for (const team of teams) {
      if (team === own || unit.eliminated) continue;
      const seen = allUnits(state).some(
        (observer) =>
          isActive(observer) &&
          teamOf(state, observer) === team &&
          distance(observer, unit) <= visionRadius(observer) &&
          hasLineOfSight(state, observer, unit),
      );
      const memory = state.memory[team]!;
      if (seen) {
        unit.seenBy.push(team);
        memory[unit.id] = { x: unit.x, y: unit.y };
      } else if (memory[unit.id]) {
        const spot = memory[unit.id]!;
        // The remembered spot is in view and nobody is there: the memory is stale.
        if (grids.get(team)![spot.y]?.[spot.x]) delete memory[unit.id];
      }
    }
  }
  const viewGrid = grids.get(viewTeam);
  for (const row of state.map) {
    for (const cell of row) cell.visible = viewGrid?.[cell.y]?.[cell.x] ?? false;
  }
  for (const unit of allUnits(state)) {
    if (teamOf(state, unit) === viewTeam) continue;
    unit.visible = (unit.seenBy ?? []).includes(viewTeam);
    unit.lastKnown = state.memory[viewTeam]?.[unit.id] ?? null;
  }
}

/** Returns a copy of the state with vision (cells, enemy.visible, lastKnown) recomputed. */
export function computeVisibility(source: GameState): GameState {
  const state = structuredClone(source);
  updateVisibility(state);
  return state;
}

// ---------------------------------------------------------------------------
// Execution phase (tick simulation)
// ---------------------------------------------------------------------------

type Runtime = {
  index: number;
  started: boolean;
  wait: number;
  path: Position[];
  stepWait: number;
  age: number;
  goal?: Position;
};

type Shot = { attackerId: string; targetId: string; aimed: boolean };
type Noise = { pos: Position; team: string };
type Ctx = {
  state: GameState;
  tick: number;
  shots: Shot[];
  noise: Noise[];
  rt: Map<string, Runtime>;
  rescued: Set<string>;
};

function getRt(ctx: Ctx, id: string): Runtime {
  let runtime = ctx.rt.get(id);
  if (!runtime) {
    runtime = { index: 0, started: false, wait: 0, path: [], stepWait: 0, age: 0 };
    ctx.rt.set(id, runtime);
  }
  return runtime;
}

function downUnit(state: GameState, unit: Unit): void {
  unit.hp = 0;
  unit.downed = true;
  unit.overwatchDirection = undefined;
  unit.overwatchBonus = false;
  unit.orders = [];
  if (isFriendlyUnit(state, unit)) {
    unit.bleedRounds = BLEED_ROUNDS;
    unit.rescueProgress = 0;
    addLog(state, `${unit.name}がダウン。${BLEED_ROUNDS}ラウンド以内に救出しないと退場します。`, audienceOf(state, [unit]));
  } else {
    addLog(state, `${unit.name}を無力化。`, audienceOf(state, [unit]));
    const cell = cellAt(state, unit.x, unit.y);
    if (cell && cell.terrain === "floor") {
      cell.terrain = "loot";
      cell.loot = "credits";
      cell.lootAmount = 75;
    }
  }
}

function resolveShots(ctx: Ctx): void {
  const { state } = ctx;
  const hits: Array<{ attacker: Unit; target: Unit; damage: number; chance: number }> = [];
  for (const shot of ctx.shots) {
    const attacker = findUnit(state, shot.attackerId);
    const target = findUnit(state, shot.targetId);
    if (!attacker || !target || !isActive(attacker) || !isActive(target)) continue;
    const consumeAim = () => {
      attacker.overwatchBonus = false;
      attacker.overwatchDirection = undefined;
    };
    if (attacker.ammo <= 0) {
      addLog(state, `${attacker.name}: 弾薬切れ。`, audienceOf(state, [attacker]));
      continue;
    }
    if (distance(attacker, target) > weaponRange(attacker)) {
      addLog(state, `${attacker.name}: 射程外。`, audienceOf(state, [attacker]));
      continue;
    }
    const blockers = sightBlockers(state, attacker, target);
    if (blockers.length) {
      const blocker = blockers[0]!;
      if (blocker.terrain === "cover") {
        attacker.ammo -= 1;
        ctx.noise.push({ pos: { x: attacker.x, y: attacker.y }, team: teamOf(state, attacker) });
        blocker.durability =
          (blocker.durability ?? 80) - (attacker.weapon === "precision" ? 42 : 34);
        if (blocker.durability <= 0) {
          blocker.terrain = "floor";
          delete blocker.durability;
          addLog(state, `${attacker.name}の射撃で遮蔽物が破壊された。`, audienceOf(state, [attacker]));
        } else {
          addLog(state, `${attacker.name}の射撃が遮蔽物に命中。耐久 ${blocker.durability}。`, audienceOf(state, [attacker]));
        }
        consumeAim();
      } else {
        addLog(state, `${attacker.name}: 壁・扉で射線が遮られている。`, audienceOf(state, [attacker]));
      }
      continue;
    }
    if (friendlyBlocking(state, attacker, target)) {
      addLog(state, `${attacker.name}: 射線上に味方がいるため射撃を控えた。`, audienceOf(state, [attacker]));
      continue;
    }
    attacker.ammo -= 1;
    ctx.noise.push({ pos: { x: attacker.x, y: attacker.y }, team: teamOf(state, attacker) });
    const chance = hitChance(state, attacker, target, shot.aimed);
    consumeAim();
    if (rng() * 100 > chance) {
      addLog(state, `${attacker.name}→${target.name}: 外れ(命中率${chance}%)。`, audienceOf(state, [attacker, target]));
      continue;
    }
    const rawDamage = attacker.weapon === "precision" ? 42 : 34;
    const armorFactor = target.armor === "heavy" ? 0.65 : target.armor === "light" ? 0.85 : 1;
    hits.push({ attacker, target, chance, damage: Math.max(8, Math.round(rawDamage * armorFactor)) });
  }
  // Damage lands after every shot of the tick was rolled: shots are simultaneous.
  for (const hit of hits) {
    if (hit.target.downed) continue;
    hit.target.hp = Math.max(0, hit.target.hp - hit.damage);
    addLog(
      state,
      `${hit.attacker.name}→${hit.target.name}: 命中(命中率${hit.chance}%) ${hit.damage}ダメージ。`,
      audienceOf(state, [hit.attacker, hit.target]),
    );
    if (hit.target.hp <= 0) downUnit(state, hit.target);
  }
}

/** Idle/auto fire. Returns true if the unit is busy fighting this tick. */
function tryAutoFire(ctx: Ctx, unit: Unit): boolean {
  const { state } = ctx;
  const target = foesOf(state, unit)
    .filter((foe) => canEngage(state, unit, foe))
    .sort((a, b) => distance(unit, a) - distance(unit, b))[0];
  if (!target) {
    unit.reaction = undefined;
    return false;
  }
  if (unit.ammo <= 0) {
    unit.reloading = 4;
    addLog(state, `${unit.name}が再装填を開始。`, audienceOf(state, [unit]));
    return true;
  }
  if ((unit.cooldown ?? 0) > 0) return true;
  if (unit.reaction === undefined) unit.reaction = Math.floor(rng() * 3);
  if (unit.reaction > 0) {
    unit.reaction -= 1;
    return true;
  }
  ctx.shots.push({ attackerId: unit.id, targetId: target.id, aimed: false });
  unit.cooldown = 2;
  return true;
}

function stepToward(ctx: Ctx, unit: Unit, goal: Position, stopDistance: number): void {
  const runtime = getRt(ctx, unit.id);
  if (distance(unit, goal) <= stopDistance) return;
  if (runtime.stepWait > 0) {
    runtime.stepWait -= 1;
    return;
  }
  const path = findPath(ctx.state, unit, goal, true);
  const next = path[0];
  if (!next || occupied(ctx.state, next.x, next.y, unit.id)) return;
  unit.x = next.x;
  unit.y = next.y;
  unit.overwatchDirection = undefined;
  unit.overwatchBonus = false;
  runtime.stepWait = TILE_TICKS - 1;
}

function addRescueProgress(ctx: Ctx, rescuer: Unit, target: Unit): void {
  const medic = rescuer.role === "medic";
  target.rescueProgress = (target.rescueProgress ?? 0) + 1 / (medic ? MEDIC_RESCUE_TICKS : RESCUE_TICKS);
  if (medic) target.rescueByMedic = true;
  ctx.rescued.add(target.id);
  if ((target.rescueProgress ?? 0) >= 0.999) {
    target.downed = false;
    target.hp = target.rescueByMedic ? 40 : 20;
    target.rescueProgress = 0;
    target.rescueByMedic = false;
    target.bleedRounds = undefined;
    addLog(ctx.state, `${target.name}が救出され、HP ${target.hp}で復帰。`, audienceOf(ctx.state, [target]));
  }
}

function terminalPosition(state: GameState): Position {
  for (const row of state.map) {
    for (const cell of row) if (cell.terrain === "terminal") return { x: cell.x, y: cell.y };
  }
  return { x: 14, y: 10 };
}

function stepNpc(ctx: Ctx, npc: Unit): void {
  const { state } = ctx;
  if (!isActive(npc) || (npc.reloading ?? 0) > 0 || npc.overwatchDirection) return;
  if (tryAutoFire(ctx, npc)) return;
  const myTeam = teamOf(state, npc);
  const players = state.soldiers.filter(
    (unit) => !unit.isNpc && isActive(unit) && teamOf(state, unit) === myTeam,
  );
  const anchor = players.sort((a, b) => distance(npc, a) - distance(npc, b))[0];
  switch (npc.command) {
    case "retreat":
      stepToward(ctx, npc, { x: 2, y: 2 }, 0);
      return;
    case "defend":
      stepToward(ctx, npc, npc.commandTarget ?? terminalPosition(state), 1);
      return;
    case "scout":
      stepToward(ctx, npc, npc.commandTarget ?? { x: 14, y: 8 }, 1);
      return;
    case "support": {
      const downedAlly = state.soldiers
        .filter((unit) => unit.downed && !unit.eliminated && teamOf(state, unit) === myTeam)
        .sort((a, b) => distance(npc, a) - distance(npc, b))[0];
      if (downedAlly) {
        if (distance(npc, downedAlly) <= 1) addRescueProgress(ctx, npc, downedAlly);
        else stepToward(ctx, npc, downedAlly, 1);
        return;
      }
      if (anchor) stepToward(ctx, npc, anchor, 2);
      return;
    }
    default:
      if (anchor) stepToward(ctx, npc, anchor, 2);
  }
}

function stepEnemy(ctx: Ctx, enemy: Unit): void {
  const { state } = ctx;
  if (!isActive(enemy) || (enemy.reloading ?? 0) > 0) return;
  if (tryAutoFire(ctx, enemy)) return;
  const seen = foesOf(state, enemy)
    .filter(
      (soldier) =>
        isActive(soldier) &&
        distance(enemy, soldier) <= visionRadius(enemy) &&
        hasLineOfSight(state, enemy, soldier),
    )
    .sort((a, b) => distance(enemy, a) - distance(enemy, b))[0];
  if (seen) enemy.chase = { x: seen.x, y: seen.y };
  if (enemy.chase) {
    if (distance(enemy, enemy.chase) <= 1 && !seen) enemy.chase = null;
    else {
      stepToward(ctx, enemy, enemy.chase, 0);
      return;
    }
  }
  const post = enemy.commandTarget;
  if (post && distance(enemy, post) > 2) stepToward(ctx, enemy, post, 1);
}

function failRescue(state: GameState, unit: Unit, reason: string): void {
  addLog(state, `${unit.name}: ${reason}`, audienceOf(state, [unit]));
}

function beginOrder(ctx: Ctx, unit: Unit, runtime: Runtime, order: GameAction): boolean {
  const { state } = ctx;
  runtime.age = 0;
  switch (order.type) {
    case "move": {
      unit.overwatchDirection = undefined;
      unit.overwatchBonus = false;
      const path = findPath(state, unit, order).slice(0, moveLimit(unit));
      if (!path.length) {
        addLog(state, `${unit.name}: その地点へ移動できません。`, audienceOf(state, [unit]));
        return false;
      }
      runtime.path = path;
      runtime.goal = { x: order.x, y: order.y };
      runtime.stepWait = TILE_TICKS;
      return true;
    }
    case "shoot": {
      const target = foesOf(state, unit).find((enemy) => enemy.id === order.targetId);
      if (!target || !isActive(target) || !seenByTeam(state, target, teamOf(state, unit))) {
        addLog(state, `${unit.name}: 射撃目標を確認できません。`, audienceOf(state, [unit]));
        return false;
      }
      runtime.wait = 1;
      return true;
    }
    case "overwatch": {
      const nearest = foesOf(state, unit)
        .filter((enemy) => isActive(enemy) && seenByTeam(state, enemy, teamOf(state, unit)))
        .sort((a, b) => distance(unit, a) - distance(unit, b))[0];
      unit.overwatchDirection =
        order.direction ?? directionToward(unit, nearest ?? { x: unit.x + 1, y: unit.y });
      unit.overwatchBonus = true;
      addLog(state, `${unit.name}が${unit.overwatchDirection}方向を監視射撃。`, audienceOf(state, [unit]));
      return true;
    }
    case "door":
    case "heal":
      runtime.wait = 2;
      return true;
    case "loot":
      runtime.wait = unit.role === "scout" ? 1 : 2;
      return true;
    case "hack":
      runtime.wait = unit.role === "hacker" ? 3 : 6;
      return true;
    case "deploy": {
      const reason = deployBlockReason(state, unit, order.x, order.y);
      if (reason) {
        addLog(state, `${unit.name}: 設置不可(${reason})`, audienceOf(state, [unit]));
        return false;
      }
      runtime.wait = 4;
      return true;
    }
    case "reload":
      runtime.wait = 4;
      return true;
    case "rescue":
      return true;
  }
}

function completeTimed(ctx: Ctx, unit: Unit, order: GameAction): void {
  const { state } = ctx;
  switch (order.type) {
    case "shoot": {
      const target = foesOf(state, unit).find((enemy) => enemy.id === order.targetId);
      if (!target || !isActive(target)) return;
      if (friendlyBlocking(state, unit, target)) {
        addLog(state, `${unit.name}: 射線上に味方がいるため射撃を控えた。`, audienceOf(state, [unit]));
        return;
      }
      const blocker = sightBlockers(state, unit, target)[0];
      const inRange = distance(unit, target) <= weaponRange(unit);
      // A visible target behind enemy cover can still be shot at to break the cover.
      if (inRange && (!blocker || blocker.terrain === "cover") && seenByTeam(state, target, teamOf(state, unit))) {
        ctx.shots.push({ attackerId: unit.id, targetId: target.id, aimed: true });
      } else {
        addLog(state, `${unit.name}: 目標を捕捉できず射撃を中止。`, audienceOf(state, [unit]));
      }
      return;
    }
    case "door": {
      const cell = cellAt(state, order.x, order.y);
      if (!cell || cell.terrain !== "door" || manhattan(unit, order) > 1) {
        addLog(state, `${unit.name}: 扉に隣接して操作してください。`, audienceOf(state, [unit]));
        return;
      }
      if (cell.locked && unit.role !== "hacker") {
        addLog(state, "電子ロックを解除できるのはハッカーです。");
        return;
      }
      if (cell.locked) cell.locked = false;
      cell.openDoor = !cell.openDoor;
      addLog(state, `${unit.name}が扉を${cell.openDoor ? "開いた" : "閉じた"}。`, audienceOf(state, [unit]));
      return;
    }
    case "loot": {
      const cell = cellAt(state, order.x, order.y);
      if (!cell || cell.terrain !== "loot" || distance(unit, order) > 1) {
        addLog(state, `${unit.name}: 物資に隣接していません。`, audienceOf(state, [unit]));
        return;
      }
      if (cell.loot === "credits") {
        const base = cell.lootAmount ?? 100;
        const amount = unit.role === "scout" ? Math.round(base * 1.5) : base;
        addFunds(state, teamOf(state, unit), amount);
        addLog(state, `${unit.name}が${amount}クレジットを回収${unit.role === "scout" ? "(偵察兵ボーナス)" : ""}。`, audienceOf(state, [unit]));
      } else if (cell.loot === "ammo") {
        unit.ammo = unit.maxAmmo;
        addLog(state, `${unit.name}が弾薬を補充。`, audienceOf(state, [unit]));
      } else if (cell.loot === "medkit") {
        unit.medkits = (unit.medkits ?? 0) + 1;
        addLog(state, `${unit.name}が医療キットを回収。`, audienceOf(state, [unit]));
      } else {
        const myTeam = teamOf(state, unit);
        state.memory ??= {};
        state.memory[myTeam] ??= {};
        for (const foe of foesOf(state, unit)) {
          if (isActive(foe)) {
            state.memory[myTeam]![foe.id] = { x: foe.x, y: foe.y };
            if (myTeam === (state.viewTeam ?? "ally")) foe.lastKnown = { x: foe.x, y: foe.y };
          }
        }
        addLog(state, "情報端末から敵配置を入手。最終確認位置として記録した。");
      }
      cell.terrain = "floor";
      delete cell.loot;
      delete cell.lootAmount;
      return;
    }
    case "heal": {
      const target = state.soldiers.find((candidate) => candidate.id === order.targetId);
      if (!target || !isActive(target) || distance(unit, target) > 1 || (unit.medkits ?? 0) <= 0) {
        addLog(state, `${unit.name}: 治療できません。隣接・生存・医療キットを確認してください。`, audienceOf(state, [unit]));
        return;
      }
      unit.medkits = (unit.medkits ?? 0) - 1;
      const amount = 30 + (unit.role === "medic" ? 10 : 0);
      target.hp = Math.min(100, target.hp + amount);
      addLog(state, `${unit.name}が${target.name}を治療。HP +${amount}。`, audienceOf(state, [unit, target]));
      return;
    }
    case "hack": {
      const cell = cellAt(state, order.x, order.y);
      if (!cell || manhattan(unit, order) > 1) {
        addLog(state, `${unit.name}: 操作対象に隣接してください。`, audienceOf(state, [unit]));
        return;
      }
      if (cell.terrain === "door" && cell.locked) {
        if (unit.role !== "hacker") {
          addLog(state, "電子ロックの解除にはハッカーが必要です。");
          return;
        }
        cell.locked = false;
        cell.openDoor = true;
        addLog(state, `${unit.name}が電子ロックを解除。`, audienceOf(state, [unit]));
        return;
      }
      if (cell.terrain !== "terminal" && cell.terrain !== "objective") {
        addLog(state, "操作可能な端末がありません。");
        return;
      }
      if (unit.role !== "hacker") {
        addLog(state, `${unit.name}が端末を手動操作。ハッカーなら短時間で完了できます。`, audienceOf(state, [unit]));
      }
      state.objective.progress = Math.min(
        state.objective.target,
        state.objective.progress + (unit.role === "hacker" ? state.objective.target : 1),
      );
      state.objective.complete = state.objective.progress >= state.objective.target;
      addLog(state, `${unit.name}が端末を操作。進捗 ${state.objective.progress}/${state.objective.target}。`, audienceOf(state, [unit]));
      if (state.objective.complete) addLog(state, "データを確保。南東の脱出地点へ向かえ。");
      return;
    }
    case "deploy": {
      const reason = deployBlockReason(state, unit, order.x, order.y, false);
      const cell = cellAt(state, order.x, order.y);
      if (reason || !cell) {
        addLog(state, `${unit.name}: 設置に失敗(${reason ?? "不明"})。`, audienceOf(state, [unit]));
        return;
      }
      cell.terrain = "cover";
      cell.durability = 100;
      addMats(state, teamOf(state, unit), -1);
      state.deployedCover += 1;
      unit.deployedRound = state.round;
      addLog(state, `${unit.name}が簡易遮蔽物を設置。`, audienceOf(state, [unit]));
      return;
    }
    case "reload":
      unit.ammo = unit.maxAmmo;
      addLog(state, `${unit.name}が再装填。`, audienceOf(state, [unit]));
      return;
    default:
      return;
  }
}

/** Advances one order by one tick. */
function progressOrder(ctx: Ctx, unit: Unit, runtime: Runtime, order: GameAction): "busy" | "done" {
  const { state } = ctx;
  runtime.age += 1;
  switch (order.type) {
    case "move": {
      runtime.stepWait -= 1;
      if (runtime.stepWait > 0) return "busy";
      const next = runtime.path[0];
      if (!next) return "done";
      if (!isPassable(state, next.x, next.y) || occupied(state, next.x, next.y, unit.id)) {
        const replanned = runtime.goal
          ? findPath(state, unit, runtime.goal).slice(0, runtime.path.length)
          : [];
        if (!replanned.length) {
          addLog(state, `${unit.name}: 進路が塞がれたため移動を中止。`, audienceOf(state, [unit]));
          return "done";
        }
        runtime.path = replanned;
        runtime.stepWait = 1;
        return "busy";
      }
      unit.x = next.x;
      unit.y = next.y;
      runtime.path.shift();
      runtime.stepWait = TILE_TICKS;
      if (!runtime.path.length) {
        addLog(state, `${unit.name}が(${unit.x + 1},${unit.y + 1})へ移動。`, audienceOf(state, [unit]));
        return "done";
      }
      return "busy";
    }
    case "overwatch":
      return "done";
    case "rescue": {
      const target = state.soldiers.find((candidate) => candidate.id === order.targetId);
      if (!target) return "done";
      if (target.eliminated) {
        failRescue(state, unit, `${target.name}はすでに退場しており救出できません。`);
        return "done";
      }
      if (!target.downed) return "done";
      if (distance(unit, target) > 1) {
        failRescue(state, unit, "救出対象に隣接していないため救出を中断。");
        return "done";
      }
      if (runtime.age > RESCUE_TICKS * 2 + 2) {
        failRescue(state, unit, "救出に時間がかかりすぎたため中断。");
        return "done";
      }
      addRescueProgress(ctx, unit, target);
      return target.downed ? "busy" : "done";
    }
    default:
      runtime.wait -= 1;
      if (runtime.wait > 0) return "busy";
      completeTimed(ctx, unit, order);
      return "done";
  }
}

function stepPlayerUnit(ctx: Ctx, unit: Unit): void {
  if (!isActive(unit) || (unit.reloading ?? 0) > 0) return;
  const runtime = getRt(ctx, unit.id);
  for (let guard = 0; guard < 4; guard += 1) {
    const order = unit.orders[runtime.index];
    if (!order) {
      if (!unit.overwatchDirection) tryAutoFire(ctx, unit);
      return;
    }
    if (!runtime.started) {
      runtime.started = true;
      if (!beginOrder(ctx, unit, runtime, order)) {
        runtime.index += 1;
        runtime.started = false;
        continue;
      }
      if (order.type === "overwatch") {
        runtime.index += 1;
        runtime.started = false;
        continue;
      }
    }
    if (progressOrder(ctx, unit, runtime, order) === "done") {
      runtime.index += 1;
      runtime.started = false;
    }
    return;
  }
}

function overwatchTriggers(ctx: Ctx): void {
  const { state } = ctx;
  for (const unit of [...state.soldiers, ...state.enemies]) {
    if (!isActive(unit) || !unit.overwatchDirection || unit.ammo <= 0) continue;
    const target = foesOf(state, unit)
      .filter(
        (foe) =>
          canEngage(state, unit, foe) && inFiringArc(unit, foe, unit.overwatchDirection!),
      )
      .sort((a, b) => distance(unit, a) - distance(unit, b))[0];
    if (target && !ctx.shots.some((shot) => shot.attackerId === unit.id)) {
      ctx.shots.push({ attackerId: unit.id, targetId: target.id, aimed: true });
    }
  }
}

function teamOut(state: GameState, team: string): boolean {
  const units = state.soldiers.filter((unit) => teamOf(state, unit) === team);
  if (units.every((unit) => unit.eliminated)) return true;
  const humansDown = units
    .filter((unit) => !unit.isNpc)
    .every((unit) => unit.downed || unit.eliminated);
  return humansDown && !units.some((unit) => unit.isNpc && isActive(unit));
}

function checkOutcome(state: GameState): boolean {
  if (state.phase === "victory" || state.phase === "defeat") return true;
  const mode = state.mode ?? "coop";
  if (mode !== "coop") {
    const teams = teamsInPlay(state).filter((team) => state.soldiers.some((u) => teamOf(state, u) === team));
    const standing = teams.filter((team) => !teamOut(state, team));
    if (standing.length <= 1) {
      state.phase = "victory";
      state.winner = standing[0] ?? null;
      addLog(state, standing[0] ? `${standing[0]} が最後まで生き残り勝利。` : "全滅。引き分け。");
      return true;
    }
    return false;
  }
  const players = state.soldiers.filter((unit) => !unit.isNpc);
  const extracted =
    state.objective.complete &&
    players.some(
      (unit) =>
        isActive(unit) && unit.x === state.extraction.x && unit.y === state.extraction.y,
    );
  if (extracted) {
    state.phase = "victory";
    state.winner = "ally";
    addLog(state, "脱出成功。FALSE FRONT 作戦完了。");
    return true;
  }
  const allGone = players.length > 0 && players.every((unit) => unit.eliminated);
  const noRescuer =
    players.length > 0 &&
    players.every((unit) => unit.downed || unit.eliminated) &&
    !state.soldiers.some((unit) => unit.isNpc && isActive(unit));
  if (allGone || noRescuer) {
    state.phase = "defeat";
    state.winner = null;
    addLog(state, allGone ? "作戦失敗。全オペレーターが退場。" : "作戦失敗。全員がダウンし、救出できる味方がいない。");
    return true;
  }
  return false;
}

/** True when this team can no longer act (everyone down/eliminated, nobody to rescue). */
export function isTeamOut(state: GameState, team: string): boolean {
  return teamOut(state, team);
}

export function executeRound(source: GameState): GameState {
  const state = structuredClone(source);
  if (state.phase !== "planning") return state;
  state.phase = "execution";
  addLog(state, `ラウンド ${state.round} の実行フェーズ開始。`);
  const ctx: Ctx = { state, tick: 0, shots: [], noise: [], rt: new Map(), rescued: new Set() };

  // Late rounds: the garrison sweeps toward the relay terminal.
  if (state.round >= 4 && (state.mode ?? "coop") === "coop") {
    const terminal = terminalPosition(state);
    for (const enemy of state.enemies) {
      if (isActive(enemy) && !enemy.chase) enemy.chase = terminal;
    }
  }

  for (let tick = 0; tick < TICKS_PER_ROUND; tick += 1) {
    ctx.tick = tick;
    ctx.shots = [];
    ctx.noise = [];
    ctx.rescued = new Set();
    for (const unit of [...state.soldiers, ...state.enemies]) {
      if ((unit.cooldown ?? 0) > 0) unit.cooldown = (unit.cooldown ?? 0) - 1;
      if ((unit.reloading ?? 0) > 0) {
        unit.reloading = (unit.reloading ?? 0) - 1;
        if (unit.reloading === 0 && isActive(unit)) {
          unit.ammo = unit.maxAmmo;
          addLog(state, `${unit.name}が再装填を完了。`, audienceOf(state, [unit]));
        }
      }
    }
    updateVisibility(state);
    for (const unit of state.soldiers.filter((candidate) => !candidate.isNpc)) stepPlayerUnit(ctx, unit);
    for (const npc of state.soldiers.filter((candidate) => candidate.isNpc)) stepNpc(ctx, npc);
    for (const enemy of state.enemies) stepEnemy(ctx, enemy);
    updateVisibility(state);
    overwatchTriggers(ctx);
    resolveShots(ctx);

    // Gunfire draws nearby guards toward the shooter.
    for (const noise of ctx.noise) {
      for (const enemy of state.enemies) {
        if (
          isActive(enemy) &&
          teamOf(state, enemy) !== noise.team &&
          distance(enemy, noise.pos) <= 10 &&
          !enemy.chase
        ) {
          enemy.chase = { ...noise.pos };
        }
      }
    }
    // A rescue that nobody continued is interrupted and its progress is lost.
    for (const unit of state.soldiers) {
      if (unit.downed && (unit.rescueProgress ?? 0) > 0 && !ctx.rescued.has(unit.id)) {
        unit.rescueProgress = 0;
        unit.rescueByMedic = false;
        addLog(state, `${unit.name}の救出が中断された。`, audienceOf(state, [unit]));
      }
    }
    updateVisibility(state);
    if (checkOutcome(state)) {
      for (const unit of state.soldiers) unit.orders = [];
      return state;
    }
  }

  for (const unit of state.soldiers) unit.orders = [];
  state.phase = "execution";
  state.phaseEndsAt = Date.now() + 15_000;
  return state;
}

export function advanceRound(source: GameState): GameState {
  const state = structuredClone(source);
  if (state.phase !== "execution") return state;
  state.round += 1;
  state.phase = "planning";
  state.phaseEndsAt = Date.now() + 30_000;
  for (const unit of state.soldiers) {
    unit.orders = [];
    unit.reaction = undefined;
    unit.overwatchBonus = Boolean(unit.overwatchDirection);
    if (unit.downed && !unit.eliminated) {
      unit.rescueProgress = 0;
      unit.rescueByMedic = false;
      unit.bleedRounds = (unit.bleedRounds ?? BLEED_ROUNDS) - 1;
      if (unit.bleedRounds <= 0) {
        unit.eliminated = true;
        addLog(state, `${unit.name}は救出されず完全に退場した。`, audienceOf(state, [unit]));
      } else {
        addLog(state, `${unit.name}はダウン中。あと${unit.bleedRounds}ラウンドで退場。`, audienceOf(state, [unit]));
      }
    }
  }
  arriveReinforcements(state);
  updateVisibility(state);
  checkOutcome(state);
  return state;
}

// ---------------------------------------------------------------------------
// Equipment and reinforcements
// ---------------------------------------------------------------------------

const equipmentCosts: Record<Equipment, number> = {
  "precision-rifle": 300,
  "light-armor": 200,
  "heavy-armor": 500,
  "night-vision": 250,
  medkit: 150,
  ammo: 100,
};

export function buyEquipment(
  source: GameState,
  unitId: string,
  item: Equipment,
): GameState {
  const state = structuredClone(source);
  const unit = state.soldiers.find((candidate) => candidate.id === unitId);
  const cost = equipmentCosts[item];
  const team = unit ? teamOf(state, unit) : "ally";
  if (!unit || !isActive(unit) || state.phase !== "planning" || fundsOf(state, team) < cost) {
    addLog(state, "購入できません。資金または作戦状態を確認してください。");
    return state;
  }
  if (
    (item === "precision-rifle" && unit.weapon === "precision") ||
    (item === "light-armor" && unit.armor !== "none") ||
    (item === "heavy-armor" && unit.armor === "heavy") ||
    (item === "night-vision" && unit.nightVision) ||
    (item === "ammo" && unit.ammo >= unit.maxAmmo)
  ) {
    addLog(state, `${unit.name}: その装備は不要か、すでに装備しています。`, [teamOf(state, unit)]);
    return state;
  }
  addFunds(state, team, -cost);
  switch (item) {
    case "precision-rifle":
      unit.weapon = "precision";
      unit.maxAmmo = 5;
      unit.ammo = Math.min(unit.ammo, unit.maxAmmo);
      break;
    case "light-armor":
      unit.armor = "light";
      break;
    case "heavy-armor":
      unit.armor = "heavy";
      break;
    case "night-vision":
      unit.nightVision = true;
      break;
    case "medkit":
      unit.medkits = (unit.medkits ?? 0) + 1;
      break;
    case "ammo":
      unit.ammo = unit.maxAmmo;
      break;
  }
  addLog(state, `${unit.name}用の装備を購入。-${cost}クレジット。`, [teamOf(state, unit)]);
  return state;
}

const hirePrices: Record<ReinforcementType, { cost: number; delay: number; label: string }> = {
  rifle: { cost: 400, delay: 2, label: "ライフル兵" },
  scout: { cost: 350, delay: 2, label: "偵察兵" },
  support: { cost: 450, delay: 3, label: "支援兵" },
  guard: { cost: 300, delay: 1, label: "警備兵" },
};

/** Hiring capacity. A commander who is up raises the cap from 2 to 3. */
export function reinforcementStatus(
  state: GameState,
  team = "ally",
): {
  limit: number;
  used: number;
  commanderActive: boolean;
  commanderDown: boolean;
} {
  const commanders = state.soldiers.filter(
    (unit) => unit.role === "commander" && !unit.isNpc && teamOf(state, unit) === team,
  );
  const commanderActive = commanders.some(isActive);
  const used =
    state.reinforcements.filter((item) => (item.team ?? "ally") === team).length +
    state.soldiers.filter((unit) => unit.isNpc && !unit.eliminated && teamOf(state, unit) === team).length;
  return {
    limit: commanderActive ? 3 : 2,
    used,
    commanderActive,
    commanderDown: commanders.length > 0 && !commanderActive,
  };
}

export function hireReinforcement(
  source: GameState,
  type: ReinforcementType,
  command: NonNullable<Unit["command"]> = "follow",
  team = "ally",
): GameState {
  const state = structuredClone(source);
  const status = reinforcementStatus(state, team);
  if (state.phase !== "planning") {
    addLog(state, "作戦中は増援を雇用できません。", [team]);
    return state;
  }
  if (status.used >= status.limit) {
    addLog(
      state,
      status.commanderDown
        ? `指揮官がダウン中のため増援枠は ${status.limit} 人までです(到着済みの増援は残ります)。`
        : `増援上限 ${status.limit} 人に達しています。`,
      [team],
    );
    return state;
  }
  const { cost, delay } = hirePrices[type];
  if (fundsOf(state, team) < cost) {
    addLog(state, `増援費用 ${cost} クレジットが不足しています。`, [team]);
    return state;
  }
  addFunds(state, team, -cost);
  state.reinforcements.push({ id: randomId(), type, arrivesOn: state.round + delay, command, team });
  addLog(state, `${hirePrices[type].label}を雇用(-${cost})。ラウンド ${state.round + delay} に到着予定。`, [team]);
  return state;
}

function arriveReinforcements(state: GameState): void {
  const arriving = state.reinforcements.filter((item) => item.arrivesOn <= state.round);
  state.reinforcements = state.reinforcements.filter((item) => item.arrivesOn > state.round);
  for (const [index, recruit] of arriving.entries()) {
    const team = recruit.team ?? "ally";
    const base = state.spawns?.[team]?.[0];
    const candidates: Position[] = base
      ? [
          { x: base.x + 1, y: base.y },
          { x: base.x, y: base.y + 1 },
          { x: base.x - 1, y: base.y },
          { x: base.x, y: base.y - 1 },
          { x: base.x + 1, y: base.y + 1 },
          { x: base.x - 1, y: base.y - 1 },
        ]
      : [
          { x: 1, y: 2 + index },
          { x: 2, y: 1 + index },
          { x: 1, y: 5 + index },
          { x: 2, y: 7 + index },
        ];
    const spawn = candidates.find(
      (candidate) =>
        isPassable(state, candidate.x, candidate.y) && !occupied(state, candidate.x, candidate.y),
    );
    if (!spawn) {
      addLog(state, "増援の到着地点が塞がれているため、到着が次ラウンドに延期。", [team]);
      state.reinforcements.push({ ...recruit, arrivesOn: state.round + 1 });
      continue;
    }
    const role: Role =
      recruit.type === "scout" ? "scout" : recruit.type === "support" ? "medic" : "assault";
    const serial = state.soldiers.filter((unit) => unit.isNpc).length + 1;
    const unit = makeUnit(
      `reinforcement-${recruit.id}`,
      `${hirePrices[recruit.type].label}-${serial}`,
      role,
      spawn,
      "friendly",
    );
    unit.isNpc = true;
    unit.team = team;
    unit.command = recruit.type === "support" ? "support" : recruit.command;
    state.soldiers.push(unit);
    addLog(state, `${unit.name}が増援として到着。`, [team]);
  }
}

export function setUnitCommand(
  source: GameState,
  unitId: string,
  command: NonNullable<Unit["command"]>,
  target?: Position,
): GameState {
  const state = structuredClone(source);
  const unit = state.soldiers.find((candidate) => candidate.id === unitId);
  if (!unit?.isNpc || state.phase !== "planning") return state;
  unit.command = command;
  unit.commandTarget = target ?? (command === "defend" ? { x: unit.x, y: unit.y } : null);
  addLog(state, `${unit.name}への命令を「${command}」に変更。`, audienceOf(state, [unit]));
  return state;
}

function randomId(): string {
  return `rein-${rng().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Solo / team battles and per-team views (used by the authoritative server)
// ---------------------------------------------------------------------------

export const TEAM_IDS = ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO", "FOXTROT", "GOLF", "HOTEL"] as const;

export type MatchPlayer = { id: string; name: string; role: Role; team: string };

const TEAM_SPAWNS: Position[][] = [
  [{ x: 2, y: 2 }, { x: 3, y: 2 }],
  [{ x: 17, y: 2 }, { x: 16, y: 2 }],
  [{ x: 2, y: 17 }, { x: 3, y: 17 }],
  [{ x: 17, y: 17 }, { x: 16, y: 17 }],
];
const SOLO_SPAWNS: Position[] = [
  { x: 2, y: 2 }, { x: 17, y: 2 }, { x: 2, y: 17 }, { x: 17, y: 17 },
  { x: 10, y: 2 }, { x: 10, y: 17 }, { x: 2, y: 10 }, { x: 17, y: 10 },
];

export const MATCH_START_FUNDS = 350;
export const MATCH_START_MATERIALS = 2;

/**
 * Builds a free-for-all (`solo`: every player is a team) or team (`team`: 2 players
 * per team) match on the shared map. The returned state is authoritative and contains
 * every team's information; use `viewFor` before sending anything to a player.
 */
export function createMatch(mode: "solo" | "team", players: MatchPlayer[]): GameState {
  const teams = [...new Set(players.map((player) => player.team))];
  const map = makeMap();
  for (const row of map) {
    for (const cell of row) {
      if (cell.terrain === "objective" || cell.terrain === "terminal" || cell.terrain === "extraction") {
        cell.terrain = "floor";
      }
    }
  }
  // Keep the corners free for spawning and put that cash elsewhere.
  const corner = map[2]![17]!;
  corner.terrain = "floor";
  delete corner.loot;
  delete corner.lootAmount;
  const moved = map[16]![13]!;
  moved.terrain = "loot";
  moved.loot = "credits";
  moved.lootAmount = 250;

  const spawns: Record<string, Position[]> = {};
  teams.forEach((team, index) => {
    spawns[team] = mode === "team" ? TEAM_SPAWNS[index % TEAM_SPAWNS.length]! : [SOLO_SPAWNS[index % SOLO_SPAWNS.length]!];
  });
  const counters: Record<string, number> = {};
  const soldiers = players.map((player, index) => {
    const n = (counters[player.team] = (counters[player.team] ?? 0) + 1);
    const spawn = spawns[player.team]![n - 1] ?? spawns[player.team]![0]!;
    const unit = makeUnit(`u${index + 1}`, `${player.team}-${n}`, player.role, spawn, "friendly");
    unit.team = player.team;
    unit.ownerId = player.id;
    return unit;
  });
  const funds: Record<string, number> = {};
  const teamMaterials: Record<string, number> = {};
  for (const team of teams) {
    funds[team] = MATCH_START_FUNDS;
    teamMaterials[team] = MATCH_START_MATERIALS;
  }
  const state: GameState = {
    round: 1,
    phase: "planning",
    phaseEndsAt: Date.now() + 45_000,
    soldiers,
    enemies: [],
    map,
    credits: 0,
    materials: 0,
    objective: {
      title: mode === "solo" ? "ソロ戦:最後の1人になれ" : "チーム戦:最後のチームになれ",
      description: "他のすべてのチームを排除する。敵の情報は視界に入った時だけ得られる。",
      progress: 0,
      target: 1,
      complete: false,
    },
    extraction: { x: -1, y: -1 },
    log: [],
    reinforcements: [],
    deployedCover: 0,
    mode,
    funds,
    teamMaterials,
    spawns,
    winner: null,
  };
  updateVisibility(state);
  addLog(state, mode === "solo" ? "ソロ戦開始。最後まで生き残れ。" : "チーム戦開始。敵チームを全滅させよ。");
  return state;
}

/** The part of the authoritative state a given team is allowed to know. */
export function viewFor(source: GameState, team: string): GameState {
  const view = structuredClone(source);
  const mode = source.mode ?? "coop";
  const mineIds = new Set(
    allUnits(source)
      .filter((unit) => teamOf(source, unit) === team)
      .map((unit) => unit.id),
  );
  const strip = (unit: Unit): Unit => {
    const copy: Unit = { ...unit, orders: [], visible: true };
    delete copy.chase;
    delete copy.commandTarget;
    delete copy.seenBy;
    delete copy.ownerId;
    delete copy.medkits;
    delete copy.materials;
    delete copy.overwatchDirection;
    delete copy.lastKnown;
    return copy;
  };
  const sourceUnits = allUnits(source);
  view.soldiers = view.soldiers.filter((unit) => mineIds.has(unit.id));
  for (const unit of view.soldiers) unit.visible = true;
  const hidden = new Set<string>();
  const seenFoes: Unit[] = [];
  for (const unit of sourceUnits) {
    if (mineIds.has(unit.id) || unit.eliminated) continue;
    if (seenByTeam(source, unit, team)) {
      seenFoes.push(strip(unit));
    } else {
      hidden.add(unit.id);
    }
  }
  const ghosts: Unit[] = [];
  const memory = source.memory?.[team] ?? {};
  let ghostIndex = 0;
  for (const unit of sourceUnits) {
    if (!hidden.has(unit.id)) continue;
    const spot = memory[unit.id];
    if (!spot) continue;
    ghostIndex += 1;
    ghosts.push({
      id: `ghost-${ghostIndex}`,
      name: "敵影",
      role: "assault",
      x: -1,
      y: -1,
      hp: 100,
      ammo: 0,
      maxAmmo: 0,
      downed: false,
      orders: [],
      visible: false,
      lastKnown: { ...spot },
    });
  }
  view.enemies = [...seenFoes, ...ghosts];
  view.viewTeam = team;
  const grid = visionGrid(source, team);
  const explored = source.explored?.[team] ?? [];
  for (const row of view.map) {
    for (const cell of row) {
      cell.visible = grid[cell.y]?.[cell.x] ?? false;
      if (!explored[cell.y * MAP_SIZE + cell.x] && cell.terrain === "loot") {
        cell.terrain = "floor";
        delete cell.loot;
        delete cell.lootAmount;
      }
    }
  }
  view.credits = fundsOf(source, team);
  view.materials = matsOf(source, team);
  view.reinforcements = view.reinforcements.filter((item) => (item.team ?? "ally") === team);
  view.log = view.log.filter((entry) => !entry.teams || entry.teams.includes(team));
  delete view.funds;
  delete view.teamMaterials;
  delete view.memory;
  delete view.explored;
  delete view.spawns;
  if (mode !== "coop") {
    if (source.phase === "victory" || source.phase === "defeat") {
      view.phase = source.winner === team ? "victory" : "defeat";
    } else if (teamOut(source, team)) {
      view.phase = "defeat";
    }
  }
  return view;
}
