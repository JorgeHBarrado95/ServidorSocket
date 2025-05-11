const admin = require('firebase-admin');
const serviceAccount = require('./clave-firebase.json'); // tu archivo de clave privada

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://TU_PROJECTO.firebaseio.com' // tu URL de base de datos
});

wss.on('connection', (socket) => {
  socket.id = uuidv4();
  let currentRoomId = null;
  let currentUid = null;

  socket.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const { type, payload } = data;

      // Verificación del token antes de cualquier operación
      if (payload?.token) {
        // Verificar el ID token con Firebase Admin SDK
        admin.auth().verifyIdToken(payload.token)
          .then(decodedToken => {
            // El token es válido y ahora puedes obtener los datos del usuario
            const uid = decodedToken.uid;
            console.log('Token válido, UID del usuario:', uid);
            currentUid = uid;

            // Ahora procesa el resto de la solicitud
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

          })
          .catch(error => {
            console.error('Token inválido:', error);
            socket.send(JSON.stringify({ type: 'error', message: 'Token inválido' }));
            socket.close();
          });
      } else {
        socket.send(JSON.stringify({ type: 'error', message: 'Token requerido' }));
        socket.close();
      }

    } catch (err) {
      console.error('Mensaje inválido:', err);
    }
  });

  socket.on('close', () => {
    // Lógica para desconexión
  });
});

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

  // Guardar la sala en Firebase
  const anfitrionSinToken = { ...anfitrion };
  delete anfitrionSinToken.token; // Eliminar el token antes de guardarlo en Firebase

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

  // Guardar el invitado en Firebase sin el token
  const personaSinToken = { ...persona };
  delete personaSinToken.token;

  db.ref(`salas/${id}/invitados/${persona.uid}`).set(personaSinToken);

  room.anfitrionSocket.send(JSON.stringify({
    type: 'invitado-join',
    payload: persona,
  }));

  console.log(`${persona.nombre} se unió a sala ${id}`);
}

function handleBlock(data) {
  const { roomId, uid } = data;

  const room = rooms.get(roomId);
  if (!room) return;

  // Agregar a la lista de bloqueados
  room.bloqueados.add(uid);

  // Guardar el bloqueado en Firebase
  db.ref(`salas/${roomId}/bloqueados/${uid}`).set(true);

  console.log(`Usuario ${uid} bloqueado en sala ${roomId}`);
}

if (room.anfitrion.uid === currentUid) {
  // El anfitrión se fue: cerrar sala
  room.invitados.forEach(({ socket: s }) => s.close());
  rooms.delete(currentRoomId);

  // Eliminar la sala de Firebase
  db.ref(`salas/${currentRoomId}`).remove();

  console.log(`Sala ${currentRoomId} eliminada (anfitrión se fue)`);
}
