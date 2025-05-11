const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);

// Inicializa Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://partyview-8ba30-default-rtdb.europe-west1.firebasedatabase.app/"
});
const db = admin.database();

// Store de salas en memoria
const rooms = new Map();

const port = process.env.PORT || 8080; 
const wss = new WebSocket.Server({ port });

wss.on('connection', (socket) => {
  console.log('Un cliente se ha conectado');
  socket.id = uuidv4();
  let currentRoomId = null;
  let currentUid = null;

  // Enviar mensaje de confirmación al cliente
  socket.send(JSON.stringify({ type: 'connected', message: 'Conexión establecida con el servidor' }));

  socket.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      console.error('JSON inválido', e);
      return;
    }
    const { type, payload } = data;

    // Verifica que venga token
    if (!payload?.token) {
      socket.send(JSON.stringify({ type: 'error', message: 'Token requerido' }));
      return socket.close();
    }

    // Verificar ID token con Firebase Admin
    admin.auth().verifyIdToken(payload.token)
      .then(decoded => {
        currentUid = decoded.uid;
        // Propaga roomId (o id)
        currentRoomId = payload.roomId || payload.id || currentRoomId;

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
          default:
            socket.send(JSON.stringify({ type: 'error', message: 'Tipo inválido' }));
        }
      })
      .catch(err => {
        console.error('Token inválido', err);
        socket.send(JSON.stringify({ type: 'error', message: 'Token inválido' }));
        socket.close();
      });
  });

  socket.on('close', () => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;

    const room = rooms.get(currentRoomId);
    // Si el host se desconecta
    if (room.anfitrion.uid === currentUid) {
      room.invitados.forEach(({ socket: s }) => s.close());
      rooms.delete(currentRoomId);
      db.ref(`salas/${currentRoomId}`).remove();
      console.log(`Sala ${currentRoomId} eliminada (host desconectado)`);
    } else {
      // Invitado se fue
      room.invitados.delete(currentUid);
      db.ref(`salas/${currentRoomId}/invitados/${currentUid}`).remove();
      console.log(`Invitado ${currentUid} salió de sala ${currentRoomId}`);
    }
  });
});

// --- Handlers ---

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

  // Guardar la sala en Firebase (sin token)
  const anfitrionSinToken = { ...anfitrion };
  delete anfitrionSinToken.token;

  db.ref(`salas/${id}`).set({
    id,
    estado,
    capacidad,
    video,
    anfitrion: anfitrionSinToken,
    invitados: {},
    bloqueados: {}
  });

  console.log(`Sala ${id} creada y guardada en Firebase`);
}

function handleJoinRoom(data, socket) {
  const { roomId, id, persona } = data;
  const rid = roomId || id;
  const room = rooms.get(rid);

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

  // Guardar el invitado en Firebase sin token
  const personaSinToken = { ...persona };
  delete personaSinToken.token;
  db.ref(`salas/${rid}/invitados/${persona.uid}`).set(personaSinToken);

  // Notificar al anfitrión
  room.anfitrionSocket.send(JSON.stringify({
    type: 'invitado-join',
    payload: persona,
  }));

  console.log(`${persona.nombre} se unió a sala ${rid}`);
}

function handleSignal(data) {
  const { roomId, from, to, signalData } = data;
  const room = rooms.get(roomId);
  if (!room) return;

  const targetSocket =
    room.anfitrion.uid === to
      ? room.anfitrionSocket
      : room.invitados.get(to)?.socket;

  if (targetSocket) {
    targetSocket.send(JSON.stringify({
      type: 'signal',
      payload: { from, signalData }
    }));
  }
}

function handleKick(data) {
  const { roomId, uid } = data;
  const room = rooms.get(roomId);
  if (!room) return;

  const guest = room.invitados.get(uid);
  if (guest) {
    guest.socket.close();
    room.invitados.delete(uid);
    db.ref(`salas/${roomId}/invitados/${uid}`).remove();
    console.log(`Invitado ${uid} expulsado de sala ${roomId}`);
  }
}

function handleBlock(data) {
  const { roomId, uid } = data;
  const room = rooms.get(roomId);
  if (!room) return;

  room.bloqueados.add(uid);
  db.ref(`salas/${roomId}/bloqueados/${uid}`).set(true);
  // También expulsar si está dentro
  handleKick({ roomId, uid });
  console.log(`Usuario ${uid} bloqueado en sala ${roomId}`);
}

function handleLeaveRoom(data) {
  const { roomId, uid } = data;
  const room = rooms.get(roomId);
  if (!room) return;

  room.invitados.delete(uid);
  db.ref(`salas/${roomId}/invitados/${uid}`).remove();
  console.log(`Invitado ${uid} salió voluntariamente de sala ${roomId}`);
}
