/*
 * Servidor de gestión de salas de videollamadas (PartyView)
 * ---------------------------------------------------------
 * Autor: Jorge (TFG)
 * Fecha: 2025-05-25
 *
 * Descripción general:
 * Este servidor Node.js permite la gestión de salas de videollamadas en tiempo real usando WebSocket y Firebase Realtime Database.
 * Los usuarios pueden crear salas, unirse, abandonar, expulsar, bloquear, y recibir notificaciones en tiempo real sobre los eventos de la sala.
 * El servidor asegura la persistencia de las salas y la limpieza automática de salas vacías.
 *
 * Funcionalidades principales:
 * - Crear, unirse y abandonar salas de videollamada.
 * - Expulsar y bloquear invitados.
 * - Notificaciones en tiempo real a anfitrión e invitados (unión, salida, expulsión, bloqueo, cierre de sala).
 * - Gestión de capacidad y estado de la sala.
 * - Persistencia de datos en Firebase y limpieza de salas vacías al iniciar.
 * - Mensajes enriquecidos con emojis para mejor experiencia de usuario.
 *
 * Estructura y flujo principal:
 * 1. Inicialización de Firebase y WebSocket Server.
 * 2. Limpieza de salas vacías en Firebase al arrancar.
 * 3. Gestión de conexiones WebSocket: cada cliente se identifica y puede enviar mensajes de distintos tipos (crear, unirse, abandonar, etc.).
 * 4. Handlers para cada tipo de evento, con notificaciones a los sockets implicados y actualización en Firebase.
 * 5. Limpieza y cierre de salas e invitados tanto en memoria como en Firebase.
 *
 * Glosario de variables clave:
 * - sala: Map local que almacena las salas activas en memoria.
 * - salaId: Identificador único de la sala (string).
 * - room: Instancia de sala en memoria (objeto con anfitrión, invitados, etc.).
 * - anfitrion: Objeto usuario anfitrión de la sala.
 * - invitados: Map de invitados activos en la sala.
 * - bloqueados: Set de uids bloqueados en la sala.
 * - currentRoomId/currentUid: Variables de contexto por socket para saber a qué sala/usuario pertenece la conexión.
 *
 * Notas de despliegue y uso:
 * - Para conectar desde móvil, usar la IP local del servidor y el puerto configurado.
 * - El archivo clave-firebase.json debe contener las credenciales de Firebase y estar en la raíz del proyecto.
 * - El servidor puede desplegarse en plataformas como Railway, Render o Glitch (ver README para detalles y advertencias de seguridad).
 *
 * Seguridad:
 * - No exponer clave-firebase.json en repositorios públicos.
 * - Considerar autenticación y validación de usuarios en producción.
 *
 * Contacto y soporte:
 * - Para dudas o mejoras, contactar con el autor del TFG.
 */

// -----------------------------------------------------------------------------
// server.js
// Servidor de videollamadas con WebSocket y Firebase para gestión de salas
// -----------------------------------------------------------------------------
//
// Este archivo implementa un servidor Node.js que permite la creación y gestión
// de salas de videollamadas en tiempo real, usando WebSocket para la comunicación
// bidireccional con los clientes y Firebase Realtime Database para persistencia.
//
// FUNCIONALIDAD PRINCIPAL:
// - Crear, unir, abandonar, expulsar y bloquear usuarios en salas de videollamada.
// - Notificaciones en tiempo real a anfitrión e invitados sobre eventos relevantes.
// - Limpieza automática de salas vacías al iniciar el servidor.
// - Sincronización de estado de salas e invitados con Firebase.
//
// ESTRUCTURA PRINCIPAL:
// - Módulos requeridos: WebSocket, uuid, firebase-admin, serviceAccount.
// - Inicialización de Firebase y WebSocket Server.
// - Mapa en memoria 'sala' para gestión rápida de salas activas.
// - Handlers para cada tipo de evento recibido por WebSocket.
//
// FLUJO GENERAL:
// 1. Al iniciar, limpia salas vacías en Firebase.
// 2. Escucha conexiones WebSocket entrantes.
// 3. Gestiona eventos: crear sala, unirse, abandonar, expulsar, bloquear, etc.
// 4. Sincroniza cambios en tiempo real con Firebase y notifica a los clientes.
//
// GLOSARIO DE VARIABLES CLAVE:
// - sala: Map<string, Sala>  // Mapa de salas activas en memoria
// - salaId: string           // Identificador único de la sala
// - anfitrion: {uid, ...}    // Objeto usuario anfitrión
// - invitados: Map<uid, {persona, socket}> // Invitados conectados
// - bloqueados: Set<uid>     // UIDs bloqueados en la sala
// - currentRoomId, currentUid: variables de sesión por socket
//
// NOTA:
// - El archivo clave-firebase.json debe contener las credenciales de Firebase.
// - Para conectar desde móvil, usar la IP local del servidor.
//
// -----------------------------------------------------------------------------

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

