import { getStore } from "@netlify/blobs";

const store = getStore("poker-chip-game");

const CHIP_VALUES = [1000, 500, 100, 50, 10];
const MAX_PLAYERS = 4;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });

const error = (message, status = 400) => json({ ok: false, message }, status);

const sanitizeRoomCode = (value = "") =>
  String(value).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);

const createPlayerId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

const emptyChips = () => ({
  "10": 0,
  "50": 0,
  "100": 0,
  "500": 0,
  "1000": 0
});

const cloneChips = (chips = {}) => ({
  "10": Number(chips["10"] || 0),
  "50": Number(chips["50"] || 0),
  "100": Number(chips["100"] || 0),
  "500": Number(chips["500"] || 0),
  "1000": Number(chips["1000"] || 0)
});

const chipsToAmount = (chips = {}) =>
  Number(chips["10"] || 0) * 10 +
  Number(chips["50"] || 0) * 50 +
  Number(chips["100"] || 0) * 100 +
  Number(chips["500"] || 0) * 500 +
  Number(chips["1000"] || 0) * 1000;

const amountToChips = (amount) => {
  let remaining = Math.max(0, Math.floor(Number(amount) || 0));
  const result = emptyChips();

  for (const value of CHIP_VALUES) {
    const key = String(value);
    const count = Math.floor(remaining / value);
    result[key] = count;
    remaining -= count * value;
  }

  return result;
};

const canMoveChips = (fromChips, denomination, count = 1) => {
  const key = String(denomination);
  return Number(fromChips[key] || 0) >= count;
};

const moveChip = (fromChips, toChips, denomination, count = 1) => {
  const key = String(denomination);

  if (!canMoveChips(fromChips, denomination, count)) {
    throw new Error(`${denomination} 칩이 부족합니다.`);
  }

  fromChips[key] = Number(fromChips[key] || 0) - count;
  toChips[key] = Number(toChips[key] || 0) + count;
};

const metaKey = (roomCode) => `rooms/${roomCode}/meta`;
const playerKey = (roomCode, playerId) => `rooms/${roomCode}/players/${playerId}`;

async function readJson(key) {
  const raw = await store.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function writeJson(key, value) {
  await store.setJSON(key, value);
}

async function listPlayers(roomCode) {
  const prefix = `rooms/${roomCode}/players/`;
  const { blobs } = await store.list({ prefix });
  const players = [];

  for (const blob of blobs) {
    const data = await readJson(blob.key);
    if (data) players.push(data);
  }

  players.sort((a, b) => a.joinedAt - b.joinedAt);
  return players;
}

async function readRoom(roomCode) {
  const meta = await readJson(metaKey(roomCode));
  if (!meta) return null;

  const players = await listPlayers(roomCode);

  const orderIds = Array.isArray(meta.order) ? meta.order : [];
  const playersById = Object.fromEntries(players.map((p) => [p.id, p]));

  const orderedPlayers = orderIds
    .map((id) => playersById[id])
    .filter(Boolean);

  const missingPlayers = players.filter((p) => !orderIds.includes(p.id));
  const fullOrder = [...orderedPlayers, ...missingPlayers];

  return {
    meta: {
      ...meta,
      order: fullOrder.map((p) => p.id)
    },
    players: fullOrder
  };
}

function roomSnapshot(room, requesterId = "") {
  const { meta, players } = room;
  const currentTurnPlayerId =
    players.length > 0 && meta.turnIndex >= 0 && meta.turnIndex < players.length
      ? players[meta.turnIndex]?.id || null
      : null;

  const totalCurrentBets = players.reduce(
    (sum, p) => sum + chipsToAmount(p.betChips),
    0
  );

  return {
    roomCode: meta.roomCode,
    hostPlayerId: meta.hostPlayerId,
    initialAmount: meta.initialAmount,
    potAmount: meta.potAmount,
    totalCurrentBets,
    turnIndex: meta.turnIndex,
    currentTurnPlayerId,
    players: players.map((p, index) => ({
      id: p.id,
      name: p.name,
      isHost: p.id === meta.hostPlayerId,
      order: index + 1,
      stackChips: p.stackChips,
      betChips: p.betChips,
      stackAmount: chipsToAmount(p.stackChips),
      betAmount: chipsToAmount(p.betChips),
      joinedAt: p.joinedAt
    })),
    you: requesterId
      ? {
          playerId: requesterId,
          isHost: requesterId === meta.hostPlayerId
        }
      : null
  };
}

function assertHost(room, playerId) {
  if (room.meta.hostPlayerId !== playerId) {
    throw new Error("호스트만 사용할 수 있습니다.");
  }
}

function assertRoomPlayer(room, playerId) {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) throw new Error("이 방의 플레이어가 아닙니다.");
  return player;
}

