// index.js — HTTP ⇄ WebSocket bridge per cTrader Open API 2.1
// versione “stabile”: ping heartbeat, reconnect esponenziale, promesse safe.
// Incolla l’intero file e ridisponi → dovrebbe restare connesso.

import express   from 'express';
import fetch     from 'node-fetch';
import WebSocket from 'ws';

/* ------------------------------------------------------------------ */
/* ENV                                                                 */
/* ------------------------------------------------------------------ */
const {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET,
  CTRADER_REFRESH_TOKEN: INITIAL_REFRESH,
  CTRADER_ACCOUNT_ID,                // CTID account (int64)
  CTRADER_ENV = 'demo'
} = process.env;

const WS_HOST =
  CTRADER_ENV === 'live'
    ? 'wss://live.ctraderapi.com:5036'
    : 'wss://demo.ctraderapi.com:5036';

/* ------------------------------------------------------------------ */
/* STATE                                                               */
/* ------------------------------------------------------------------ */
let ws;                               // WebSocket handle
let pingTimer;                        // heartbeat
let reconnectDelay = 5_000;           // back-off (ms)
let accessToken;
let currentRefresh = INITIAL_REFRESH;
let socketReady = false;              // dopo Account-Auth OK
const pending = new Map();            // clientMsgId → {resolve,reject,timeoutId}

/* ------------------------------------------------------------------ */
/* TOKEN (HTTPS)                                                       */
/* ------------------------------------------------------------------ */
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
/* WEBSOCKET helpers                                                   */
/* ------------------------------------------------------------------ */
function sendWS (msg, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const id = msg.clientMsgId = msg.clientMsgId || `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    const to = setTimeout(() => {
      pending.delete(id);
      reject(new Error('WS response timeout'));
    }, timeout);
    pending.set(id, {resolve, reject, timeoutId: to});
    ws.send(JSON.stringify(msg));
  });
}

function startPing () {
  clearInterval(pingTimer);
  // ProtoOAPingReq = 50   – solo il payloadType è obbligatorio
  pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ payloadType: 50 }));
    }
  }, 10_000);
}

function stopPing () { clearInterval(pingTimer); }

/* ------------------------------------------------------------------ */
/* SOCKET lifecycle                                                    */
/* ------------------------------------------------------------------ */
function openSocket () {
  socketReady = false;
  ws = new WebSocket(WS_HOST);

  ws.on('open', async () => {
    console.log('✔︎ WS connected – sending APP-AUTH');
    try {
      await sendWS({
        payloadType : 2101,                // ProtoOAApplicationAuthReq
        clientId    : CTRADER_CLIENT_ID,
        clientSecret: CTRADER_CLIENT_SECRET
      });

      console.log('✓ App-auth OK – sending ACCOUNT-AUTH');
      await sendWS({
        payloadType       : 2102,          // ProtoOAAccountAuthReq
        ctidTraderAccountId: Number(CTRADER_ACCOUNT_ID),
        accessToken
      });

      socketReady = true;
      reconnectDelay = 5_000;              // reset back-off
      startPing();

      console.log('✓ Account-auth OK — socket ready');
      // opzionale: richiesta reconcile (non blocking, no timeout)
      ws.send(JSON.stringify({
        payloadType       : 2104,          // ProtoOAAssetListReq (esempio “light”)
        ctidTraderAccountId: Number(CTRADER_ACCOUNT_ID)
      }));
    } catch (err) {
      console.error('❌ WS auth error', err.message);
      ws.close();
    }
  });

  ws.on('message', buf => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }

    const { payloadType, clientMsgId } = m;

    // risposte attese da sendWS ------------------------------------------------
    if (clientMsgId && pending.has(clientMsgId)) {
      const {resolve, timeoutId} = pending.get(clientMsgId);
      clearTimeout(timeoutId);
      pending.delete(clientMsgId);
      return resolve(m);
    }

    // ping/pong ----------------------------------------------------------------
    if (payloadType === 51) {             // ProtoOAPingRes
      return;                             // nothing else to do
    }

    // execution / eventi -------------------------------------------------------
    if (payloadType === 40) {             // ProtoOAExecutionEvent
      console.log('▶︎ Execution event', JSON.stringify(m.payload));
      return;
    }

    // errori -------------------------------------------------------------------
    if (payloadType === 39) {             // ProtoOAErrorRes
      console.warn('⚠︎ WS error', m.payload?.errorCode, m.payload?.description);
    }
  });

  ws.on('close', () => {
    console.warn('WS closed – reconnect in', (reconnectDelay/1000).toFixed(1), 's');
    stopPing();
    // rigetta tutte le promesse pendenti
    for (const {reject, timeoutId} of pending.values()) {
      clearTimeout(timeoutId);
      reject(new Error('WS closed'));
    }
    pending.clear();
    setTimeout(openSocket, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60_000); // max 60 s
  });

  ws.on('error', err => console.error('WS error', err.message));
}

/* ------------------------------------------------------------------ */
/* HTTP mini-API (per Make)                                           */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json());

// POST /order  { symbolId, side, volume, type, limitPrice?, stopPrice?, tp?, sl? }
app.post('/order', async (req, res) => {
  if (!socketReady) return res.status(503).json({error:'socket not ready'});

  const {
    symbolId,
    side,               // "BUY"/"SELL"
    volume,             // in cent lots
    type = 'MARKET',    // MARKET / LIMIT ...
    limitPrice,
    stopPrice,
    tp, sl,
    timeInForce
  } = req.body || {};

  if (!symbolId || !side || !volume)
    return res.status(400).json({error:'symbolId, side, volume obbligatori'});

  const msg = {
    payloadType        : 62,                 // ProtoOANewOrderReq
    ctidTraderAccountId: Number(CTRADER_ACCOUNT_ID),
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
    const resp  = await sendWS(msg, 15_000);           // più largo (order → execution)
    const exec  = resp.payload || {};
    if (exec.errorCode) throw new Error(exec.errorCode);
    return res.json({orderId: exec.order?.id, status: exec.executionType});
  } catch (err) {
    return res.status(400).json({error: err.message});
  }
});

/* ------------------------------------------------------------------ */
/* BOOT                                                               */
/* ------------------------------------------------------------------ */
await refreshToken();       // ottieni access token
openSocket();               // handshake + reconnect loop

const PORT = process.env.PORT || 8080;
app.get('/', (_, r) => r.send('cTrader bridge running'));
app.listen(PORT, () => console.log('bridge ready on', PORT));
