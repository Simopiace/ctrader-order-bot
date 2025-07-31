// index.js — ponte HTTP ⇄ WebSocket cTrader
// Incolla tutto: non serve modificare altro

import express from 'express';
import fetch from 'node-fetch';
import WebSocket from 'ws';

const {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET,
  CTRADER_REFRESH_TOKEN: INITIAL_REFRESH,   // token solo al primo avvio
  CTRADER_ACCOUNT_ID,
  CTRADER_ENV = 'demo'                      // scrivi 'live' se usi un conto reale
} = process.env;

const WS_HOST =
  CTRADER_ENV === 'live'
    ? 'wss://live.ctraderapi.com:5036/stream?format=json'   // ★ nuovo
    : 'wss://demo.ctraderapi.com:5036/stream?format=json';  // ★ nuovo

let ws;
let accessToken;
let currentRefresh = INITIAL_REFRESH;       // diventa “vivo”

// ───────────────────────────────────────────────
// 1. Funzione che ottiene / rinnova l’access-token
//    • Salva anche il refresh_token nuovo (se c’è)
//    • Attende 14′ se expires_in è assente
// ───────────────────────────────────────────────
async function refreshToken() {
  const res = await fetch('https://openapi.ctrader.com/apps/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     CTRADER_CLIENT_ID,
      client_secret: CTRADER_CLIENT_SECRET,
      refresh_token: currentRefresh          // sempre l’ultimo valido
    })
  });

  const txt = await res.text();              // leggiamo come testo
  if (!res.ok) {                             // se 4xx/5xx → log e uscita
    console.error('Token refresh failed ⇒', res.status, txt.slice(0, 200));
    process.exit(1);
  }

  const j = JSON.parse(txt);                 // ora è JSON
  accessToken    = j.access_token;
  currentRefresh = j.refresh_token || currentRefresh;

  // se manca expires_in (alcuni account) usiamo 900 s = 15 min
  const ttl = Number(j.expires_in) || 900;
  console.log('✔︎ Token ok. Next refresh in', ttl, 'sec');

  setTimeout(refreshToken, (ttl - 60) * 1000); // rinnova 1 min prima
}

// ───────────────────────────────────────────────
// 2. Apre (o riapre) la “chat tecnica” WebSocket
// ───────────────────────────────────────────────
function openSocket() {
  ws = new WebSocket(WS_HOST);

  ws.on('open', () => {
    console.log('✔︎ WS connected');
   ws.send(
  JSON.stringify({
-   payloadType: 'PROTOCOL_APPLICATION_AUTH_REQ',           // vecchio
+   payloadType: 'ProtoOAApplicationAuthReq',               // ★ nuovo
    payload: {
      clientId:     CTRADER_CLIENT_ID,
      clientSecret: CTRADER_CLIENT_SECRET,
      accessToken
    }
  })
);
  });

  ws.on('close', () => {
    console.warn('WS closed — reconnecting in 2 s');
    setTimeout(openSocket, 2000);
  });

  ws.on('error', err => console.error('WS error', err));
}

// ───────────────────────────────────────────────
// 3. API HTTP che Make chiamerà: POST /order
// ───────────────────────────────────────────────
const app = express();
app.use(express.json());

app.post('/order', (req, res) => {
  const { symbol, side, volume, price, tp, sl, type = 'LIMIT' } = req.body;

  if (!ws || ws.readyState !== 1)
    return res.status(503).json({ error: 'socket not ready' });

  const msg = {
    payloadType: 'PROTOCOL_ORDER_NEW_REQ',
    payload: {
      accountId:   Number(CTRADER_ACCOUNT_ID),
      symbolName:  symbol,
      orderType:   type,      // LIMIT / MARKET / STOP
      tradeSide:   side,      // BUY / SELL
      requestedPrice: price,
      volume,
      takeProfit: tp ? { price: tp } : undefined,
      stopLoss:   sl ? { price: sl } : undefined
    }
  };

  ws.send(JSON.stringify(msg), err => {
    if (err) return res.status(500).json({ error: 'ws send error' });

    const once = data => {
      const m = JSON.parse(data.toString());
      if (
        m.payloadType === 'PROTOCOL_ORDER_NEW_RESP' ||
        m.payloadType === 'PROTOCOL_ORDER_NEW_REJ'
      ) {
        ws.off('message', once);             // ascolta solo questa
        if (m.payloadType.endsWith('REJ'))
          return res.status(400).json({ error: m.payload.rejectReason });
        return res.json({ orderId: m.payload.orderId });
      }
    };
    ws.on('message', once);
  });
});

// ───────────────────────────────────────────────
// 4. Avvio
// ───────────────────────────────────────────────
await refreshToken();
openSocket();
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('bridge ready on', PORT));
