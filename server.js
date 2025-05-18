const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');
const serviceAccount = require('./clave-firebase.json');

// Inicializa Firebase Admin
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://partyview-8ba30-default-rtdb.europe-west1.firebasedatabase.app/"
  });
  console.log("Firebase inicializado correctamente");
} catch (error) {
  console.error("Error al inicializar Firebase:", error);
}
const db = admin.database();

// Store de Salas en memoria
const sala = new Map();

const port = process.env.PORT || 8081; 
const wss = new WebSocket.Server({ port });

wss.on('connection', (socket) => {
  console.log('Un cliente se ha conectado');
  socket.id = uuidv4();
  let currentRoomId = null;
  let currentUid = null;

  // Enviar mensaje de confirmación al cliente
  socket.send(JSON.stringify({ type: "conexion", message: "Conexión establecida con el servidor" }));

  socket.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      console.error('JSON inválido', e);
      return;
    }

    const { type, payload: contenido } = data;
    currentRoomId = contenido.roomId || contenido.id || currentRoomId;

    switch (type) {
      case "crear-sala":
        handleCreateRoom(contenido, socket);
        break;
      case "unirse-sala":
        handleJoinRoom(contenido, socket);
        break;
      case "subir-capacidad":
        handleChangeCapacity(contenido, 1);
        break;
      case "bajar-capacidad":
        handleChangeCapacity(contenido, -1);
        break;
      case "cambiar-estado":
        handleChangeEstado(contenido);
        break;
      case "iniciar-video":
        break;
      case 'signal':
        handleSignal(contenido);
        break;
      case "expulsar-invitado":
        handleKick(contenido);
        break;
      case "bloquear-invitado":
        handleBlock(contenido);
        break;
      
      case "videoON":{
        handleVideoON(contenido);
        break;
      }
      case "abandonar-sala":
        handleLeaveRoom(contenido);
        break;
      default:
        socket.send(JSON.stringify({ type: 'error', message: 'Tipo inválido' }));
    }
  });

  socket.on("close", () => {
    if (!currentRoomId || !sala.has(currentRoomId)) return;

    const room = sala.get(currentRoomId);
    // Si el host se desconecta
    if (room.anfitrion.uid === currentUid) {
      room.invitados.forEach(({ socket: s }) => s.close());
      sala.delete(currentRoomId);
      db.ref(`Salas/${currentRoomId}`).remove();
      console.log(`Sala ${currentRoomId} eliminada (host desconectado)`);
    } else {
      // Invitado se fue
      room.invitados.delete(currentUid);
      db.ref(`Salas/${currentRoomId}/invitados/${currentUid}`).remove();
      console.log(`Invitado ${currentUid} salió de sala ${currentRoomId}`);
    }
  });
});

// --- Handlers ---

function handleCreateRoom(data, socket) {
  const { id, estado, capacidad, video, anfitrion } = data;

  if (sala.has(id)) {
    socket.send(JSON.stringify({ type: "error", message: "Sala ya existe" }));
    return;
  }

  sala.set(id, {
    estado,
    capacidad,
    video: false,
    anfitrion,
    anfitrionSocket: socket,
    invitados: new Map(),
    bloqueados: new Set(),
  });

  currentUid = anfitrion.uid; // Asignar el UID del anfitrión
  currentRoomId = id; // Asignar el ID de la sala al anfitrión

  // Guardar la sala en Firebase (sin token)
  const anfitrionSinToken = { ...anfitrion };
  delete anfitrionSinToken.token;

  db.ref(`Salas/${id}`).set({
    id,
    estado,
    capacidad,
    video,
    anfitrion: anfitrionSinToken,
    invitados: {},
    bloqueados: {}
  });


  socket.send(JSON.stringify({
    type: "sala-creada",
    message: `La sala ${id} ha sido creada exitosamente.`,
    id: id
  }));

  console.log(`Sala #${id} creada y guardada en Firebase`);
}

function handleJoinRoom(data, socket) {
  const { "id-sala": salaId, "persona": persona } = data;
  const room = sala.get(salaId); // Corregido: usar el Map global 'sala'

  if (!room) {
    socket.send(JSON.stringify({ type: "error", message: "Sala no existe" })); 
    return;
  }
  if (room.bloqueados.has(persona.uid)) {
    socket.send(JSON.stringify({ type: "error", message: "Usuario bloqueado" })); 
    return;
  }
  if (room.invitados.size >= room.capacidad) {
    socket.send(JSON.stringify({ type: "error", message: "Sala llena" }));
    return;
  }

  room.invitados.set(persona.uid, { persona, socket });

  // Guardar el invitado en Firebase sin token
  const personaSinToken = { ...persona };
  delete personaSinToken.token;
  db.ref(`Salas/${salaId}/invitados/${persona.uid}`).set(personaSinToken);

  // Notificar al anfitrión
  room.anfitrionSocket.send(JSON.stringify({
    type: "invitado-unido",
    contenido: persona,
  }));

  // Notificar al propio invitado
  socket.send(JSON.stringify({
    type: "unido-correctamente",
    message: `Te has unido correctamente a la sala ${salaId}`,
    salaId: salaId
  }));

  // Notificar a todos los invitados de la sala (excluyendo el nuevo)
  for (const [uid, { socket: invitadoSocket }] of room.invitados.entries()) {
    if (uid !== persona.uid) {
      invitadoSocket.send(JSON.stringify({
        type: "invitado-unido",
        contenido: persona,
      }));
    }
  }


  console.log(`${persona.nombre} se unió a sala ${salaId}`);
}