function normalizePlayerName(name = "") {
  return String(name).trim().slice(0, 16);
}

async function createRoom(playerNameRaw) {
  const playerName = normalizePlayerName(playerNameRaw);
  if (!playerName) throw new Error("플레이어 이름을 입력하세요.");

  let roomCode = "";
  let exists = true;

  while (exists) {
    roomCode = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(2, 8);
    exists = !!(await readJson(metaKey(roomCode)));
  }

  const playerId = createPlayerId();
  const now = Date.now();

  const meta = {
    roomCode,
    hostPlayerId: playerId,
    initialAmount: 0,
    potAmount: 0,
    turnIndex: 0,
    order: [playerId],
    createdAt: now
  };

  const player = {
    id: playerId,
    name: playerName,
    stackChips: emptyChips(),
    betChips: emptyChips(),
    joinedAt: now
  };

  await writeJson(metaKey(roomCode), meta);
  await writeJson(playerKey(roomCode, playerId), player);

  return { roomCode, playerId };
}

async function joinRoom(roomCodeRaw, playerNameRaw, existingPlayerId = "") {
  const roomCode = sanitizeRoomCode(roomCodeRaw);
  const playerName = normalizePlayerName(playerNameRaw);

  if (!roomCode) throw new Error("방 코드를 입력하세요.");
  if (!playerName) throw new Error("플레이어 이름을 입력하세요.");

  const room = await readRoom(roomCode);
  if (!room) throw new Error("방을 찾을 수 없습니다.");

  if (existingPlayerId) {
    const existingPlayer = room.players.find((p) => p.id === existingPlayerId);
    if (existingPlayer) {
      return { roomCode, playerId: existingPlayerId };
    }
  }

  if (room.players.length >= MAX_PLAYERS) {
    throw new Error("이 방은 이미 4명입니다.");
  }

  if (room.players.some((p) => p.name === playerName)) {
    throw new Error("같은 이름이 이미 있습니다.");
  }

  const playerId = createPlayerId();
  const now = Date.now();

  const player = {
    id: playerId,
    name: playerName,
    stackChips: room.meta.initialAmount > 0 ? amountToChips(room.meta.initialAmount) : emptyChips(),
    betChips: emptyChips(),
    joinedAt: now
  };

  const nextMeta = {
    ...room.meta,
    order: [...room.meta.order, playerId]
  };

  await writeJson(playerKey(roomCode, playerId), player);
  await writeJson(metaKey(roomCode), nextMeta);

  return { roomCode, playerId };
}

async function setInitialAmount(roomCodeRaw, playerId, amountRaw) {
  const roomCode = sanitizeRoomCode(roomCodeRaw);
  const amount = Math.max(0, Math.floor(Number(amountRaw) || 0));

  if (amount <= 0 || amount % 10 !== 0) {
    throw new Error("초기 금액은 10 단위의 0보다 큰 숫자여야 합니다.");
  }

  const room = await readRoom(roomCode);
  if (!room) throw new Error("방을 찾을 수 없습니다.");
  assertHost(room, playerId);

  const updatedMeta = {
    ...room.meta,
    initialAmount: amount,
    potAmount: 0,
    turnIndex: 0
  };

  await writeJson(metaKey(roomCode), updatedMeta);

  for (const player of room.players) {
    const updatedPlayer = {
      ...player,
      stackChips: amountToChips(amount),
      betChips: emptyChips()
    };
    await writeJson(playerKey(roomCode, player.id), updatedPlayer);
  }

  return true;
}

