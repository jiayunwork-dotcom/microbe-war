import express from 'express';
import http from 'http';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms/RoomManager';
import { setupWebSocketHandlers } from './websocket/handlers';

const PORT = parseInt(process.env.PORT || '3001', 10);

const app = express();
app.use(cors());
app.use(express.json());

const roomManager = new RoomManager();

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/rooms', (_req, res) => {
  res.json({ rooms: roomManager.getRoomInfoList() });
});

const server = http.createServer(app);

const wss = new WebSocketServer({
  server,
  path: '/ws',
});

setupWebSocketHandlers(wss, roomManager);

server.listen(PORT, () => {
  console.log(`[Microbe War Backend] listening on port ${PORT}`);
  console.log(`  - HTTP API: http://0.0.0.0:${PORT}/api`);
  console.log(`  - WebSocket: ws://0.0.0.0:${PORT}/ws`);
});