function handleSignal(data) {
  const { roomId, from, to, signalData } = data;
  const room = sala.get(roomId);
  if (!room) return;

  const targetSocket =
    room.anfitrion.uid === to
      ? room.anfitrionSocket
      : room.invitados.get(to)?.socket;

  if (targetSocket) {
    targetSocket.send(JSON.stringify({
      type: 'signal',
      contenido: { from, signalData }
    }));
  }
}

function handleKick(data) {
  const { salaId, uid } = data;
  const room = sala.get(salaId);
  if (!room) return;

  const guest = room.invitados.get(uid);
  if (guest) {
    // Notificar a todos los invitados (excepto el expulsado) y al anfitrión
    for (const [invitadoUid, { socket: invitadoSocket }] of room.invitados.entries()) {
      if (invitadoUid !== uid) {
        invitadoSocket.send(JSON.stringify({
          type: "invitado-expulsado-bloqueado",
          uidExpulsado: uid,
          message: "Se ha expulsado a un invitado de la sala"
        }));
      }
    }
    room.anfitrionSocket.send(JSON.stringify({
      type: "invitado-expulsado",
      uidExpulsado: uid,
      message: "Se ha expulsado a un invitado de la sala"
    }));

    // Notificar al expulsado
    guest.socket.send(JSON.stringify({
      type: "expulsado",
      message: "Has sido expulsado de la sala. ¡Adiós!"
    }));

    // Cerrar socket del expulsado y limpiar
    guest.socket.close();
    room.invitados.delete(uid);
    db.ref(`Salas/${salaId}/invitados/${uid}`).remove();
    console.log(`Invitado ${uid} expulsado de sala ${salaId}`);
  }
}

function handleBlock(data) {
  const { salaId, uid } = data;
  const room = sala.get(salaId);
  if (!room) return;

  room.bloqueados.add(uid);
  db.ref(`Salas/${salaId}/bloqueados/${uid}`).set(true);
  // También expulsar si está dentro
  handleKick({ salaId, uid });
  console.log(`Usuario ${uid} bloqueado en sala ${salaId}`);
}

function handleLeaveRoom(data) {
  const { salaId, uid } = data;
  const room = sala.get(salaId);
  if (!room) return;

  // Si el que abandona es el anfitrión
  if (room.anfitrion.uid === uid) {
    // Notificar y cerrar la conexión de todos los invitados
    for (const { socket: invitadoSocket } of room.invitados.values()) {
      invitadoSocket.send(JSON.stringify({
        type: "salio-anfitrion",
        message: "El anfitrión ha abandonado la sala."
      }));
      invitadoSocket.close();
    }
    // Eliminar la sala y de Firebase
    sala.delete(salaId);
    db.ref(`Salas/${salaId}`).remove();
    console.log(`El anfitrión ${uid} abandonó y la sala ${salaId} fue eliminada`);
    return;
  }

  // Si es un invitado el que abandona
  const invitado = room.invitados.get(uid);
  if (invitado) {
    invitado.socket.send(JSON.stringify({
      type: "saliste-sala",
      message: "Has abandonado la sala."
    }));
    invitado.socket.close();
  }

  // Notificar al anfitrión que un invitado ha salido
  room.anfitrionSocket.send(JSON.stringify({
    type: "invitado-salio",
    uid: uid,
    message: "Un invitado ha abandonado la sala."
  }));

  // Notificar a los demás invitados que este invitado ha salido
  for (const [invitadoUid, { socket: invitadoSocket }] of room.invitados.entries()) {
    if (invitadoUid !== uid) {
      invitadoSocket.send(JSON.stringify({
        type: "invitado-salio",
        uid: uid,
        message: "Un invitado ha abandonado la sala."
      }));
    }
  }

  room.invitados.delete(uid);
  db.ref(`Salas/${salaId}/invitados/${uid}`).remove();
  console.log(`Invitado ${uid} salió voluntariamente de sala ${salaId}`);
}

function handleChangeCapacity(data, delta) {
  const salaId = data["salaId"];
  const sala = sala.get(salaId);
  if (!sala) return;

  sala.capacidad = Math.max(1, sala.capacidad + delta); // No menos de 1
  db.ref(`Salas/${salaId}/capacidad`).set(sala.capacidad);

  notifyRoomUpdate(sala, salaId);
}

function handleChangeEstado(data) {
  const salaId = data["salaId"];
  const nuevoEstado = data["estado"];
  const room = sala.get(salaId);
  if (!room) return;

  room.estado = nuevoEstado;
  db.ref(`Salas/${salaId}/estado`).set(nuevoEstado);

  notifyRoomUpdate(room, salaId);
}

function notifyRoomUpdate(room, salaId) {
  // // Notifica a anfitrión
  // room.anfitrionSocket.send(JSON.stringify({
  //   type: "actualizacion-sala",
  //   contenido: salaActualizada,
  // }));

  // Notifica a todos los invitados
  for (const { socket: invitadoSocket } of room.invitados.values()) {
    invitadoSocket.send(JSON.stringify({
      type: "actualizacion-sala",
    }));
  }
}

function handleVideoON(data) {
  const { salaId } = data;
  const room = sala.get(salaId);
  if (!room) return;

  // Cambiar el estado de video a false
  room.video = false;
  db.ref(`Salas/${salaId}/video`).set(false);

  // Notificar a todos los invitados
  for (const { socket: invitadoSocket } of room.invitados.values()) {
    invitadoSocket.send(JSON.stringify({
      type: "videoON",
      message: "El anfitrión ha iniciado la sala."
    }));
  }
  // Notificar al anfitrión 
  room.anfitrionSocket.send(JSON.stringify({
    type: "videoON",
    message: "Has iniciado la sala."
  }));
}