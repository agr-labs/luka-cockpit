// Deterministic Beat-the-Bot Game Engine (shared across Node SSE station, Cloudflare D1 worker, & offline browser).
// Quiz truth, timers, answer validation, streak multipliers, and leaderboards are 100% deterministic.
// CoRa LLM / voice adds charismatic commentary on top without ever altering scores or answers.

import { getScenarioPack } from './scenario-packs.js';

export const GAME_PHASES = ['lobby', 'intro', 'question', 'reveal', 'leaderboard', 'qa', 'finale'];
export const LUKA_PLAYER_ID = '__luka__';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode(len = 4) {
  let code = '';
  for (let i = 0; i < len; i++) {
    code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
  }
  return code;
}

export function normalizeRoomCode(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
}

export function sanitizeCallsign(name) {
  const clean = String(name || '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 22);
  return clean || `Explorer-${Math.floor(100 + Math.random() * 900)}`;
}

// Deterministic pseudo-random helper seeded by room + question index so Luka's choice is consistent across clients
function seededUnit(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

export function computePoints({ correct, remainingMs, totalMs, streak }) {
  if (!correct) return 0;
  const ratio = Math.max(0, Math.min(1, Number(remainingMs || 0) / Math.max(1, Number(totalMs || 15000))));
  const speedBonus = Math.round(ratio * 500);
  const streakBonus = Math.min(Math.max(0, (streak || 1) - 1), 4) * 150;
  return 1000 + speedBonus + streakBonus;
}

export function createRoomState({ code, packId = 'earth-space-trivia', hostName = 'Mission Control', now = Date.now() } = {}) {
  const pack = getScenarioPack(packId);
  const roomCode = normalizeRoomCode(code) || generateRoomCode(4);
  return {
    code: roomCode,
    packId: pack.id,
    hostName: sanitizeCallsign(hostName),
    phase: 'lobby',
    questionIndex: -1,
    questionStartedAt: 0,
    questionEndsAt: 0,
    createdAt: now,
    updatedAt: now,
    version: 1,
    players: {
      [LUKA_PLAYER_ID]: {
        id: LUKA_PLAYER_ID,
        name: 'LUKA v. A2U',
        isBot: true,
        avatar: 'luka',
        score: 0,
        streak: 0,
        bestStreak: 0,
        correctCount: 0,
        answeredCount: 0,
        joinedAt: now,
      },
    },
    answers: {}, // { [questionIndex]: { [playerId]: { optionIndex, at, msElapsed, correct, points } } }
    askQueue: [], // [{ id, author, text, at, status: 'pending' | 'active' | 'answered', reply? }]
    activeQaId: null,
    lukaSpeech: {
      text: pack.openingLine,
      gesture: pack.openingGesture || 'wave',
      mood: 'happy',
      seq: 1,
      at: now,
    },
  };
}

export function joinRoom(room, { playerId, name, avatar = 'astronaut', now = Date.now() }) {
  const pid = String(playerId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36) || `p_${Math.random().toString(36).slice(2, 10)}`;
  if (pid === LUKA_PLAYER_ID) return { room, player: room.players[LUKA_PLAYER_ID] };
  const existing = room.players[pid];
  const cleanName = sanitizeCallsign(name);
  const player = existing
    ? { ...existing, name: name ? cleanName : existing.name, avatar: avatar || existing.avatar }
    : {
        id: pid,
        name: cleanName,
        isBot: false,
        avatar: String(avatar || 'astronaut').slice(0, 20),
        score: 0,
        streak: 0,
        bestStreak: 0,
        correctCount: 0,
        answeredCount: 0,
        joinedAt: now,
      };
  room.players[pid] = player;
  room.updatedAt = now;
  room.version += 1;
  return { room, player };
}

function planLukaAnswer(room, qIndex, question) {
  const roll = seededUnit(`${room.code}:${room.packId}:${qIndex}`);
  const isRight = roll < (question.lukaAccuracy ?? 0.88);
  let optionIndex = question.correctIndex;
  if (!isRight) {
    const wrongChoices = question.options.map((_, i) => i).filter((i) => i !== question.correctIndex);
    optionIndex = wrongChoices[Math.floor(seededUnit(`${room.code}:wrong:${qIndex}`) * wrongChoices.length)] ?? 0;
  }
  const totalMs = (question.timeSec || 15) * 1000;
  const msElapsed = Math.round(1600 + seededUnit(`${room.code}:lat:${qIndex}`) * 3400);
  const remainingMs = Math.max(1000, totalMs - msElapsed);
  return { optionIndex, isRight, msElapsed, remainingMs };
}

export function startIntro(room, now = Date.now()) {
  const pack = getScenarioPack(room.packId);
  room.phase = 'intro';
  room.questionIndex = -1;
  room.lukaSpeech = {
    text: pack.openingLine,
    gesture: pack.openingGesture || 'wave',
    mood: 'happy',
    seq: (room.lukaSpeech?.seq || 0) + 1,
    at: now,
  };
  room.updatedAt = now;
  room.version += 1;
  return room;
}

export function startQuestion(room, nextIndex = null, now = Date.now()) {
  const pack = getScenarioPack(room.packId);
  const idx = nextIndex === null ? room.questionIndex + 1 : Number(nextIndex);
  if (idx < 0 || idx >= pack.questions.length) {
    return finishMission(room, now);
  }
  const q = pack.questions[idx];
  const totalMs = (q.timeSec || 15) * 1000;
  room.phase = 'question';
  room.questionIndex = idx;
  room.questionStartedAt = now;
  room.questionEndsAt = now + totalMs;
  if (!room.answers[idx]) room.answers[idx] = {};

  // Pre-compute Luka's deterministic timed answer for this round (scored on reveal!)
  const plan = planLukaAnswer(room, idx, q);
  room.answers[idx][LUKA_PLAYER_ID] = {
    optionIndex: plan.optionIndex,
    at: now + plan.msElapsed,
    msElapsed: plan.msElapsed,
    correct: plan.isRight,
    points: 0, // tallied deterministically on reveal
    scored: false,
  };

  room.lukaSpeech = {
    text: `Round ${idx + 1}: ${q.prompt}`,
    gesture: idx % 2 === 0 ? 'explain' : 'look_around',
    mood: 'curious',
    seq: (room.lukaSpeech?.seq || 0) + 1,
    at: now,
  };
  room.updatedAt = now;
  room.version += 1;
  return room;
}

export function submitAnswer(room, { playerId, optionIndex, now = Date.now() }) {
  if (room.phase !== 'question') return { accepted: false, reason: 'not_in_question' };
  const pack = getScenarioPack(room.packId);
  const idx = room.questionIndex;
  const q = pack.questions[idx];
  if (!q) return { accepted: false, reason: 'invalid_question' };
  const opt = Number(optionIndex);
  if (!Number.isInteger(opt) || opt < 0 || opt >= q.options.length) {
    return { accepted: false, reason: 'invalid_option' };
  }
  if (!room.players[playerId] || playerId === LUKA_PLAYER_ID) {
    return { accepted: false, reason: 'unknown_player' };
  }
  if (!room.answers[idx]) room.answers[idx] = {};
  if (room.answers[idx][playerId]) {
    return { accepted: false, reason: 'already_answered' };
  }

  const totalMs = Math.max(1000, room.questionEndsAt - room.questionStartedAt);
  const msElapsed = Math.max(0, now - room.questionStartedAt);
  const remainingMs = Math.max(0, room.questionEndsAt - now);
  const correct = opt === q.correctIndex;

  room.answers[idx][playerId] = {
    optionIndex: opt,
    at: now,
    msElapsed,
    remainingMs,
    totalMs,
    correct,
    points: 0,
    scored: false,
  };
  room.updatedAt = now;
  room.version += 1;
  return { accepted: true, correct };
}

export function revealQuestion(room, { customReply = null, customGesture = null, now = Date.now() } = {}) {
  const pack = getScenarioPack(room.packId);
  const idx = room.questionIndex;
  const q = pack.questions[idx];
  if (!q) return room;

  const roundAnswers = room.answers[idx] || {};
  const totalMs = Math.max(1000, (q.timeSec || 15) * 1000);
  let humanAnswered = 0;
  let humanCorrect = 0;

  for (const [pid, player] of Object.entries(room.players)) {
    const ans = roundAnswers[pid];
    if (ans && !ans.scored) {
      const rem = ans.remainingMs ?? Math.max(0, totalMs - (ans.msElapsed || 0));
      const nextStreak = ans.correct ? (player.streak || 0) + 1 : 0;
      const pts = computePoints({
        correct: ans.correct,
        remainingMs: rem,
        totalMs,
        streak: nextStreak,
      });
      player.score = (player.score || 0) + pts;
      player.streak = nextStreak;
      player.bestStreak = Math.max(player.bestStreak || 0, nextStreak);
      player.answeredCount = (player.answeredCount || 0) + 1;
      if (ans.correct) player.correctCount = (player.correctCount || 0) + 1;
      ans.points = pts;
      ans.scored = true;
    } else if (!ans && !player.isBot) {
      // Unanswered human resets streak cleanly
      player.streak = 0;
    }

    if (!player.isBot && ans) {
      humanAnswered += 1;
      if (ans.correct) humanCorrect += 1;
    }
  }

  room.phase = 'reveal';

  const humanAcc = humanAnswered > 0 ? humanCorrect / humanAnswered : 0;
  let speechText = customReply;
  let gesture = customGesture;
  let mood = 'happy';

  if (!speechText) {
    if (humanAnswered > 0 && humanAcc === 1) {
      speechText = `${pack.perfectRoundLine} ${q.lukaRightQuip}`;
      gesture = 'celebrate';
      mood = 'celebrate';
    } else if (humanAnswered > 0 && humanAcc < 0.45) {
      speechText = q.lukaWrongQuip || pack.crowdMissLine;
      gesture = 'shake_no';
      mood = 'curious';
    } else {
      speechText = q.lukaRightQuip;
      gesture = 'nod';
      mood = 'happy';
    }
  }

  room.lukaSpeech = {
    text: speechText,
    gesture: gesture || 'explain',
    mood,
    seq: (room.lukaSpeech?.seq || 0) + 1,
    at: now,
  };
  room.updatedAt = now;
  room.version += 1;
  return room;
}

export function showLeaderboard(room, now = Date.now()) {
  const board = buildLeaderboard(room);
  const topHuman = board.find((p) => !p.isBot);
  const luka = board.find((p) => p.isBot);
  room.phase = 'leaderboard';

  let text = 'Checking mission telemetry and updating the leaderboard.';
  let gesture = 'explain';
  let mood = 'curious';

  if (topHuman && luka) {
    if (topHuman.score > luka.score) {
      text = `${topHuman.name} is ahead of me with ${topHuman.score} points! Requesting higher clock speed immediately.`;
      gesture = 'celebrate';
      mood = 'happy';
    } else if (luka.score > topHuman.score) {
      text = `I currently hold the lead at ${luka.score} points, with ${topHuman.name} right behind at ${topHuman.score}. Keep pushing, humans!`;
      gesture = 'nod';
      mood = 'happy';
    } else {
      text = `Dead heat at ${luka.score} points between ${topHuman.name} and me! Next round breaks the tie.`;
      gesture = 'think';
      mood = 'curious';
    }
  }

  room.lukaSpeech = { text, gesture, mood, seq: (room.lukaSpeech?.seq || 0) + 1, at: now };
  room.updatedAt = now;
  room.version += 1;
  return room;
}

export function openQaMode(room, now = Date.now()) {
  room.phase = 'qa';
  room.lukaSpeech = {
    text: 'Ask Luka Anything is live! Beam your Ocean vs. Orbit questions from your phones, or interrupt me on the stage mic anytime.',
    gesture: 'open_hands',
    mood: 'happy',
    seq: (room.lukaSpeech?.seq || 0) + 1,
    at: now,
  };
  room.updatedAt = now;
  room.version += 1;
  return room;
}

export function finishMission(room, now = Date.now()) {
  const pack = getScenarioPack(room.packId);
  const board = buildLeaderboard(room);
  const topHuman = board.find((p) => !p.isBot);
  const luka = board.find((p) => p.isBot);
  const humansBeatBot = Boolean(topHuman && luka && topHuman.score >= luka.score);

  room.phase = 'finale';
  room.lukaSpeech = {
    text: humansBeatBot
      ? `${pack.humansWinFinale} Shout-out to ${topHuman.name} with ${topHuman.score} points!`
      : pack.lukaWinsFinale,
    gesture: humansBeatBot ? 'celebrate' : 'wave',
    mood: humansBeatBot ? 'celebrate' : 'happy',
    seq: (room.lukaSpeech?.seq || 0) + 1,
    at: now,
  };
  room.updatedAt = now;
  room.version += 1;
  return room;
}

export function submitAudienceQuestion(room, { author, text, now = Date.now() }) {
  const cleanText = String(text || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 220);
  if (!cleanText) return null;
  const item = {
    id: `qa_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    author: sanitizeCallsign(author || 'Audience'),
    text: cleanText,
    at: now,
    status: 'pending',
    reply: null,
  };
  room.askQueue.unshift(item);
  room.askQueue = room.askQueue.slice(0, 30);
  room.updatedAt = now;
  room.version += 1;
  return item;
}

export function markAudienceQuestionAnswered(room, qaId, reply, gesture = 'explain', now = Date.now()) {
  const item = room.askQueue.find((q) => q.id === qaId);
  if (item) {
    item.status = 'answered';
    item.reply = String(reply || '').slice(0, 500);
    room.activeQaId = qaId;
  }
  room.lukaSpeech = {
    text: String(reply || ''),
    gesture,
    mood: 'happy',
    seq: (room.lukaSpeech?.seq || 0) + 1,
    at: now,
  };
  room.updatedAt = now;
  room.version += 1;
  return room;
}

export function resetRoom(room, { packId = null, now = Date.now() } = {}) {
  const nextPackId = packId || room.packId;
  const pack = getScenarioPack(nextPackId);
  room.packId = pack.id;
  room.phase = 'lobby';
  room.questionIndex = -1;
  room.questionStartedAt = 0;
  room.questionEndsAt = 0;
  room.answers = {};
  for (const p of Object.values(room.players)) {
    p.score = 0;
    p.streak = 0;
    p.bestStreak = 0;
    p.correctCount = 0;
    p.answeredCount = 0;
  }
  room.lukaSpeech = {
    text: pack.openingLine,
    gesture: pack.openingGesture || 'wave',
    mood: 'happy',
    seq: (room.lukaSpeech?.seq || 0) + 1,
    at: now,
  };
  room.updatedAt = now;
  room.version += 1;
  return room;
}

export function buildLeaderboard(room) {
  return Object.values(room.players)
    .map((p) => ({
      id: p.id,
      name: p.name,
      isBot: Boolean(p.isBot),
      avatar: p.avatar,
      score: p.score || 0,
      streak: p.streak || 0,
      bestStreak: p.bestStreak || 0,
      correctCount: p.correctCount || 0,
      answeredCount: p.answeredCount || 0,
    }))
    .sort((a, b) => b.score - a.score || b.correctCount - a.correctCount || (a.isBot ? 1 : -1));
}

/**
 * Build a safe public projection of the room state.
 * During the active 'question' phase, the correctIndex is strictly withheld so phone clients
 * cannot inspect the answer before the Host triggers Reveal.
 */
export function buildPublicRoomView(room, { playerId = null, now = Date.now() } = {}) {
  const pack = getScenarioPack(room.packId);
  const idx = room.questionIndex;
  const rawQ = idx >= 0 && idx < pack.questions.length ? pack.questions[idx] : null;
  const roundAnswers = idx >= 0 ? (room.answers[idx] || {}) : {};
  const isRevealed = ['reveal', 'leaderboard', 'finale'].includes(room.phase);

  const humanPlayers = Object.values(room.players).filter((p) => !p.isBot);
  const humanAnsweredIds = Object.keys(roundAnswers).filter((id) => id !== LUKA_PLAYER_ID);
  const lukaAns = roundAnswers[LUKA_PLAYER_ID] || null;
  const lukaLockedIn = Boolean(lukaAns && now >= lukaAns.at);

  let voteCounts = null;
  if (rawQ && isRevealed) {
    voteCounts = rawQ.options.map(() => 0);
    for (const [pid, ans] of Object.entries(roundAnswers)) {
      if (pid === LUKA_PLAYER_ID) continue;
      if (ans.optionIndex >= 0 && ans.optionIndex < voteCounts.length) {
        voteCounts[ans.optionIndex] += 1;
      }
    }
  }

  const question = rawQ
    ? {
        id: rawQ.id,
        index: idx,
        total: pack.questions.length,
        category: rawQ.category,
        prompt: rawQ.prompt,
        timeSec: rawQ.timeSec,
        options: rawQ.options,
        ...(isRevealed
          ? {
              correctIndex: rawQ.correctIndex,
              fact: rawQ.fact,
              lukaChoiceIndex: lukaAns?.optionIndex ?? rawQ.correctIndex,
              lukaCorrect: Boolean(lukaAns?.correct),
              voteCounts,
            }
          : {}),
      }
    : null;

  const leaderboard = buildLeaderboard(room);
  const myAnswer = playerId && roundAnswers[playerId]
    ? {
        optionIndex: roundAnswers[playerId].optionIndex,
        ...(isRevealed
          ? {
              correct: Boolean(roundAnswers[playerId].correct),
              points: roundAnswers[playerId].points || 0,
            }
          : {}),
      }
    : null;

  return {
    code: room.code,
    packId: pack.id,
    packName: pack.name,
    packSubtitle: pack.subtitle,
    packBadge: pack.badge,
    qaPrompts: pack.qaPrompts,
    phase: room.phase,
    version: room.version,
    serverNow: now,
    questionIndex: idx,
    totalQuestions: pack.questions.length,
    questionStartedAt: room.questionStartedAt,
    questionEndsAt: room.questionEndsAt,
    question,
    humanCount: humanPlayers.length,
    answeredCount: humanAnsweredIds.length,
    lukaLockedIn,
    lukaScore: room.players[LUKA_PLAYER_ID]?.score || 0,
    leaderboard,
    myAnswer,
    myRank: playerId ? leaderboard.findIndex((p) => p.id === playerId) + 1 : 0,
    askQueue: room.askQueue.slice(0, 16),
    activeQaId: room.activeQaId,
    lukaSpeech: room.lukaSpeech,
  };
}
