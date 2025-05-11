const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const wss = new WebSocket.Server({ port: 8080 });

const rooms = new Map(); // roomId -> roomData

wss.on('connection', (socket) => {
  socket.id = uuidv4();
  let currentRoomId = null;
  let currentUid = null;

  socket.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const { type, payload } = data;

      switch (type) {
        case 'create-room':
          handleCreateRoom(payload, socket);
          break;
        case 'join-room':
          handleJoinRoom(payload, socket);
          break;
        case 'signal':
          handleSignal(payload);
          break;
        case 'kick':
          handleKick(payload);
          break;
        case 'block':
          handleBlock(payload);
          break;
        case 'leave-room':
          handleLeaveRoom(payload);
          break;
      }

      // Guardamos ID para tracking posterior
      if (payload?.uid) currentUid = payload.uid;
      if (payload?.id) currentRoomId = payload.id;

    } catch (err) {
      console.error('Mensaje inválido:', err);
    }
  });

  socket.on('close', () => {
    if (currentRoomId && currentUid) {
      const room = rooms.get(currentRoomId);
      if (!room) return;

      if (room.anfitrion.uid === currentUid) {
        // Anfitrión se fue: cerrar sala
        room.invitados.forEach(({ socket: s }) => s.close());
        rooms.delete(currentRoomId);
        console.log(`Sala ${currentRoomId} eliminada (anfitrión se fue)`);
      } else {
        room.invitados.delete(currentUid);
        console.log(`Invitado ${currentUid} salió de sala ${currentRoomId}`);
      }
    }
  });
});

// ------------------------
// Funciones de manejo
// ------------------------

function handleCreateRoom(data, socket) {
  const { id, estado, capacidad, video, anfitrion } = data;

  if (rooms.has(id)) {
    socket.send(JSON.stringify({ type: 'error', message: 'Sala ya existe' }));
    return;
  }

  rooms.set(id, {
    estado,
    capacidad,
    video,
    anfitrion,
    anfitrionSocket: socket,
    invitados: new Map(),
    bloqueados: new Set(),
  });

  console.log(`Sala creada: ${id}`);
}

function handleJoinRoom(data, socket) {
  const { id, persona } = data;

  const room = rooms.get(id);
  if (!room) {
    socket.send(JSON.stringify({ type: 'error', message: 'Sala no existe' }));
    return;
  }

  if (room.bloqueados.has(persona.uid)) {
    socket.send(JSON.stringify({ type: 'error', message: 'Estás bloqueado' }));
    return;
  }

  if (room.invitados.size >= room.capacidad) {
    socket.send(JSON.stringify({ type: 'error', message: 'Sala llena' }));
    return;
  }

  room.invitados.set(persona.uid, { persona, socket });

  // Notificar al anfitrión
  room.anfitrionSocket.send(JSON.stringify({
    type: 'invitado-join',
    payload: persona,
  }));

  console.log(`${persona.nombre} se unió a la sala ${id}`);
}

function handleSignal({ roomId, from, to, data }) {
  const room = rooms.get(roomId);
  if (!room) return;

  const target =
    room.anfitrion.uid === to
      ? room.anfitrionSocket
      : room.invitados.get(to)?.socket;

  if (target) {
    target.send(JSON.stringify({
      type: 'signal',
      payload: { from, data },
    }));
  }
}

function handleKick({ roomId, uid }) {
  const room = rooms.get(roomId);
  const guest = room?.invitados.get(uid);
  if (guest) {
    guest.socket.close();
    room.invitados.delete(uid);
  }
}

function handleBlock({ roomId, uid }) {
  const room = rooms.get(roomId);
  if (room) {
    room.bloqueados.add(uid);
    handleKick({ roomId, uid });
  }
}

function handleLeaveRoom({ roomId, uid }) {
  const room = rooms.get(roomId);
  room?.invitados.delete(uid);
}
