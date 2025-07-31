// index.js — ponte HTTP ⇄ WebSocket cTrader
// (copia/incolla intero file; sostituisce il precedente)

import express   from 'express';
import fetch     from 'node-fetch';
import WebSocket from 'ws';

const {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET,
  CTRADER_REFRESH_TOKEN: INITIAL_REFRESH,
  CTRADER_ACCOUNT_ID,
  CTRADER_ENV = 'demo'
} = process.env;

// ▼ 1) porta giusta (5036) e niente /stream
const WS_HOST =
  CTRADER_ENV === 'live'
    ? 'wss://live.ctraderapi.com:5036'
    : 'wss://demo.ctraderapi.com:5036';

let ws;
let accessToken;
let currentRefresh = INITIAL_REFRESH;

/* ------------------------------------------------------------------ */
/* TOKEN                                                              */
/* ------------------------------------------------------------------ */
// — Ottiene e rinnova l’access-token con jitter + back-off
async function refreshToken (delay = 0) {
  if (delay) await new Promise(r => setTimeout(r, delay));       // ritardo iniziale / back-off

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

    // — troppe richieste → aspetta 30-60 s e riprova
    if (res.status === 429) {
      const wait = 30_000 + Math.random() * 30_000;
      console.warn('↻ 429 Too Many Requests — retry in', (wait/1000).toFixed(1), 's');
      return refreshToken(wait);
    }

    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

    const j = await res.json();
    accessToken    = j.access_token;
    currentRefresh = j.refresh_token || currentRefresh;

    // demo → expiresIn (camelCase) | live → expires_in (snake_case)
    const expires = j.expires_in ?? j.expiresIn ?? 900;
    console.log('✔︎ Token ok. Expires in', expires, 'sec');

    // rinnovo 1 min prima della scadenza, ±5 s di jitter
    const next = (expires - 60 + (Math.random()*10 - 5)) * 1000;
    setTimeout(refreshToken, next);
  }
  catch (err) {
    console.error('⚠︎ Token refresh error:', err.message);
    const wait = 60_000 + Math.random() * 60_000;               // 60-120 s
    setTimeout(() => refreshToken(wait), wait);
  }
}

/* ------------------------------------------------------------------ */
/* WEBSOCKET                                                          */
/* ------------------------------------------------------------------ */
function openSocket () {
  ws = new WebSocket(WS_HOST);

  ws.on('open', () => {
    console.log('✔︎ WS connected (sending auth)');
    ws.send(JSON.stringify({
      payloadType: 'APPLICATION_AUTH_REQ',
      payload: {
        clientId    : CTRADER_CLIENT_ID,
        clientSecret: CTRADER_CLIENT_SECRET,
        accessToken
      }
    }));
  });

  // primo messaggio = esito autenticazione
  ws.once('message', buf => {
    let msg;
    try { msg = JSON.parse(buf.toString()) } catch { msg = {} }
    console.log('▶︎ WS AUTH RES:', msg.payload?.status ?? msg.payloadType, msg.payload?.description || '');
    if (msg.payloadType === 'PROTOCOL_APPLICATION_AUTH_REJ') {
      console.error('❌  AUTH_REJ:', msg.payload.rejectReason || '(unknown)');
      process.exit(1);                                         // evita loop infinito
    }
  });

  ws.on('close', () => {
    console.warn('WS closed — reconnecting in 2 s');
    setTimeout(openSocket, 2000);
  });

  ws.on('error', err => console.error('WS error', err));
}

/* ------------------------------------------------------------------ */
/* PICCOLA API HTTP (Make la userà)                                   */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json());

app.post('/order', (req, res) => {
  const { symbol, side, volume, price, tp, sl, type = 'LIMIT' } = req.body;
  if (!ws || ws.readyState !== WebSocket.OPEN)
    return res.status(503).json({ error: 'socket not ready' });

  const msg = {
    payloadType: 'PROTOCOL_ORDER_NEW_REQ',
    payload: {
      accountId     : Number(CTRADER_ACCOUNT_ID),
      symbolName    : symbol,
      orderType     : type,   // LIMIT / MARKET / STOP
      tradeSide     : side,   // BUY / SELL
      requestedPrice: price,
      volume,
      takeProfit    : tp ? { price: tp } : undefined,
      stopLoss      : sl ? { price: sl } : undefined
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

/* ------------------------------------------------------------------ */
/* AVVIO                                                               */
/* ------------------------------------------------------------------ */
await refreshToken();      // token all’avvio
openSocket();              // apre (e riapre) il WS

const PORT = process.env.PORT || 8080;
app.get('/', (_q, res) => res.send('cTrader bridge running'));
app.listen(PORT, () => console.log('bridge ready on', PORT));
