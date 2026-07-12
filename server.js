// ============================================================
//  ジャンケンバトラーズ - オンライン対戦リレーサーバー
// ============================================================
// 方式: 「リレー」— このサーバーはダメージ計算などのゲームロジックを
// 一切持たない。両プレイヤーの「手」や「デッキ」をお互いに送り合う
// だけの中継役。実際の勝敗判定は両クライアント（ゲーム本体のHTML）が
// それぞれ同じロジックでローカル計算する。
//
// メリット: 実装が小さく速い。友達同士のカジュアル対戦には十分。
// デメリット: 改造されたクライアントが自己申告する手を偽ることは
//   理論上可能（サーバー側で「本当にその手だったか」を検証しない）。
//   本格的な不正対策が必要になったら、ここにダメージ計算ロジックを
//   移植してサーバー権威型に強化できる（今回はその手前の段階）。
//
// ---- レイドバトル(2人協力)について ----
// 1v1のPvPとは別に、レイドは「共有ボスHP」をサーバー側で権威的に
// 管理する必要がある(クライアント側だけで持たせるとボスHPを
// チートできてしまうため)。そのため、レイド関連の判定(勝敗・
// ダメージ計算・ボスの手のランダム決定)は全てサーバー側で行う。
// プレイヤー自身のステータス(hp/atk/winBonus)はクライアントが
// 計算した値を送ってもらう(既存のsubmit_deckと同じ信頼レベル)。
// ============================================================

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.get('/', (req, res) => {
  res.send('janken-battlers relay server: OK');
});
// Render等のヘルスチェック用
app.get('/healthz', (req, res) => res.status(200).send('ok'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const PORT = process.env.PORT || 3000;

// ---- ルーム管理(PvP) ----
// rooms[code] = {
//   code, players: [socketId, socketId?], names: {socketId: name},
//   decks: {socketId: [{id,hp,atk}x3]}, hands: {socketId: 'rock'|'scissors'|'paper'},
//   started: bool, battleEnded: bool
// }
const rooms = {};
// クイックマッチ待機列: [{socketId, name}]
const quickQueue = [];

function makeRoomCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms[code] || raidRooms[code]);
  return code;
}

function seatFor(room, socketId) {
  const idx = room.players.indexOf(socketId);
  return idx === 0 ? 'p1' : 'p2';
}

function otherPlayer(room, socketId) {
  return room.players.find((id) => id !== socketId);
}

function removeFromQueue(socketId) {
  const idx = quickQueue.findIndex((q) => q.socketId === socketId);
  if (idx !== -1) quickQueue.splice(idx, 1);
}

function cleanupRoom(code) {
  delete rooms[code];
}

// 相手に「退室しました」を通知するかどうか:
// 対戦が正常に終わった後の退室（battleEnded=true）は静かに片付けるだけ。
// 対戦中の切断だけ相手に知らせる。
function leaveRoom(socket, { silent = false } = {}) {
  const code = socket.data.roomId;
  if (!code) return;
  const room = rooms[code];
  if (room) {
    const opponentId = otherPlayer(room, socket.id);
    if (opponentId && !silent && !room.battleEnded) {
      io.to(opponentId).emit('opponent_left');
    }
    cleanupRoom(code);
  }
  socket.leave(code);
  socket.data.roomId = null;
}

// ============================================================
//  レイドバトル(2人協力・サーバー権威)
// ============================================================

// 難易度ごとのボス基礎スペック(企画書の数値をそのまま反映)
// dmgPerWin = atk + winBonus (通常の勝利ダメージ)
// ultPercent = 5ターンに1回の必殺技で、対象プレイヤーの「現在HP」に対して削る割合
const RAID_BOSS_STATS = {
  easy:   { hp: 6000,   atk: 6,  winBonus: 2,  ultPercent: 0.10 },
  medium: { hp: 30000,  atk: 26, winBonus: 10, ultPercent: 0.30 },
  hard:   { hp: 120000, atk: 80, winBonus: 32, ultPercent: 0.50 },
};
const RAID_ULT_INTERVAL = 5; // 5ターンに1回