/**
 * Elimina todas las salas vacías de Firebase al iniciar el servidor.
 * Una sala se considera vacía si no tiene invitados y el anfitrión no está presente.
 */
function limpiarSalasVacias() {
  db.ref('Salas').once('value', (snapshot) => {
    const salas = snapshot.val();
    if (!salas) return;
    Object.entries(salas).forEach(([salaId, salaData]) => {
      const invitados = salaData.invitados || {};
      // Si no hay invitados y el anfitrión no está presente 
      if (!invitados || Object.keys(invitados).length === 0) {
        db.ref(`Salas/${salaId}`).remove();
        console.log(`🧹 Sala vacía eliminada al iniciar: ${salaId}`);
      }
    });
  });
}

limpiarSalasVacias();

const sala = new Map();

const port = process.env.PORT || 8080; 
const wss = new WebSocket.Server({ port });

/**
 * Handler principal de conexión WebSocket.
 * Asigna un id único al socket y gestiona los eventos recibidos.
 * Envía confirmación de conexión y delega en handlers según el tipo de mensaje.
 */
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
        handleCrearSala(contenido, socket);
        break;
      case "unirse-sala":
        handleUnirseSala(contenido, socket);
        break;
      case "subir-capacidad":
        handleCambiarCapacidad(contenido, 1);
        break;
      case "bajar-capacidad":
        handleCambiarCapacidad(contenido, -1);
        break;
      case "cambiar-estado":
        handleCambiarEstado(contenido);
        break;
      case "signal":
        handleSignal(contenido);
        break;
      case "expulsar-invitado":
        handleExpulsar(contenido);
        break;
      case "bloquear-invitado":
        handleBloquear(contenido);
        break;
      case "videoON":{
        handleVideoON(contenido);
        break;
      }
      case "abandonar-sala":
        handleSalirSala(contenido);
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

/**
 * Crea una nueva sala y la guarda en memoria y en Firebase.
 * Notifica al anfitrión la creación exitosa.
 * @param {Object} data - Datos de la sala y anfitrión
 * @param {WebSocket} socket - Socket del anfitrión
 */
function handleCrearSala(data, socket) {
  const { id: salaId, estado, capacidad, video, anfitrion } = data;

  if (sala.has(salaId)) {
    socket.send(JSON.stringify({ type: "error", message: "Sala ya existe" }));
    return;
  }

  sala.set(salaId, {
    estado,
    capacidad,
    video: false,
    anfitrion,
    anfitrionSocket: socket,
    invitados: new Map(),
    bloqueados: new Set(),
  });

  currentUid = anfitrion.uid;
  currentRoomId = salaId;

  // Guardar la sala en Firebase (sin token)
  const anfitrionSinToken = { ...anfitrion };
  delete anfitrionSinToken.token;

  db.ref(`Salas/${salaId}`).set({
    id: salaId,
    estado,
    capacidad,
    video: false,
    anfitrion: anfitrionSinToken,
    invitados: {},
    bloqueados: {}
  });

  socket.send(JSON.stringify({
    type: "sala-creada",
    message: `La sala ${salaId} ha sido creada exitosamente.`,
    id: salaId
  }));

  console.log(`Sala #${salaId} creada y guardada en Firebase`);
}

/**
 * Permite a un invitado unirse a una sala existente.
 * Notifica al anfitrión, al propio invitado y al resto de invitados.
 * @param {Object} data - Datos de la sala e invitado
 * @param {WebSocket} socket - Socket del invitado
 */
