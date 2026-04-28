import { serve } from 'bun';
import { statSync } from 'fs';
import { join, extname } from 'path';

type State = 'idle' | 'running' | 'end_hold' | 'estop';
type Color = 'blue' | 'red';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
};

const wsClients = new Set<any>();

const timer = {
  state: 'idle' as State,
  remaining: 150,
  matchTime: 150,
  shiftTime: -1,
  firstColor: 'blue' as Color,
  lastShift: null as Color | null,
  tickInterval: null as ReturnType<typeof setInterval> | null,
  endHoldTimeout: null as ReturnType<typeof setTimeout> | null,
};

function getShiftColor(): Color | null {
  if (timer.shiftTime <= 0) return null;
  const elapsed = timer.matchTime - timer.remaining;
  const idx = Math.floor(elapsed / timer.shiftTime);
  return idx % 2 === 0 ? timer.firstColor : (timer.firstColor === 'blue' ? 'red' : 'blue');
}

function getNextShiftIn(): number | null {
  if (timer.shiftTime <= 0) return null;
  const elapsed = timer.matchTime - timer.remaining;
  return timer.shiftTime - (elapsed % timer.shiftTime);
}

function buildMessage(events: string[] = []): string {
  const shift = timer.state === 'running' ? getShiftColor() : null;
  return JSON.stringify({
    type: 'state',
    state: timer.state,
    remaining: timer.remaining,
    config: { matchTime: timer.matchTime, shiftTime: timer.shiftTime },
    shift,
    nextShiftIn: timer.state === 'running' ? getNextShiftIn() : null,
    events,
  });
}

function broadcast(msg: string) {
  for (const ws of wsClients) {
    try { ws.send(msg); } catch {}
  }
}

function enterIdle() {
  if (timer.tickInterval) clearInterval(timer.tickInterval);
  if (timer.endHoldTimeout) clearTimeout(timer.endHoldTimeout);
  timer.tickInterval = null;
  timer.endHoldTimeout = null;
  timer.state = 'idle';
  timer.remaining = timer.matchTime;
  timer.lastShift = null;
  broadcast(buildMessage());
}

function enterRunning() {
  timer.firstColor = Math.random() < 0.5 ? 'red' : 'blue';
  timer.state = 'running';
  timer.lastShift = getShiftColor();
  broadcast(buildMessage(['start']));

  timer.tickInterval = setInterval(() => {
    timer.remaining--;
    const events: string[] = [];

    if (timer.shiftTime > 0) {
      const currentShift = getShiftColor();
      if (currentShift !== timer.lastShift) {
        timer.lastShift = currentShift;
        events.push('shiftChange');
      }
    }

    if (timer.remaining === 30) events.push('warn');

    if (timer.remaining <= 0) {
      clearInterval(timer.tickInterval!);
      timer.tickInterval = null;
      timer.state = 'end_hold';
      timer.remaining = 0;
      broadcast(buildMessage(['end']));
      timer.endHoldTimeout = setTimeout(enterIdle, 30000);
      return;
    }

    broadcast(buildMessage(events));
  }, 1000);
}

function enterEstop() {
  if (timer.tickInterval) clearInterval(timer.tickInterval);
  if (timer.endHoldTimeout) clearTimeout(timer.endHoldTimeout);
  timer.tickInterval = null;
  timer.endHoldTimeout = null;
  timer.state = 'estop';
  broadcast(buildMessage(['estop']));
}

function handleCommand(data: string) {
  let msg: any;
  try { msg = JSON.parse(data); } catch { return; }

  switch (msg.type) {
    case 'start':
      if (timer.state === 'idle') enterRunning();
      break;
    case 'estop':
      if (timer.state === 'running' || timer.state === 'end_hold') enterEstop();
      break;
    case 'reset':
      enterIdle();
      break;
    case 'config': {
      const mt = Number(msg.matchTime);
      const st = Number(msg.shiftTime);
      if (!isNaN(mt) && mt > 0) timer.matchTime = Math.round(mt);
      if (!isNaN(st)) timer.shiftTime = st <= 0 ? -1 : Math.round(st);
      if (timer.state === 'idle') timer.remaining = timer.matchTime;
      broadcast(buildMessage());
      break;
    }
  }
}

const PUBLIC = join(import.meta.dir, 'public');

serve({
  port: 3000,
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === '/ws') {
      if (server.upgrade(req)) return undefined;
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

    if (!filePath.startsWith(PUBLIC)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) throw new Error();
      const ext = extname(filePath);
      const mime = MIME[ext] ?? 'application/octet-stream';
      return new Response(Bun.file(filePath), { headers: { 'Content-Type': mime } });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  },
  websocket: {
    open(ws) {
      wsClients.add(ws);
      ws.send(buildMessage());
    },
    message(_ws, data) {
      handleCommand(String(data));
    },
    close(ws) {
      wsClients.delete(ws);
    },
  },
});

console.log('Match timer running on http://localhost:3000');
