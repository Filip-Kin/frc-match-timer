import { serve, ServerWebSocket } from 'bun';
import { statSync } from 'fs';
import { join, extname } from 'path';
import QRCode from 'qrcode';

type Color = 'blue' | 'red';
type ShiftColor = 'blue' | 'red' | 'purple' | null;
type Period = 'idle' | 'auto' | 'delay' | 'teleop' | 'end_hold' | 'estop';

interface Config {
  autoTime: number;
  delayTime: number;
  transitionTime: number;
  shiftTime: number;
  endgameTime: number;
}

interface WsData {
  sessionId: string;
  role: 'display' | 'control';
}

interface Session {
  id: string;
  period: Period;
  remaining: number;
  config: Config;
  firstColor: Color;
  lastShiftColor: ShiftColor;
  tickInterval: ReturnType<typeof setInterval> | null;
  holdTimeout: ReturnType<typeof setTimeout> | null;
  clients: Set<ServerWebSocket<WsData>>;
}

const DEFAULT_CONFIG: Config = {
  autoTime: 20,
  delayTime: 3,
  transitionTime: 10,
  shiftTime: 25,
  endgameTime: 30,
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
};

function teleopTotal(cfg: Config): number {
  return cfg.transitionTime + cfg.shiftTime * 4 + cfg.endgameTime;
}

function computeShiftColor(session: Session): ShiftColor {
  const { period, remaining, config, firstColor, lastShiftColor } = session;
  if (period === 'idle' || period === 'auto' || period === 'delay') return null;
  if (period === 'end_hold' || period === 'estop') return lastShiftColor;
  if (period !== 'teleop') return null;

  const total = teleopTotal(config);
  if (remaining > total - config.transitionTime) return 'purple';
  if (remaining <= config.endgameTime) return lastShiftColor;

  const shiftElapsed = total - config.transitionTime - remaining;
  const idx = Math.floor(shiftElapsed / config.shiftTime);
  return idx % 2 === 0 ? firstColor : (firstColor === 'blue' ? 'red' : 'blue');
}

function getNextChangeIn(session: Session): number | null {
  if (session.period !== 'teleop') return null;
  const { remaining, config } = session;
  const total = teleopTotal(config);

  if (remaining > total - config.transitionTime) {
    return remaining - (total - config.transitionTime);
  }
  if (remaining <= config.endgameTime) return null;

  const shiftElapsed = total - config.transitionTime - remaining;
  const nextBoundaryElapsed = (Math.floor(shiftElapsed / config.shiftTime) + 1) * config.shiftTime;
  const nextBoundaryRemaining = total - config.transitionTime - nextBoundaryElapsed;
  return remaining - Math.max(nextBoundaryRemaining, config.endgameTime);
}

function buildMessage(session: Session, events: string[] = []): string {
  const shift = computeShiftColor(session);
  return JSON.stringify({
    type: 'state',
    period: session.period,
    remaining: session.remaining,
    config: session.config,
    shift,
    isEndgame: session.period === 'teleop' && session.remaining <= session.config.endgameTime,
    nextChangeIn: getNextChangeIn(session),
    events,
  });
}

function broadcastSession(session: Session, msg: string) {
  for (const ws of session.clients) {
    try { ws.send(msg); } catch {}
  }
}

function clearTimers(session: Session) {
  if (session.tickInterval) { clearInterval(session.tickInterval); session.tickInterval = null; }
  if (session.holdTimeout)  { clearTimeout(session.holdTimeout);   session.holdTimeout  = null; }
}

function enterIdle(session: Session) {
  clearTimers(session);
  session.period = 'idle';
  session.remaining = session.config.autoTime;
  session.lastShiftColor = null;
  broadcastSession(session, buildMessage(session));
}

function enterAuto(session: Session) {
  session.firstColor = Math.random() < 0.5 ? 'red' : 'blue';
  session.period = 'auto';
  session.remaining = session.config.autoTime;
  broadcastSession(session, buildMessage(session, ['autoStart']));

  session.tickInterval = setInterval(() => {
    session.remaining--;
    if (session.remaining <= 0) {
      clearInterval(session.tickInterval!);
      session.tickInterval = null;
      session.remaining = 0;
      broadcastSession(session, buildMessage(session, ['autoEnd']));
      enterDelay(session);
      return;
    }
    broadcastSession(session, buildMessage(session));
  }, 1000);
}

function enterDelay(session: Session) {
  session.period = 'delay';
  session.remaining = session.config.delayTime;
  broadcastSession(session, buildMessage(session));

  session.tickInterval = setInterval(() => {
    session.remaining--;
    if (session.remaining <= 0) {
      clearInterval(session.tickInterval!);
      session.tickInterval = null;
      enterTeleop(session);
      return;
    }
    broadcastSession(session, buildMessage(session));
  }, 1000);
}