async function moveOrder(roomCodeRaw, playerId, targetPlayerId, direction) {
  const roomCode = sanitizeRoomCode(roomCodeRaw);
  const room = await readRoom(roomCode);
  if (!room) throw new Error("방을 찾을 수 없습니다.");
  assertHost(room, playerId);

  const order = [...room.meta.order];
  const index = order.indexOf(targetPlayerId);
  if (index === -1) throw new Error("플레이어를 찾을 수 없습니다.");

  const swapIndex = direction === "up" ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= order.length) return true;

  [order[index], order[swapIndex]] = [order[swapIndex], order[index]];

  let turnIndex = room.meta.turnIndex;
  if (turnIndex === index) turnIndex = swapIndex;
  else if (turnIndex === swapIndex) turnIndex = index;

  await writeJson(metaKey(roomCode), {
    ...room.meta,
    order,
    turnIndex
  });

  return true;
}

async function setTurn(roomCodeRaw, playerId, turnIndexRaw) {
  const roomCode = sanitizeRoomCode(roomCodeRaw);
  const room = await readRoom(roomCode);
  if (!room) throw new Error("방을 찾을 수 없습니다.");
  assertHost(room, playerId);

  if (room.players.length === 0) throw new Error("플레이어가 없습니다.");

  let turnIndex = Math.floor(Number(turnIndexRaw) || 0);
  if (turnIndex < 0) turnIndex = 0;
  if (turnIndex >= room.players.length) turnIndex = room.players.length - 1;

  await writeJson(metaKey(roomCode), {
    ...room.meta,
    turnIndex
  });

  return true;
}

async function nextTurn(roomCodeRaw, playerId, stepRaw) {
  const roomCode = sanitizeRoomCode(roomCodeRaw);
  const room = await readRoom(roomCode);
  if (!room) throw new Error("방을 찾을 수 없습니다.");
  assertHost(room, playerId);

  if (room.players.length === 0) throw new Error("플레이어가 없습니다.");

  const step = Number(stepRaw) < 0 ? -1 : 1;
  let turnIndex = room.meta.turnIndex + step;

  if (turnIndex < 0) turnIndex = room.players.length - 1;
  if (turnIndex >= room.players.length) turnIndex = 0;

  await writeJson(metaKey(roomCode), {
    ...room.meta,
    turnIndex
  });

  return true;
}

async function addChipToBet(roomCodeRaw, playerId, denominationRaw) {
  const roomCode = sanitizeRoomCode(roomCodeRaw);
  const denomination = Number(denominationRaw);

  if (!CHIP_VALUES.includes(denomination)) {
    throw new Error("잘못된 칩 단위입니다.");
  }

  const room = await readRoom(roomCode);
  if (!room) throw new Error("방을 찾을 수 없습니다.");

  const player = assertRoomPlayer(room, playerId);
  const nextPlayer = {
    ...player,
    stackChips: cloneChips(player.stackChips),
    betChips: cloneChips(player.betChips)
  };

  moveChip(nextPlayer.stackChips, nextPlayer.betChips, denomination, 1);
  await writeJson(playerKey(roomCode, player.id), nextPlayer);

  return true;
}

async function removeChipFromBet(roomCodeRaw, playerId, denominationRaw) {
  const roomCode = sanitizeRoomCode(roomCodeRaw);
  const denomination = Number(denominationRaw);

  if (!CHIP_VALUES.includes(denomination)) {
    throw new Error("잘못된 칩 단위입니다.");
  }

  const room = await readRoom(roomCode);
  if (!room) throw new Error("방을 찾을 수 없습니다.");

  const player = assertRoomPlayer(room, playerId);
  const nextPlayer = {
    ...player,
    stackChips: cloneChips(player.stackChips),
    betChips: cloneChips(player.betChips)
  };

  moveChip(nextPlayer.betChips, nextPlayer.stackChips, denomination, 1);
  await writeJson(playerKey(roomCode, player.id), nextPlayer);

  return true;
}

async function clearMyBet(roomCodeRaw, playerId) {
  const roomCode = sanitizeRoomCode(roomCodeRaw);
  const room = await readRoom(roomCode);
  if (!room) throw new Error("방을 찾을 수 없습니다.");

  const player = assertRoomPlayer(room, playerId);
  const returned = cloneChips(player.stackChips);
  const currentBet = cloneChips(player.betChips);

  for (const value of CHIP_VALUES) {
    const key = String(value);
    returned[key] += currentBet[key];
  }

  await writeJson(playerKey(roomCode, player.id), {
    ...player,
    stackChips: returned,
    betChips: emptyChips()
  });

  return true;
}