// raidRooms[code] = {
//   code, difficulty, players: [socketId, socketId],
//   names: {socketId: name},
//   playerCards: {socketId: {id, hp, maxHp, atk, winBonus, hand}}, // hand = 得意手
//   boss: {hp, maxHp, atk, winBonus, ultPercent},
//   turnCount: number,
//   hands: {socketId: 'rock'|'scissors'|'paper'},
//   started: bool, ended: bool,
// }
const raidRooms = {};
// 難易度ごとの待機列: {easy: [...], medium: [...], hard: [...]}
const raidQueues = { easy: [], medium: [], hard: [] };

function removeFromRaidQueue(socketId) {
  Object.keys(raidQueues).forEach((diff) => {
    const q = raidQueues[diff];
    const idx = q.findIndex((e) => e.socketId === socketId);
    if (idx !== -1) q.splice(idx, 1);
  });
}

function otherRaidPlayer(room, socketId) {
  return room.players.find((id) => id !== socketId);
}

// じゃんけん判定: 'win' | 'lose' | 'draw' (aから見た結果)
function judgeHand(a, b) {
  if (a === b) return 'draw';
  const beats = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
  return beats[a] === b ? 'win' : 'lose';
}

function cleanupRaidRoom(code) {
  delete raidRooms[code];
}

function leaveRaidRoom(socket, { silent = false } = {}) {
  const code = socket.data.raidRoomId;
  if (!code) return;
  const room = raidRooms[code];
  if (room) {
    const opponentId = otherRaidPlayer(room, socket.id);
    if (opponentId && !silent && !room.ended) {
      io.to(opponentId).emit('raid_opponent_left');
    }
    cleanupRaidRoom(code);
  }
  socket.leave(code);
  socket.data.raidRoomId = null;
}

function startRaidRoom(idA, idB, nameA, nameB, difficulty) {
  const code = makeRoomCode();
  const bossSpec = RAID_BOSS_STATS[difficulty];
  raidRooms[code] = {
    code,
    difficulty,
    players: [idA, idB],
    names: { [idA]: nameA, [idB]: nameB },
    playerDecks: {},   // socketId -> [{id,hp,maxHp,atk,winBonus,hand}, x3]
    activeIdx: {},     // socketId -> current active card index (0-2)
    boss: { hp: bossSpec.hp, maxHp: bossSpec.hp, atk: bossSpec.atk, winBonus: bossSpec.winBonus, ultPercent: bossSpec.ultPercent },
    turnCount: 0,
    hands: {},
    started: false,
    ended: false,
  };
  [idA, idB].forEach((id) => {
    const s = io.sockets.sockets.get(id);
    if (s) { s.data.raidRoomId = code; s.join(code); }
  });
  const room = raidRooms[code];
  room.players.forEach((id) => {
    const oppId = otherRaidPlayer(room, id);
    io.to(id).emit('raid_deck_select_start', {
      difficulty,
      players: [
        { name: room.names[id] },
        { name: room.names[oppId] },
      ],
    });
  });
}

// 現在の活きてるカードのindexを返す(activeIdxが倒れてたら次の生存カードへ自動で進める)
// 全滅してたら null
function ensureAliveActive(room, socketId) {
  const deck = room.playerDecks[socketId];
  let idx = room.activeIdx[socketId];
  if (deck[idx] && deck[idx].hp > 0) return idx;
  const aliveIdx = deck.findIndex((c) => c.hp > 0);
  if (aliveIdx === -1) return null; // 全滅
  room.activeIdx[socketId] = aliveIdx;
  return aliveIdx;
}