function handleUnirseSala(data, socket) {
  const { "id-sala": salaId, persona } = data;
  const room = sala.get(salaId);

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

/**
 * Reenvía señales WebRTC entre usuarios de la sala (anfitrión/invitados).
 * @param {Object} data - Datos de señalización (salaId, from, to, signalData)
 */
function handleSignal(data) {
  const { salaId, from, to, signalData } = data;
  const room = sala.get(salaId);
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

/**
 * Expulsa a un invitado de la sala, notificando a todos los implicados.
 * Elimina al invitado de memoria y de Firebase.
 * @param {Object} data - salaId y uid del invitado a expulsar
 */
function handleExpulsar(data) {
  const { salaId, uid } = data;
  const room = sala.get(salaId);
  if (!room) return;

  const invitado = room.invitados.get(uid);
  if (invitado) {
    // Notificar a todos los invitados (excepto el expulsado)
    for (const [invitadoUid, { socket: invitadoSocket }] of room.invitados.entries()) {
      if (invitadoUid !== uid) {
        invitadoSocket.send(JSON.stringify({
          type: "invitado-expulsado-bloqueado",
          uidExpulsado: uid,
          message: "Se ha expulsado a un invitado de la sala"
        }));
      }
    }

    // Notificar al expulsado
    invitado.socket.send(JSON.stringify({
      type: "expulsado",
      message: "Has sido expulsado de la sala. ¡Adiós!"
    }));

    // Cerrar socket del expulsado y limpiar
    invitado.socket.close();
    room.invitados.delete(uid);
    db.ref(`Salas/${salaId}/invitados/${uid}`).remove();
    console.log(`Invitado ${uid} expulsado de sala ${salaId}`);
  }
}

/**
 * Bloquea a un usuario en la sala (añade a bloqueados y lo expulsa si está dentro).
 * @param {Object} data - salaId y uid del usuario a bloquear
 */
function handleBloquear(data) {
  const { salaId, uid } = data;
  const room = sala.get(salaId);
  if (!room) return;

  room.bloqueados.add(uid);
  db.ref(`Salas/${salaId}/bloqueados/${uid}`).set(true);
  // También expulsar si está dentro
  handleExpulsar({ salaId, uid });
  console.log(`⛔ Usuario ${uid} bloqueado en sala ${salaId}`);
}

/**
 * Permite a un usuario (anfitrión o invitado) abandonar la sala.
 * Si es el anfitrión, cierra la sala y notifica a todos.
 * Si es invitado, notifica a anfitrión y resto de invitados.
 * @param {Object} data - salaId y uid del usuario que abandona
 */
function handleSalirSala(data) {
  const { salaId, uid } = data;
  const room = sala.get(salaId);
  if (!room) return;

  // Si el que abandona es el anfitrión
  if (room.anfitrion.uid === uid) {
    // Notificar y cerrar la conexión de todos los invitados
    for (const { socket: invitadoSocket } of room.invitados.values()) {
      invitadoSocket.send(JSON.stringify({
        type: "salio-anfitrion",
        message: "👑 El anfitrión ha abandonado la sala. La sala se ha cerrado."
      }));
      invitadoSocket.close();
    }
    // Eliminar la sala y de Firebase
    sala.delete(salaId);
    db.ref(`Salas/${salaId}`).remove();
    console.log(`👑 El anfitrión ${uid} abandonó y la sala ${salaId} fue eliminada`);
    return;
  }

  // Si es un invitado el que abandona
  const invitado = room.invitados.get(uid);
  if (invitado) {
    invitado.socket.send(JSON.stringify({
      type: "saliste-sala",
      message: "🚪 Has abandonado la sala. ¡Hasta pronto!"
    }));
    invitado.socket.close();
  }

  // Notificar al anfitrión que un invitado ha salido
  room.anfitrionSocket.send(JSON.stringify({
    type: "invitado-salio",
    uid: uid,
    message: "👤 Un invitado ha abandonado la sala."
  }));

  // Notificar a los demas invitados q este invitado ha salido
  for (const [invitadoUid, { socket: invitadoSocket }] of room.invitados.entries()) {
    if (invitadoUid !== uid) {
      invitadoSocket.send(JSON.stringify({
        type: "invitado-salio",
        uid: uid,
        message: "👤 Un invitado ha abandonado la sala."
      }));
    }
  }

  room.invitados.delete(uid);
  db.ref(`Salas/${salaId}/invitados/${uid}`).remove();
  console.log(`🚪 Invitado ${uid} salió voluntariamente de sala ${salaId}`);
}

/**
 * Cambia la capacidad máxima de la sala (aumenta o disminuye).
 * Notifica a todos los invitados la actualización.
 * @param {Object} data - salaId
 * @param {number} delta - Incremento (+1) o decremento (-1)
 */
function handleCambiarCapacidad(data, delta) {
  const salaId = data["salaId"];
  const room = sala.get(salaId);
  if (!room) return;

  room.capacidad = Math.max(1, room.capacidad + delta); // No menos de 1
  db.ref(`Salas/${salaId}/capacidad`).set(room.capacidad);

  notifyRoomUpdate(room, salaId);
}

/**
 * Cambia el estado de la sala (por ejemplo, abierta/cerrada).
 * Notifica a todos los invitados la actualización.
 * @param {Object} data - salaId y nuevo estado
 */
function handleCambiarEstado(data) {
  const salaId = data["salaId"];
  const nuevoEstado = data["estado"];
  const room = sala.get(salaId);
  if (!room) return;

  room.estado = nuevoEstado;
  db.ref(`Salas/${salaId}/estado`).set(nuevoEstado);

  notifyRoomUpdate(room, salaId);
}

/**
 * Notifica a todos los invitados de la sala que ha habido una actualización.
 * @param {Object} room - Instancia de la sala
 * @param {string} salaId - Identificador de la sala
 */
function notifyRoomUpdate(room, salaId) {
  for (const { socket: invitadoSocket } of room.invitados.values()) {
    invitadoSocket.send(JSON.stringify({
      type: "actualizacion-sala",
    }));
  }
}

/**
 * Marca el inicio de la sala (video ON) y notifica a todos los invitados.
 * @param {Object} data - salaId
 */
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
}