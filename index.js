// index.js — ponte HTTP ⇄ WebSocket cTrader
// Incolla tutto il file così com’è

import express from 'express';
import fetch from 'node-fetch';
import WebSocket from 'ws';

const {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET,
  CTRADER_REFRESH_TOKEN: INITIAL_REFRESH,   // token solo al primo avvio
  CTRADER_ACCOUNT_ID,
  CTRADER_ENV = 'demo'                      // 'live' se usi conto reale
} = process.env;

// ✅ percorso corretto per il canale JSON
const WS_HOST =
  CTRADER_ENV === 'live'
    ? 'wss://live.ctraderapi.com:5036/stream?format=json'
    : 'wss://demo.ctraderapi.com:5036/stream?format=json';

let ws;
let accessToken;
let currentRefresh = INITIAL_REFRESH;       // token “vivo” che si aggiorna

// ───────────────────────────────────────────────
// 1. Ottiene / rinnova l’access-token
// ───────────────────────────────────────────────
async function refreshToken() {
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
    process.exit(1);                        // fa riavviare Fly senza loop
  }

  const j = JSON.parse(txt);
  accessToken    = j.access_token;
  currentRefresh = j.refresh_token || currentRefresh;

  // se expires_in manca, usa 900 s (15 min)
  const ttl = Number(j.expires_in) || 900;
  console.log('✔︎ Token ok. Next refresh in', ttl, 'sec');

  setTimeout(refreshToken, (ttl - 60) * 1000);  // rinnova 1 min prima
}

// ───────────────────────────────────────────────
// 2. Apre (o riapre) la WebSocket con cTrader
// ───────────────────────────────────────────────
function openSocket() {
  ws = new WebSocket(WS_HOST);

  ws.on('open', () => {
    console.log('✔︎ WS connected');
    ws.send(
      JSON.stringify({
        payloadType: 'ProtoOAApplicationAuthReq',    // nome corretto
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
// 3. Piccola API HTTP che Make chiamerà
// ───────────────────────────────────────────────
const app = express();
app.use(express.json());

app.post('/order', (req, res) => {
  const { symbol, side, volume, price, tp, sl, type = 'LIMIT' } = req.body;

  if (!ws || ws.readyState !== 1)
    return res.status(503).json({ error: 'socket not ready' });

  const msg = {
    payloadType: 'ProtoOAOrderNewReq',
    payload: {
      accountId:     Number(CTRADER_ACCOUNT_ID),
      symbolName:    symbol,
      orderType:     type,       // LIMIT / MARKET / STOP
      tradeSide:     side,       // BUY / SELL
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
        m.payloadType === 'ProtoOAOrderNewResp' ||
        m.payloadType === 'ProtoOAOrderNewReject'
      ) {
        ws.off('message', once);           // ascolta solo questa risposta
        if (m.payloadType.endsWith('Reject'))
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