function resolveRaidTurn(room) {
  const [idA, idB] = room.players;
  const bossHand = ['rock', 'scissors', 'paper'][Math.floor(Math.random() * 3)];
  room.turnCount += 1;
  const isUltTurn = room.turnCount % RAID_ULT_INTERVAL === 0;

  const results = {};
  [idA, idB].forEach((id) => {
    const idx = room.activeIdx[id];
    const card = room.playerDecks[id][idx];
    const hand = room.hands[id];
    const outcome = judgeHand(hand, bossHand); // cardから見た結果
    let bossDamage = 0;
    let playerDamage = 0;
    if (outcome === 'win') {
      bossDamage = card.atk + (hand === card.hand ? card.winBonus : 0);
      room.boss.hp = Math.max(0, room.boss.hp - bossDamage);
    } else if (outcome === 'lose') {
      // ボスは得意手固定を持たない(毎ターンランダム)ので、勝った時は常にwinBonus込みで計算する
      playerDamage = room.boss.atk + room.boss.winBonus;
      card.hp = Math.max(0, card.hp - playerDamage);
    }
    results[id] = { hand, outcome, bossDamage, playerDamage, cardIdx: idx, hpAfter: card.hp, cardKO: card.hp <= 0 };
  });

  // 必殺技(5ターンに1回、両プレイヤーの現在アクティブカードに現HPの割合ダメージ、回避不可)
  let ultResults = null;
  if (isUltTurn) {
    ultResults = {};
    [idA, idB].forEach((id) => {
      const idx = room.activeIdx[id];
      const card = room.playerDecks[id][idx];
      const dmg = Math.round(card.hp * room.boss.ultPercent);
      card.hp = Math.max(0, card.hp - dmg);
      ultResults[id] = { damage: dmg, cardIdx: idx, hpAfter: card.hp, cardKO: card.hp <= 0 };
    });
  }

  room.hands = {};

  // 倒れたカードがあれば次の生存カードへ自動交代。両者とも全滅していたらそのプレイヤーは戦闘不能。
  const playersDown = [];
  const swaps = {};
  [idA, idB].forEach((id) => {
    const before = room.activeIdx[id];
    const aliveIdx = ensureAliveActive(room, id);
    if (aliveIdx === null) {
      playersDown.push(id);
    } else if (aliveIdx !== before) {
      swaps[id] = aliveIdx;
    }
  });

  const bossDefeated = room.boss.hp <= 0;
  const nextTurnIsUlt = (room.turnCount + 1) % RAID_ULT_INTERVAL === 0;

  room.players.forEach((id) => {
    const oppId = otherRaidPlayer(room, id);
    io.to(id).emit('raid_turn_result', {
      bossHand,
      turnCount: room.turnCount,
      bossHp: room.boss.hp,
      bossMaxHp: room.boss.maxHp,
      you: results[id],
      opponent: results[oppId],
      ultimate: isUltTurn ? { you: ultResults[id], opponent: ultResults[oppId] } : null,
      yourAutoSwap: swaps[id] != null ? swaps[id] : null,
      opponentAutoSwap: swaps[oppId] != null ? swaps[oppId] : null,
      bossDefeated,
      playersDown,
      nextTurnIsUlt: bossDefeated ? false : nextTurnIsUlt,
    });
  });

  if (bossDefeated || playersDown.length > 0) {
    room.ended = true;
  }
  return { bossDefeated, playersDown };
}

// ============================================================
//  ソケット接続
// ============================================================