async function collectBets(roomCodeRaw, playerId) {
  const roomCode = sanitizeRoomCode(roomCodeRaw);
  const room = await readRoom(roomCode);
  if (!room) throw new Error("방을 찾을 수 없습니다.");
  assertHost(room, playerId);

  let collected = 0;

  for (const player of room.players) {
    collected += chipsToAmount(player.betChips);
    await writeJson(playerKey(roomCode, player.id), {
      ...player,
      betChips: emptyChips()
    });
  }

  await writeJson(metaKey(roomCode), {
    ...room.meta,
    potAmount: room.meta.potAmount + collected
  });

  return true;
}

async function refundAllBets(roomCodeRaw, playerId) {
  const roomCode = sanitizeRoomCode(roomCodeRaw);
  const room = await readRoom(roomCode);
  if (!room) throw new Error("방을 찾을 수 없습니다.");
  assertHost(room, playerId);

  for (const player of room.players) {
    const stack = cloneChips(player.stackChips);
    const bet = cloneChips(player.betChips);

    for (const value of CHIP_VALUES) {
      const key = String(value);
      stack[key] += bet[key];
    }

    await writeJson(playerKey(roomCode, player.id), {
      ...player,
      stackChips: stack,
      betChips: emptyChips()
    });
  }

  return true;
}

async function resetPot(roomCodeRaw, playerId) {
  const roomCode = sanitizeRoomCode(roomCodeRaw);
  const room = await readRoom(roomCode);
  if (!room) throw new Error("방을 찾을 수 없습니다.");
  assertHost(room, playerId);

  await writeJson(metaKey(roomCode), {
    ...room.meta,
    potAmount: 0
  });

  return true;
}

export default async (req) => {
  try {
    if (req.method !== "POST") {
      return error("POST만 지원합니다.", 405);
    }

    const body = await req.json();
    const action = body?.action;

    if (!action) {
      return error("action이 필요합니다.");
    }

    if (action === "create_room") {
      const result = await createRoom(body.playerName);
      const room = await readRoom(result.roomCode);
      return json({
        ok: true,
        ...result,
        room: roomSnapshot(room, result.playerId)
      });
    }

    if (action === "join_room") {
      const result = await joinRoom(body.roomCode, body.playerName, body.playerId);
      const room = await readRoom(result.roomCode);
      return json({
        ok: true,
        ...result,
        room: roomSnapshot(room, result.playerId)
      });
    }

    if (action === "get_room") {
      const roomCode = sanitizeRoomCode(body.roomCode);
      const room = await readRoom(roomCode);
      if (!room) return error("방을 찾을 수 없습니다.", 404);
      return json({
        ok: true,
        room: roomSnapshot(room, body.playerId || "")
      });
    }

    if (action === "set_initial_amount") {
      await setInitialAmount(body.roomCode, body.playerId, body.amount);
    } else if (action === "move_order") {
      await moveOrder(body.roomCode, body.playerId, body.targetPlayerId, body.direction);
    } else if (action === "set_turn") {
      await setTurn(body.roomCode, body.playerId, body.turnIndex);
    } else if (action === "next_turn") {
      await nextTurn(body.roomCode, body.playerId, body.step);
    } else if (action === "add_chip") {
      await addChipToBet(body.roomCode, body.playerId, body.denomination);
    } else if (action === "remove_chip") {
      await removeChipFromBet(body.roomCode, body.playerId, body.denomination);
    } else if (action === "clear_my_bet") {
      await clearMyBet(body.roomCode, body.playerId);
    } else if (action === "collect_bets") {
      await collectBets(body.roomCode, body.playerId);
    } else if (action === "refund_all_bets") {
      await refundAllBets(body.roomCode, body.playerId);
    } else if (action === "reset_pot") {
      await resetPot(body.roomCode, body.playerId);
    } else {
      return error("알 수 없는 action입니다.");
    }

    const roomCode = sanitizeRoomCode(body.roomCode);
    const room = await readRoom(roomCode);
    return json({
      ok: true,
      room: roomSnapshot(room, body.playerId || "")
    });
  } catch (err) {
    return error(err?.message || "서버 오류가 발생했습니다.", 500);
  }
};