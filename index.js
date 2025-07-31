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
// — Ottiene (e rinnova) l'access-token con jitter + back-off
async function refreshToken(delay = 0) {
  // piccolo ritardo casuale (0-10 s) all'avvio o dopo un 429
  if (delay) await new Promise(r => setTimeout(r, delay));

  try {
    const res = await fetch('https://openapi.ctrader.com/apps/token', {
      method : 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body   : new URLSearchParams({
        grant_type    : 'refresh_token',
        client_id     : CTRADER_CLIENT_ID,
        client_secret : CTRADER_CLIENT_SECRET,
        refresh_token : currentRefresh
      })
    });

    if (res.status === 429) {
      const wait = 30_000 + Math.random() * 30_000;   // 30-60 s
      console.warn('↻ 429 Too Many Requests — retry in', wait / 1000, 's');
      return refreshToken(wait);                       // retry con back-off
    }

    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

    const j = await res.json();
    accessToken    = j.access_token;
    currentRefresh = j.refresh_token || currentRefresh;

    console.log('✔︎ Token ok. Expires in', j.expires_in, 'sec');

    // rinnovo 1 min prima della scadenza, con ±5 s di jitter
    const next = (j.expires_in - 60 + (Math.random() * 10 - 5)) * 1000;
    setTimeout(refreshToken, next);
  } catch (err) {
    console.error('⚠︎ Token refresh error:', err.message);
    const wait = 60_000 + Math.random() * 60_000;      // 60-120 s
    setTimeout(() => refreshToken(wait), wait);         // nuovo tentativo
  }
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
