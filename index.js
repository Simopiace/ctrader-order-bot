// index.js — bridge HTTP ⇄ WebSocket (cTrader Open API 2.1)
// versione “minimal-stable”: niente messaggi superflui dopo l’handshake.

import express   from 'express';
import fetch     from 'node-fetch';
import WebSocket from 'ws';

/* ------------------------------------------------------------------ */
/* ENV                                                                 */
const {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET,
  CTRADER_REFRESH_TOKEN: INITIAL_REFRESH,
  CTRADER_ACCOUNT_ID,              // CTID account (int64)
  CTRADER_ENV = 'demo'
} = process.env;

const WS_HOST =
  CTRADER_ENV === 'live'
    ? 'wss://live.ctraderapi.com:5036'
    : 'wss://demo.ctraderapi.com:5036';

/* ------------------------------------------------------------------ */
/* STATE                                                               */
let ws;
let pingTimer;
let accessToken;
let currentRefresh = INITIAL_REFRESH;
let socketReady = false;
const pending = new Map();         // id → {resolve,reject,timeout}

/* ------------------------------------------------------------------ */
/* TOKEN                                                               */
async function refreshToken (delay = 0) {
  if (delay) await new Promise(r => setTimeout(r, delay));
  try {
    const res = await fetch('https://openapi.ctrader.com/apps/token', {
      method : 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body   : new URLSearchParams({
        grant_type   : 'refresh_token',
        client_id    : CTRADER_CLIENT_ID,
        client_secret: CTRADER_CLIENT_SECRET,
        refresh_token: currentRefresh
      })
    });

    if (res.status === 429) {
      const wait = 30_000 + Math.random()*30_000;
      console.warn('↻ 429 Too Many Requests — retry in', (wait/1000).toFixed(1), 's');
      return refreshToken(wait);
    }
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

    const j = await res.json();
    accessToken    = j.access_token;
    currentRefresh = j.refresh_token || currentRefresh;
    const expires  = j.expires_in ?? j.expiresIn ?? 900;
    console.log('✔︎ HTTP token ok – expires in', expires, 's');
    setTimeout(refreshToken, (expires - 60 + (Math.random()*10 - 5))*1000);
  }
  catch (err) {
    console.error('⚠︎ refresh error', err.message);
    setTimeout(refreshToken, 60_000 + Math.random()*60_000);
  }
}

/* ------------------------------------------------------------------ */
/* WS utils                                                            */
function sendWS (msg, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const id = msg.clientMsgId = msg.clientMsgId || `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    const to = setTimeout(() => {
      pending.delete(id);
      reject(new Error('WS response timeout'));
    }, timeout);
    pending.set(id, {resolve, reject, timeout});
    ws.send(JSON.stringify(msg));
  });
}

function startPing () {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ payloadType: 50 }));   // ProtoOAPingReq
  }, 10_000);
}

/* ------------------------------------------------------------------ */
/* SOCKET lifecycle                                                    */
function openSocket () {
  ws = new WebSocket(WS_HOST);

  ws.on('open', async () => {
    console.log('✔︎ WS connected – sending APP-AUTH');
    try {
      await sendWS({
        payloadType : 2101, // ProtoOAApplicationAuthReq
        clientId    : CTRADER_CLIENT_ID,
        clientSecret: CTRADER_CLIENT_SECRET
      });

      console.log('✓ App-auth OK – sending ACCOUNT-AUTH');
      await sendWS({
        payloadType        : 2102, // ProtoOAAccountAuthReq
        ctidTraderAccountId: Number(CTRADER_ACCOUNT_ID),
        accessToken
      });

      socketReady = true;
      startPing();
      console.log('✓ Account-auth OK — socket ready');
      // *** NIENTE altro messaggio qui! *** (era la causa dei close)
    } catch (err) {
      console.error('❌ WS auth error', err.message);
      ws.close();
    }
  });

  ws.on('message', buf => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    const {payloadType, clientMsgId} = m;

    if (clientMsgId && pending.has(clientMsgId)) {
      pending.get(clientMsgId).resolve(m);
      pending.delete(clientMsgId);
      return;
    }
    if (payloadType === 51) return;                 // PingRes
    if (payloadType === 40)                         // ExecutionEvent
      return console.log('▶︎ Execution', JSON.stringify(m.payload));
    if (payloadType === 39)                         // ErrorRes
      return console.warn('⚠︎ WS error', m.payload?.errorCode, m.payload?.description);
  });

  ws.on('close', (code, reason) => {
    console.warn('WS closed', code, reason.toString());
    socketReady = false;
    clearInterval(pingTimer);
    for (const {reject} of pending.values()) reject(new Error('WS closed'));
    pending.clear();
    setTimeout(openSocket, 5_000);                  // fixed 5 s retry
  });

  ws.on('error', err => console.error('WS error', err.message));
}

/* ------------------------------------------------------------------ */
/* HTTP mini-API                                                       */
const app = express();
app.use(express.json());

// POST /order  { symbolId, side, volume, type, limitPrice?, stopPrice?, tp?, sl? }
app.post('/order', async (req, res) => {
  if (!socketReady) return res.status(503).json({error:'socket not ready'});

  const {
    symbolId,
    side,
    volume,
    type = 'MARKET',
    limitPrice,
    stopPrice,
    tp, sl,
    timeInForce
  } = req.body || {};

  if (!symbolId || !side || !volume)
    return res.status(400).json({error:'symbolId, side, volume obbligatori'});

  const msg = {
    payloadType        : 62, // ProtoOANewOrderReq
    ctidTraderAccountId: Number(CTRADER_ACCOUNT_ID),
    accessToken,
    symbolId           : Number(symbolId),
    orderType          : type,
    tradeSide          : side,
    volume             : Number(volume),
    ...(limitPrice ? {limitPrice} : {}),
    ...(stopPrice  ? {stopPrice}  : {}),
    ...(tp         ? {takeProfit : tp} : {}),
    ...(sl         ? {stopLoss   : sl} : {}),
    ...(timeInForce? {timeInForce} : {})
  };

  try {
    const resp = await sendWS(msg, 15_000);
    const exec = resp.payload || {};
    if (exec.errorCode) throw new Error(exec.errorCode);
    return res.json({orderId: exec.order?.id, status: exec.executionType});
  } catch (err) {
    return res.status(400).json({error: err.message});
  }
});

/* ------------------------------------------------------------------ */
/* BOOT                                                                */
await refreshToken();
openSocket();

const PORT = process.env.PORT || 8080;
app.get('/', (_, r) => r.send('cTrader bridge running'));
app.listen(PORT, () => console.log('bridge ready on', PORT));
