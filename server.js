const WebSocket = require('ws');
const port = process.env.PORT || 8080;  // Usar el puerto proporcionado por Render
const wss = new WebSocket.Server({ port });

wss.on('connection', (ws) => {
  console.log('Cliente conectado');

  ws.on('message', (message) => {
    console.log('Mensaje recibido:', message);

    // Reenviar el mensaje a todos los clientes conectados
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  });

  ws.on('close', () => {
    console.log('Cliente desconectado');
  });

  ws.send('Conexión establecida con el servidor de señalización');
});

console.log('Servidor de señalización WebSocket escuchando en el puerto 8080');