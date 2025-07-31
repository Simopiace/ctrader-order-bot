// index.js — ponte HTTP ⇄ WebSocket cTrader
// Versione con payloadType numerici secondo la spec Open API v2

import express from 'express';
import fetch from 'node-fetch';
import WebSocket from 'ws';

/* ──────── credenziali ──────── */
const {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET,
  CTRADER_REFRESH_TOKEN: INITIAL_REFRESH,
  CTRADER_ACCOUNT_ID,
  CTRADER_ENV = 'demo'                 // 'live' per conto reale
} = process.env;

/* ──────── host WebSocket ──────── */
const WS_HOST =
  CTRADER_ENV === 'live'
    ? 'wss://live.ctraderapi.com:5035/stream?format=json'
    : 'wss://demo.ctraderapi.com:5035/stream?format=json';

/* ──────── map codici payload ──────── */
const PT = {
  APP_AUTH_REQ: 2100,
  APP_AUTH_RES: 2101,
  ORDER_NEW_REQ: 2106,
  ORDER_NEW_RES: 2107,       // RES / REJECT usano lo stesso ID con campo status
  ORDER_NEW_REJ: 2107
};

let ws;
let accessToken;
let currentRefresh = INITIAL_REFRESH;

/* ──────────────────────────────────────────────────────────
   1. Ottiene / rinnova l’access-token
   ────────────────────────────────────────────────────────── */
async function refreshToken () {
  const res = await fetch('https://openapi.ctrader.com/apps/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     CTRADER_CLIENT_ID,
      client_secret: CTRADER_CLIENT_SECRET,
      refresh_token: currentRefresh
    })
  });

  const txt = await res.text();
  if (!res.ok) {
    console.error('Token refresh failed ⇒', res.status, txt.slice(0, 200));
    process.exit(1);
  }

  const j = JSON.parse(txt);
  accessToken    = j.access_token;
  currentRefresh = j.refresh_token || currentRefresh;

  const ttl = Number(j.expires_in) || 900;   // fallback 15 min
  console.log('✔︎ Token ok. Next refresh in', ttl, 'sec');
  setTimeout(refreshToken, (ttl - 60) * 1000);
}

/* ──────────────────────────────────────────────────────────
   2. Apre / riapre la WebSocket
   ────────────────────────────────────────────────────────── */
function openSocket () {
  ws = new WebSocket(WS_HOST);

  ws.on('open', () => {
    console.log('✔︎ WS connected');
    ws.send(JSON.stringify({
      clientMsgId: 'app-auth-' + Date.now(),
      payloadType: PT.APP_AUTH_REQ,
      payload: {
        clientId:     CTRADER_CLIENT_ID,
        clientSecret: CTRADER_CLIENT_SECRET,
        accessToken
      }
    }));
  });

  ws.on('close', () => {
    console.warn('WS closed — reconnecting in 2 s');
    setTimeout(openSocket, 2000);
  });

  ws.on('error', err => console.error('WS error', err));
}

/* ──────────────────────────────────────────────────────────
   3. API HTTP: POST /order
   ────────────────────────────────────────────────────────── */
const app = express();
app.use(express.json());

app.post('/order', (req, res) => {
  const { symbol, side, volume, price, tp, sl, type = 'LIMIT' } = req.body;

  if (!ws || ws.readyState !== 1)
    return res.status(503).json({ error: 'socket not ready' });

  const msgId = 'ord-' + Date.now();

  ws.send(JSON.stringify({
    clientMsgId: msgId,
    payloadType: PT.ORDER_NEW_REQ,
    payload: {
      accountId:      Number(CTRADER_ACCOUNT_ID),
      symbolName:     symbol,
      orderType:      type,          // LIMIT / MARKET / STOP
      tradeSide:      side,          // BUY / SELL
      requestedPrice: price,
      volume,
      takeProfit: tp ? { price: tp } : undefined,
      stopLoss:   sl ? { price: sl } : undefined
    }
  }), err => {
    if (err) return res.status(500).json({ error: 'ws send error' });

    /* ascolta la risposta con lo stesso clientMsgId */
    const once = data => {
      const m = JSON.parse(data.toString());
      if (m.clientMsgId !== msgId) return;         // non è la nostra
      ws.off('message', once);

      /* reject / response sono lo stesso PT con campi diversi */
      if (m.payload.rejectReason)
        return res.status(400).json({ error: m.payload.rejectReason });

      return res.json({ orderId: m.payload.orderId });
    };
    ws.on('message', once);
  });
});

/* ──────────────────────────────────────────────────────────
   4. Avvio
   ────────────────────────────────────────────────────────── */
await refreshToken();
openSocket();
const PORT = process.env.PORT || 8080;
app.get('/', (_, r) => r.send('cTrader bridge running'));  // optional “health” route
app.listen(PORT, () => console.log('bridge ready on', PORT));
