// index.js — cTrader Open API 2.1 HTTP⇄WebSocket bridge
// copia / incolla **l’intero file** (sovrascrive quello precedente)

import express   from 'express';
import fetch     from 'node-fetch';
import WebSocket from 'ws';

/* ─────────────────────────────────── ENV ─────────────────────────────────── */

const {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET,
  CTRADER_REFRESH_TOKEN: INITIAL_REFRESH,
  CTRADER_ACCOUNT_ID,           // ← CTID account (int64 → string!)
  CTRADER_ENV = 'demo'
} = process.env;

if (!CTRADER_CLIENT_ID || !CTRADER_CLIENT_SECRET || !INITIAL_REFRESH || !CTRADER_ACCOUNT_ID) {
  console.error('⚠︎ Missing required env vars');
  process.exit(1);
}

const WS_HOST =
  CTRADER_ENV === 'live'
    ? 'wss://live.ctraderapi.com:5036'
    : 'wss://demo.ctraderapi.com:5036';

/* ────────────────────────────── GLOBAL STATE ─────────────────────────────── */

let ws;                        // WebSocket handle
let accessToken;               // OAuth access token
let currentRefresh = INITIAL_REFRESH;
let socketReady   = false;     // diventa true dopo ACCOUNT-AUTH OK
const pending     = new Map(); // clientMsgId → {resolve, reject}

/* ──────────────────────────── TOKEN UTILS (HTTPS) ────────────────────────── */

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

    const j        = await res.json();
    accessToken    = j.access_token;
    currentRefresh = j.refresh_token || currentRefresh;
    const expires  = j.expires_in ?? j.expiresIn ?? 900;
    console.log('✔︎ HTTP token ok – expires in', expires, 's');
    setTimeout(refreshToken, (expires - 60 + (Math.random()*10 - 5))*1000);
  } catch (err) {
    console.error('⚠︎ refresh error', err.message);
    setTimeout(refreshToken, 60_000 + Math.random()*60_000);
  }
}

/* ──────────────────────────── WEBSOCKET HELPERS ──────────────────────────── */

function sendWS (msg) {
  return new Promise((resolve, reject) => {
    const id = msg.clientMsgId = msg.clientMsgId || `m_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    pending.set(id, { resolve, reject });

    ws.send(JSON.stringify(msg));

    // fallback-timeout (8 s)
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('WS response timeout'));
      }
    }, 8_000);
  });
}

function openSocket () {
  socketReady = false;
  ws = new WebSocket(WS_HOST);

  ws.on('open', () => {
    console.log('✔︎ WS connected – sending APP-AUTH');

    sendWS({
      payloadType : 2101,               // ProtoOAApplicationAuthReq
      clientId    : CTRADER_CLIENT_ID,
      clientSecret: CTRADER_CLIENT_SECRET
    })
    .then(() => {
      console.log('✓ App-auth OK – sending ACCOUNT-AUTH');
      return sendWS({
        payloadType        : 2102,      // ProtoOAAccountAuthReq
        ctidTraderAccountId: CTRADER_ACCOUNT_ID,
        accessToken
      });
    })
    .then(() => {
      socketReady = true;
      console.log('✓ Account-auth OK — socket pronto');
      // *** NIENTE ALTRO QUI ***
      // Ogni messaggio aggiuntivo (Subscribe, Reconcile, …) va
      // inviato più tardi, quando davvero serve, da un endpoint HTTP.
    })
    .catch(err => {
      console.error('❌ WS auth error', err.message);
      ws.close();
    });
  });

  ws.on('message', buf => {
    let m; try { m = JSON.parse(buf.toString()) } catch { return; }

    const { payloadType, clientMsgId } = m;
    if (clientMsgId && pending.has(clientMsgId)) {
      pending.get(clientMsgId).resolve(m);      // risposta attesa
      pending.delete(clientMsgId);
    } else if (payloadType === 40) {            // ProtoOAExecutionEvent
      console.log('▶︎ Execution event', JSON.stringify(m.payload));
    } else if (payloadType === 39) {            // ProtoOAErrorRes
      console.warn('⚠︎ WS error', m.payload?.errorCode, m.payload?.description);
    }
  });

  ws.on('close', () => {
    socketReady = false;
    console.warn('WS closed – reconnecting in 5 s');
    setTimeout(openSocket, 5_000);
  });

  ws.on('error', err => console.error('WS error', err.message));
}

/* ─────────────────────────── HTTP MINI-API (per Make) ────────────────────── */

const app = express();
app.use(express.json());

// POST /order  { symbolId, side, volume, type, limitPrice?, stopPrice?, tp?, sl?, timeInForce? }
app.post('/order', async (req, res) => {
  if (!socketReady) return res.status(503).json({ error: 'socket not ready' });

  const {
    symbolId,          // INT
    side,              // "BUY" / "SELL"
    volume,            // cent units (100_000 = 1 lot)
    type  = 'MARKET',  // MARKET / LIMIT / STOP / STOP_LIMIT …
    limitPrice,
    stopPrice,
    tp,
    sl,
    timeInForce
  } = req.body || {};

  const msg = {
    payloadType        : 62,                 // ProtoOANewOrderReq
    ctidTraderAccountId: CTRADER_ACCOUNT_ID,
    symbolId           : Number(symbolId),
    orderType          : type,
    tradeSide          : side,
    volume             : Number(volume),
    ...(limitPrice ? { limitPrice }                  : {}),
    ...(stopPrice  ? { stopPrice }                   : {}),
    ...(tp         ? { takeProfit : tp }             : {}),
    ...(sl         ? { stopLoss   : sl }             : {}),
    ...(timeInForce? { timeInForce }                 : {})
  };

  try {
    const resp  = await sendWS(msg);           // attende ExecutionEvent (40)
    const exec  = resp.payload || {};
    if (exec.errorCode) throw new Error(exec.errorCode);
    res.json({ orderId: exec.order?.id, status: exec.executionType });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ───────────────────────────────── BOOT ──────────────────────────────────── */

await refreshToken();   // ottiene subito l’access token
openSocket();           // handshake / reconnect

const PORT = process.env.PORT || 8080;
app.get('/', (_, r) => r.send('cTrader bridge running'));
app.listen(PORT, () => console.log('bridge ready on', PORT));
