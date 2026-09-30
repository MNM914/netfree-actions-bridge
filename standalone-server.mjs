// Same JSON protocol as the Worker; no VLESS, WebSocket or third-party exit server.
import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function isPublicIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a,b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0,168].includes(b)) ||
    (a === 198 && [18,19,51].includes(b)) || (a === 203 && b === 0));
}
async function connectPublic(host, port) {
  const answers = await lookup(host, { family: 4, all: true });
  if (!answers.length || answers.some(answer => !isPublicIPv4(answer.address))) throw new Error('Destination is not public IPv4');
  // Connect to the validated address, preventing a second DNS lookup / rebinding.
  return await new Promise((resolve, reject) => {
    const socket = net.connect({ host: answers[0].address, port });
    const timer = setTimeout(() => socket.destroy(new Error('Connect timed out')), 10000);
    socket.once('error', reject);
    socket.once('close', () => clearTimeout(timer));
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
  });
}
export function createStandaloneBridge({ secret, dial = connectPublic, maxSessions = 128, idleMs = 90000 } = {}) {
  if (!secret || secret.length < 16) throw new Error('BRIDGE_KEY must contain at least 16 characters');
  const sessions = new Map();
  const reply = (res, value, status = 200) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type':'application/json', 'cache-control':'no-store' });
    res.end(JSON.stringify(value));
  };
  function close(session, error) {
    session.closed = true; session.error = error || null;
    session.socket?.destroy(); session.wake?.();
  }
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') { reply(res, { ok: true }); return; }
    if (req.url !== '/api/bridge') { reply(res, { error: 'Not found' }, 404); return; }
    const provided = Buffer.from(String(req.headers['x-bridge-key'] || ''));
    const expected = Buffer.from(secret);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) { reply(res, { error:'Authentication required' }, 401); return; }
    if (req.method !== 'POST') { reply(res, { error:'POST required' }, 405); return; }
    let command;
    try {
      const chunks=[]; let size=0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 150000) { reply(res, {error:'Request too large'}, 413); return; }
        chunks.push(chunk);
      }
      command=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error();
    } catch { reply(res, {error:'Invalid JSON'}, 400); return; }
    if (command.action === 'health') { reply(res, {ok:true,service:'netfree-http-bridge',version:'standalone-1'}); return; }
    if (!/^[a-f0-9-]{36}$/.test(command.id || '')) { reply(res, {error:'Invalid session'}, 400); return; }
    let session=sessions.get(command.id);
    if (command.action === 'open') {
      const host=String(command.host || '').toLowerCase(), port=Number(command.port);
      if (!/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host) || ![80,443].includes(port)) { reply(res, {error:'Invalid destination'}, 400); return; }
      if (session && (session.host !== host || session.port !== port)) { reply(res, {error:'Session destination mismatch'},409); return; }
      if (!session) {
        if (sessions.size >= maxSessions) { reply(res, {error:'Session limit'},429); return; }
        session={host,port,lastSeen:Date.now(),queue:[],size:0,seq:0,writeSeq:0,closed:false};
        sessions.set(command.id, session);
        session.opening=(async () => {
          try {
            session.socket=await dial(host,port);
            if (session.closed) { session.socket.destroy(); return; }
            session.socket.on('data', data => {
              session.queue.push(data); session.size+=data.length;
              if (session.size > 2*1024*1024) close(session,'Receive buffer limit');
              else if (session.size >= 512000) session.socket.pause();
              session.wake?.();
            });
            session.socket.on('end', () => close(session));
            session.socket.on('error', () => close(session,'Upstream connection failed'));
            session.socket.on('close', () => { session.closed=true; session.wake?.(); });
          } catch { close(session,'Destination connection failed'); }
        })();
      }
      await session.opening;
      reply(res, session.closed ? {error:'Session closed'} : {ok:true}, session.closed ? 410 : 200); return;
    }
    if (!session) { reply(res, {error:'Session not open'},410); return; }
    session.lastSeen=Date.now();
    if (command.action === 'close') { close(session); reply(res,{ok:true}); return; }
    if (command.action === 'write') {
      const seq=command.seq;
      if (!Number.isSafeInteger(seq) || seq < 1) { reply(res,{error:'Invalid sequence'},400); return; }
      if (seq <= session.writeSeq) { reply(res,{ok:true,seq:session.writeSeq}); return; }
      if (session.closed) { reply(res,{ok:true,closed:true,seq:session.writeSeq}); return; }
      if (seq !== session.writeSeq+1) { reply(res,{error:'Write sequence mismatch'},409); return; }
      if (typeof command.data !== 'string' || command.data.length > 90000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(command.data)) { reply(res,{error:'Invalid payload'},400); return; }
      if (!session.socket || session.socket.writableLength > 1024*1024) { reply(res,{error:'Upstream busy'},503); return; }
      session.socket.write(Buffer.from(command.data,'base64'));
      session.writeSeq=seq;
      reply(res,{ok:true,seq}); return;
    }
    if (command.action === 'poll') {
      // A timed-out poll may still be running when its retry arrives.
      if (session.polling) { reply(res,{error:'Poll in progress'},503); return; }
      if (!Number.isSafeInteger(command.ack) || command.ack < 0 || command.ack > session.seq) { reply(res,{error:'Invalid acknowledgement'},409); return; }
      session.polling=true;
      try {
        if (session.delivery && command.ack === session.delivery.seq) session.delivery=null;
        if (session.delivery) { reply(res,session.delivery); return; }
        if (!session.size && !session.closed) await new Promise(resolve => {
          const wake=()=>{clearTimeout(timer); session.wake=null;res.off('close',wake);resolve();};
          const timer=setTimeout(wake,40000);session.wake=wake;res.once('close',wake);
        });
        if (res.destroyed) return;
        const chunks=[];let length=0;
        while (session.queue.length && length < 480000) {
          const first=session.queue[0], count=Math.min(first.length,480000-length);
          chunks.push(first.subarray(0,count));length+=count;
          if (count===first.length) session.queue.shift(); else session.queue[0]=first.subarray(count);
        }
        session.size-=length;
        if (session.size < 256000 && !session.closed) session.socket.resume();
        const result={seq:++session.seq,data:Buffer.concat(chunks).toString('base64'),closed:session.closed && session.size===0,error:session.error || null};
        if (length || result.closed) session.delivery=result;
        reply(res,result);
      } finally { session.polling=false; }
      return;
    }
    reply(res,{error:'Unknown action'},400);
  });
  server.requestTimeout=20000;server.headersTimeout=15000;
  const timer=setInterval(()=>{for (const [id,session] of sessions) if (Date.now()-session.lastSeen > idleMs) {close(session);sessions.delete(id);}},Math.min(idleMs,10000));timer.unref();
  function stop() {clearInterval(timer);for(const session of sessions.values())close(session);server.closeAllConnections();server.close();}
  return {server,stop};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {server,stop}=createStandaloneBridge({secret:process.env.BRIDGE_KEY});
  delete process.env.BRIDGE_KEY;
  server.listen(Number(process.env.PORT || 8080), process.env.BIND_HOST || '0.0.0.0');
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}