io.on('connection', (socket) => {
  socket.data.roomId = null;
  socket.data.raidRoomId = null;

  // ---- PvP(既存) ----
  socket.on('create_room', (data) => {
    try {
      const name = (data && data.name) || 'プレイヤー';
      const code = makeRoomCode();
      rooms[code] = {
        code,
        players: [socket.id],
        names: { [socket.id]: name },
        decks: {},
        hands: {},
        started: false,
        battleEnded: false,
      };
      socket.data.roomId = code;
      socket.join(code);
      socket.emit('room_created', { roomId: code });
    } catch (e) {
      console.error('[create_room]', e);
    }
  });

  socket.on('join_room', (data) => {
    try {
      const code = data && data.code;
      const name = (data && data.name) || 'プレイヤー';
      const room = rooms[code];
      if (!room) { socket.emit('join_error', { reason: 'ROOM_NOT_FOUND' }); return; }
      if (room.players.length >= 2) { socket.emit('join_error', { reason: 'ROOM_FULL' }); return; }
      if (room.started) { socket.emit('join_error', { reason: 'ALREADY_STARTED' }); return; }

      room.players.push(socket.id);
      room.names[socket.id] = name;
      socket.data.roomId = code;
      socket.join(code);

      const playersInfo = room.players.map((id) => ({ seat: seatFor(room, id), name: room.names[id] }));
      io.to(code).emit('lobby_update', { roomId: code, players: playersInfo });

      room.players.forEach((id) => {
        const oppId = otherPlayer(room, id);
        io.to(id).emit('deck_select_start', {
          players: [
            { seat: seatFor(room, id), name: room.names[id] },
            { seat: seatFor(room, oppId), name: room.names[oppId] },
          ],
        });
      });
    } catch (e) {
      console.error('[join_room]', e);
    }
  });

  socket.on('quick_match', (data) => {
    try {
      const name = (data && data.name) || 'プレイヤー';
      removeFromQueue(socket.id);

      if (quickQueue.length > 0) {
        const partner = quickQueue.shift();
        const code = makeRoomCode();
        rooms[code] = {
          code,
          players: [partner.socketId, socket.id],
          names: { [partner.socketId]: partner.name, [socket.id]: name },
          decks: {},
          hands: {},
          started: false,
          battleEnded: false,
        };
        const room = rooms[code];
        [partner.socketId, socket.id].forEach((id) => {
          const s = io.sockets.sockets.get(id);
          if (s) { s.data.roomId = code; s.join(code); }
        });
        room.players.forEach((id) => {
          const oppId = otherPlayer(room, id);
          io.to(id).emit('deck_select_start', {
            players: [
              { seat: seatFor(room, id), name: room.names[id] },
              { seat: seatFor(room, oppId), name: room.names[oppId] },
            ],
          });
        });
      } else {
        quickQueue.push({ socketId: socket.id, name });
        socket.emit('quick_match_waiting');
      }
    } catch (e) {
      console.error('[quick_match]', e);
    }
  });

  socket.on('cancel_quick_match', () => {
    removeFromQueue(socket.id);
  });

  socket.on('submit_deck', (data) => {
    try {
      const code = socket.data.roomId;
      const room = rooms[code];
      if (!room) return;
      room.decks[socket.id] = (data && data.deck) || [];

      if (room.players.length === 2 && room.players.every((id) => room.decks[id])) {
        room.started = true;
        room.players.forEach((id) => {
          const oppId = otherPlayer(room, id);
          io.to(id).emit('battle_start', {
            yourDeck: room.decks[id],
            opponentDeck: room.decks[oppId],
            opponentName: room.names[oppId],
          });
        });
      }
    } catch (e) {
      console.error('[submit_deck]', e);
    }
  });

  socket.on('submit_hand', (data) => {
    try {
      const code = socket.data.roomId;
      const room = rooms[code];
      if (!room) return;
      const hand = data && data.hand;
      if (!['rock', 'scissors', 'paper', 'ultimate'].includes(hand)) return;
      room.hands[socket.id] = hand;

      if (room.players.length === 2 && room.players.every((id) => room.hands[id])) {
        room.players.forEach((id) => {
          const oppId = otherPlayer(room, id);
          io.to(id).emit('turn_result', {
            yourHand: room.hands[id],
            opponentHand: room.hands[oppId],
          });
        });
        room.hands = {};
      }
    } catch (e) {
      console.error('[submit_hand]', e);
    }
  });

  socket.on('report_battle_end', () => {
    const code = socket.data.roomId;
    const room = rooms[code];
    if (room) room.battleEnded = true;
  });

  socket.on('leave_room', () => {
    leaveRoom(socket);
  });

  // ---- レイドバトル(新規) ----
  socket.on('quick_match_raid', (data) => {
    try {
      const name = (data && data.name) || 'プレイヤー';
      const difficulty = (data && data.difficulty) || 'easy';
      if (!RAID_BOSS_STATS[difficulty]) return;
      removeFromRaidQueue(socket.id);

      const queue = raidQueues[difficulty];
      if (queue.length > 0) {
        const partner = queue.shift();
        startRaidRoom(partner.socketId, socket.id, partner.name, name, difficulty);
      } else {
        queue.push({ socketId: socket.id, name });
        socket.emit('raid_quick_match_waiting');
      }
    } catch (e) {
      console.error('[quick_match_raid]', e);
    }
  });

  socket.on('cancel_quick_match_raid', () => {
    removeFromRaidQueue(socket.id);
  });

  // data.deck = [{ id, hp, atk, winBonus, hand }, x3] — 3枚のステータス
  // (クライアント計算済みの値を信頼する。既存submit_deckと同じ信頼レベル)
  socket.on('submit_raid_deck', (data) => {
    try {
      const code = socket.data.raidRoomId;
      const room = raidRooms[code];
      if (!room) return;
      const deck = data && data.deck;
      if (!Array.isArray(deck) || deck.length !== 3) return;
      if (!deck.every((c) => c && typeof c.hp === 'number' && typeof c.atk === 'number')) return;
      room.playerDecks[socket.id] = deck.map((c) => ({ ...c, maxHp: c.hp }));
      room.activeIdx[socket.id] = 0;

      if (room.players.length === 2 && room.players.every((id) => room.playerDecks[id])) {
        room.started = true;
        room.players.forEach((id) => {
          const oppId = otherRaidPlayer(room, id);
          io.to(id).emit('raid_battle_start', {
            yourDeck: room.playerDecks[id],
            opponentDeck: room.playerDecks[oppId],
            opponentName: room.names[oppId],
            boss: room.boss,
          });
        });
      }
    } catch (e) {
      console.error('[submit_raid_deck]', e);
    }
  });

  // 任意交代(ターン消費なし) — data.index = 交代先(0-2)、生存カードのみ可
  socket.on('submit_raid_swap', (data) => {
    try {
      const code = socket.data.raidRoomId;
      const room = raidRooms[code];
      if (!room || !room.started || room.ended) return;
      const idx = data && data.index;
      const deck = room.playerDecks[socket.id];
      if (!deck || !deck[idx] || deck[idx].hp <= 0) return;
      room.activeIdx[socket.id] = idx;
      const oppId = otherRaidPlayer(room, socket.id);
      if (oppId) io.to(oppId).emit('raid_opponent_swap', { index: idx });
    } catch (e) {
      console.error('[submit_raid_swap]', e);
    }
  });

  socket.on('submit_raid_hand', (data) => {
    try {
      const code = socket.data.raidRoomId;
      const room = raidRooms[code];
      if (!room || !room.started || room.ended) return;
      const hand = data && data.hand;
      if (!['rock', 'scissors', 'paper'].includes(hand)) return;
      room.hands[socket.id] = hand;

      if (room.players.length === 2 && room.players.every((id) => room.hands[id])) {
        resolveRaidTurn(room);
      }
    } catch (e) {
      console.error('[submit_raid_hand]', e);
    }
  });

  socket.on('report_raid_end', () => {
    const code = socket.data.raidRoomId;
    const room = raidRooms[code];
    if (room) room.ended = true;
  });

  // プレイヤー必殺技: ダメージ計算はクライアント側(デッキ同様クライアント信頼のリレー方針)。
  // サーバーはボスHPへの適用と両者への同報だけを担当する。
  socket.on('use_raid_ult', (data) => {
    try {
      const code = socket.data.raidRoomId;
      const room = raidRooms[code];
      if (!room || !room.started || room.ended) return;
      const damage = Math.max(0, Math.min(999999, Math.round((data && data.damage) || 0)));
      if (!damage) return;
      room.boss.hp = Math.max(0, room.boss.hp - damage);
      const bossDefeated = room.boss.hp <= 0;
      if (bossDefeated) room.ended = true;
      const moveName = ((data && data.moveName) ? String(data.moveName) : '必殺技').slice(0, 40);
      room.players.forEach((id) => {
        io.to(id).emit('raid_ult_used', {
          byYou: id === socket.id,
          moveName,
          damage,
          bossHp: room.boss.hp,
          bossMaxHp: room.boss.maxHp,
          bossDefeated,
        });
      });
    } catch (e) {
      console.error('[use_raid_ult]', e);
    }
  });

  socket.on('leave_raid_room', () => {
    leaveRaidRoom(socket);
  });

  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    leaveRoom(socket);
    removeFromRaidQueue(socket.id);
    leaveRaidRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`janken-battlers relay server listening on :${PORT}`);
});
