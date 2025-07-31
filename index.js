// index.js — ponte HTTP ⇄ WebSocket cTrader
// (copia/incolla intero file; sostituisce il precedente)

import express from 'express';
import fetch   from 'node-fetch';
import WebSocket from 'ws';

const {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET,
  CTRADER_REFRESH_TOKEN: INITIAL_REFRESH,
  CTRADER_ACCOUNT_ID,
  CTRADER_ENV = 'demo'
} = process.env;

// ▼ 1) porta giusta (5035) e niente /stream
const WS_HOST =
  CTRADER_ENV === 'live'
    ? 'wss://live.ctraderapi.com:5035'
    : 'wss://demo.ctraderapi.com:5035';

let ws;
let accessToken;
let currentRefresh = INITIAL_REFRESH;

// --- token ---
// — Ottiene (e rinnova) un access-token
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

  const txt = await res.text();                 // leggiamo come testo
  if (!res.ok) {                                // 4xx / 5xx ⇒ fermo la VM
    console.error('Token refresh failed ⇒', res.status, txt.slice(0,200));
    process.exit(1);
  }

  const j = JSON.parse(txt);

  accessToken    = j.accessToken   ?? j.access_token;
  currentRefresh = j.refreshToken  ?? j.refresh_token ?? currentRefresh;

  // prende expiresIn (camelCase) o expires_in, altrimenti fallback 900 s
  const expires = Number(j.expiresIn ?? j.expires_in) || 900;

  console.log('✔︎ Token ok. Next refresh in', expires, 'sec');

  // minimo 5 min tra un refresh e l’altro, altrimenti Spotware → 429
  const delay = Math.max(expires - 60, 300);
  setTimeout(refreshToken, delay * 1000);
}


// --- websocket ---
function openSocket () {
  ws = new WebSocket(WS_HOST);

  ws.on('open', () => {
    console.log('✔︎ WS connected (sending auth)');
    ws.send(JSON.stringify({
      payloadType: 'PROTOCOL_APPLICATION_AUTH_REQ',
      payload    : {
        clientId   : CTRADER_CLIENT_ID,
        clientSecret: CTRADER_CLIENT_SECRET,
        accessToken
      }
    }));
  });

  // ▼ 2) logghiamo SEMPRE il primo messaggio; se è REJ usciamo
  ws.once('message', buf => {
    let msg;
    try { msg = JSON.parse(buf.toString()) } catch { msg = {} }
    console.log('WS first message →', msg);

    if (msg.payloadType === 'PROTOCOL_APPLICATION_AUTH_REJ') {
      console.error('❌  AUTH_REJ:', msg.payload.rejectReason || '(unknown)');
      process.exit(1);             // blocca il loop infinito
    }
  });

  ws.on('close', () => {
    console.warn('WS closed — reconnecting in 2 s');
    setTimeout(openSocket, 2000);
  });
  ws.on('error', err => console.error('WS error', err));
}

// --- piccola API HTTP ---
const app = express();
app.use(express.json());

app.post('/order', (req,res) => {
  const { symbol, side, volume, price, tp, sl, type='LIMIT' } = req.body;
  if (!ws || ws.readyState !== WebSocket.OPEN)
    return res.status(503).json({ error: 'socket not ready' });

  const msg = {
    payloadType: 'PROTOCOL_ORDER_NEW_REQ',
    payload: {
      accountId : Number(CTRADER_ACCOUNT_ID),
      symbolName: symbol,
      orderType : type,
      tradeSide : side,
      requestedPrice: price,
      volume,
      takeProfit: tp ? { price: tp } : undefined,
      stopLoss  : sl ? { price: sl } : undefined
    }
  };

  ws.send(JSON.stringify(msg), err => {
    if (err) return res.status(500).json({ error: 'ws send error' });
    const once = data => {
      const m = JSON.parse(data.toString());
      if (m.payloadType === 'PROTOCOL_ORDER_NEW_RESP'
       || m.payloadType === 'PROTOCOL_ORDER_NEW_REJ') {
        ws.off('message', once);
        if (m.payloadType.endsWith('REJ'))
          return res.status(400).json({ error: m.payload.rejectReason });
        return res.json({ orderId: m.payload.orderId });
      }
    };
    ws.on('message', once);
  });
});

// --- avvio ---
await refreshToken();
openSocket();
const PORT = process.env.PORT || 8080;
app.get('/', (_q,res)=>res.send('cTrader bridge running'));   // pagina test
app.listen(PORT, () => console.log('bridge ready on', PORT));
