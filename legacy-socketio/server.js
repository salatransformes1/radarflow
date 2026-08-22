const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const SM_TOKEN = process.env.SM_TOKEN || 'SalaAgilidade-SM';

const DEFAULT_CARDS = ['1', '2', '3', '5', '8', '13', '21', '?'];
const DEFAULT_HOUR_MAP = {
  '1': '2h', '2': '4h', '3': '8h',
  '5': '16h', '8': '24h', '13': '60h',
  '21': '80h', '?': '?',
};

// Each SM has their own isolated room keyed by roomId (generated on client, stored in localStorage)
const rooms = {};

function ensureRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      participants: {},
      round: { active: false, story: '', revealed: false },
      settings: { cards: [...DEFAULT_CARDS], hourMap: { ...DEFAULT_HOUR_MAP }, squads: [] },
    };
  }
  return rooms[roomId];
}

function broadcastRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const participants = Object.values(room.participants).map((p) => ({
    id: p.id, name: p.name, role: p.role, squad: p.squad || null,
    hasVoted: p.vote !== null,
    vote: room.round.revealed ? p.vote : null,
  }));
  const voters = participants.filter((p) => p.role !== 'master' && p.role !== 'observer');
  const allVoted = voters.length > 0 && voters.every((p) => p.hasVoted);
  io.to(roomId).emit('state_update', { participants, round: room.round, settings: room.settings, allVoted });
}

io.on('connection', (socket) => {
  socket.on('join', ({ name, role, squad, smToken, roomId }) => {
    if (role === 'master') {
      if (smToken !== SM_TOKEN) {
        socket.emit('join_error', 'Token de Scrum Master inválido. Use o link correto.');
        return;
      }
      // SM creates or restores their own room (roomId comes from SM's localStorage)
      const rId = roomId || socket.id;
      const room = ensureRoom(rId);
      socket.myRoomId = rId;
      socket.join(rId);
      room.participants[socket.id] = { id: socket.id, name: name.trim(), role: 'master', squad: null, vote: null };
      socket.emit('sm_ready', { token: SM_TOKEN, roomId: rId });
    } else {
      // Participants must provide a roomId from the SM's shared link
      if (!roomId || !rooms[roomId]) {
        socket.emit('join_error', 'Sala não encontrada. Peça o link correto ao Scrum Master.');
        return;
      }
      socket.myRoomId = roomId;
      socket.join(roomId);
      rooms[roomId].participants[socket.id] = { id: socket.id, name: name.trim(), role, squad: squad || null, vote: null };
    }
    broadcastRoom(socket.myRoomId);
  });

  socket.on('vote', ({ value }) => {
    const room = rooms[socket.myRoomId];
    if (!room) return;
    const p = room.participants[socket.id];
    if (!p || p.role === 'master' || p.role === 'observer') return;
    if (!room.round.active || room.round.revealed) return;
    p.vote = value;
    broadcastRoom(socket.myRoomId);
  });

  socket.on('start_round', ({ story }) => {
    const room = rooms[socket.myRoomId];
    if (!room) return;
    const p = room.participants[socket.id];
    if (!p || p.role !== 'master') return;
    room.round = { active: true, story: story || '', revealed: false };
    Object.values(room.participants).forEach((x) => { x.vote = null; });
    broadcastRoom(socket.myRoomId);
  });

  socket.on('reveal', () => {
    const room = rooms[socket.myRoomId];
    if (!room) return;
    const p = room.participants[socket.id];
    if (!p || p.role !== 'master' || !room.round.active) return;
    room.round.revealed = true;
    broadcastRoom(socket.myRoomId);
  });

  socket.on('reset', () => {
    const room = rooms[socket.myRoomId];
    if (!room) return;
    const p = room.participants[socket.id];
    if (!p || p.role !== 'master') return;
    room.round = { active: false, story: '', revealed: false };
    Object.values(room.participants).forEach((x) => { x.vote = null; });
    broadcastRoom(socket.myRoomId);
  });

  socket.on('update_settings', ({ cards, hourMap, squads }) => {
    const room = rooms[socket.myRoomId];
    if (!room) return;
    const p = room.participants[socket.id];
    if (!p || p.role !== 'master') return;
    room.settings = { cards, hourMap, squads: squads || [] };
    Object.values(room.participants).forEach((x) => { x.vote = null; });
    broadcastRoom(socket.myRoomId);
  });

  socket.on('kick', ({ targetId }) => {
    const room = rooms[socket.myRoomId];
    if (!room) return;
    const p = room.participants[socket.id];
    if (!p || p.role !== 'master') return;
    if (room.participants[targetId]) {
      io.to(targetId).emit('force_logout');
      delete room.participants[targetId];
      broadcastRoom(socket.myRoomId);
    }
  });

  socket.on('disconnect', () => {
    const rId = socket.myRoomId;
    if (!rId || !rooms[rId]) return;
    delete rooms[rId].participants[socket.id];
    broadcastRoom(rId);

    // Schedule cleanup of empty rooms to prevent memory leaks.
    // The 30-minute delay allows reconnections without losing room state.
    if (Object.keys(rooms[rId].participants).length === 0) {
      setTimeout(() => {
        if (rooms[rId] && Object.keys(rooms[rId].participants).length === 0) {
          delete rooms[rId];
        }
      }, 30 * 60 * 1000);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor: http://localhost:${PORT}`);
  console.log(`SM URL:   http://localhost:${PORT}?sm=${SM_TOKEN}`);
});