function enterTeleop(session: Session) {
  session.period = 'teleop';
  session.remaining = teleopTotal(session.config);
  session.lastShiftColor = computeShiftColor(session); // 'purple' at start
  broadcastSession(session, buildMessage(session, ['teleopStart']));

  session.tickInterval = setInterval(() => {
    session.remaining--;
    const events: string[] = [];

    const currentShift = computeShiftColor(session);
    if (currentShift !== session.lastShiftColor) {
      if (session.lastShiftColor !== null) events.push('shiftChange');
      session.lastShiftColor = currentShift;
    }

    if (session.remaining === session.config.endgameTime) events.push('warn');

    if (session.remaining <= 0) {
      clearInterval(session.tickInterval!);
      session.tickInterval = null;
      session.period = 'end_hold';
      session.remaining = 0;
      broadcastSession(session, buildMessage(session, ['end']));
      session.holdTimeout = setTimeout(() => enterIdle(session), 30_000);
      return;
    }

    broadcastSession(session, buildMessage(session, events));
  }, 1000);
}

function enterEstop(session: Session) {
  clearTimers(session);
  session.period = 'estop';
  broadcastSession(session, buildMessage(session, ['estop']));
}

function isPos(v: unknown): v is number { return typeof v === 'number' && v > 0; }
function isNN(v: unknown): v is number  { return typeof v === 'number' && v >= 0; }

function handleCommand(ws: ServerWebSocket<WsData>, data: string) {
  const session = sessions.get(ws.data.sessionId);
  if (!session || ws.data.role !== 'control') return;

  let msg: any;
  try { msg = JSON.parse(data); } catch { return; }

  switch (msg.type) {
    case 'start':
      if (session.period === 'idle') enterAuto(session);
      break;
    case 'estop':
      if (session.period !== 'idle' && session.period !== 'estop') enterEstop(session);
      break;
    case 'reset':
      enterIdle(session);
      break;
    case 'config': {
      const c = session.config;
      if (isPos(msg.autoTime))      c.autoTime      = Math.round(msg.autoTime);
      if (isNN(msg.delayTime))      c.delayTime      = Math.round(msg.delayTime);
      if (isNN(msg.transitionTime)) c.transitionTime = Math.round(msg.transitionTime);
      if (isPos(msg.shiftTime))     c.shiftTime      = Math.round(msg.shiftTime);
      if (isNN(msg.endgameTime))    c.endgameTime    = Math.round(msg.endgameTime);
      if (session.period === 'idle') session.remaining = c.autoTime;
      broadcastSession(session, buildMessage(session));
      break;
    }
  }
}

function generateId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

const sessions = new Map<string, Session>();

function getOrCreateSession(id: string): Session {
  if (sessions.has(id)) return sessions.get(id)!;
  const s: Session = {
    id,
    period: 'idle',
    remaining: DEFAULT_CONFIG.autoTime,
    config: { ...DEFAULT_CONFIG },
    firstColor: 'blue',
    lastShiftColor: null,
    tickInterval: null,
    holdTimeout: null,
    clients: new Set(),
  };
  sessions.set(id, s);
  return s;
}

const PUBLIC = join(import.meta.dir, 'public');

serve({
  port: 3000,
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === '/qr') {
      const id = (url.searchParams.get('id') ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!id) return new Response('Missing id', { status: 400 });
      const svg = await QRCode.toString(`https://timer.filipkin.com/control?id=${id}`, {
        type: 'svg', margin: 1, width: 120,
      });
      return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } });
    }

    if (url.pathname === '/ws') {
      const role = (url.searchParams.get('role') ?? 'control') as 'display' | 'control';
      let sessionId = (url.searchParams.get('id') ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

      if (role === 'display') {
        if (!sessionId || !sessions.has(sessionId)) sessionId = generateId();
        getOrCreateSession(sessionId);
        if (server.upgrade(req, { data: { sessionId, role } as WsData })) return undefined;
      } else {
        if (!sessionId) return new Response('Missing id', { status: 400 });
        getOrCreateSession(sessionId);
        if (server.upgrade(req, { data: { sessionId, role } as WsData })) return undefined;
      }
      return new Response('WebSocket upgrade failed', { status: 400 });
    }

    let filePath: string;
    if (url.pathname === '/' || url.pathname === '/index.html') {
      filePath = join(PUBLIC, 'index.html');
    } else if (url.pathname === '/control' || url.pathname === '/control.html') {
      filePath = join(PUBLIC, 'control.html');
    } else {
      filePath = join(PUBLIC, url.pathname);
    }

    if (!filePath.startsWith(PUBLIC)) return new Response('Forbidden', { status: 403 });

    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) throw new Error();
      const ext = extname(filePath);
      return new Response(Bun.file(filePath), {
        headers: { 'Content-Type': MIME[ext] ?? 'application/octet-stream' },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  },
  websocket: {
    open(ws) {
      const typed = ws as ServerWebSocket<WsData>;
      const session = sessions.get(typed.data.sessionId)!;
      session.clients.add(typed);
      if (typed.data.role === 'display') {
        typed.send(JSON.stringify({ type: 'registered', id: typed.data.sessionId }));
      }
      typed.send(buildMessage(session));
    },
    message(ws, data) {
      handleCommand(ws as ServerWebSocket<WsData>, String(data));
    },
    close(ws) {
      const typed = ws as ServerWebSocket<WsData>;
      sessions.get(typed.data.sessionId)?.clients.delete(typed);
    },
  },
});

console.log('Match timer running on http://localhost:3000');
