// index.js — ponte HTTP ⇄ WebSocket cTrader
// Copia e incolla tutto, non modificare altro

import express from 'express';
import fetch from 'node-fetch';
import WebSocket from 'ws';

const {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET,
  CTRADER_REFRESH_TOKEN: INITIAL_REFRESH, // <— prende il token solo all’avvio
  CTRADER_ACCOUNT_ID,
  CTRADER_ENV = 'demo'                     // scrivi 'live' se sei su conto reale
} = process.env;

const WS_HOST =
  CTRADER_ENV === 'live'
    ? 'wss://live.ctraderapi.com:5036'
    : 'wss://demo.ctraderapi.com:5036';

let ws;
let accessToken;
let currentRefresh = INITIAL_REFRESH;      // <— diventa variabile “viva”

// — Ottiene (e rinnova) un access-token: se Spotware restituisce
//   anche un refresh_token nuovo, lo salviamo in currentRefresh.
async function refreshToken() {
  const res = await fetch('https://openapi.ctrader.com/apps/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CTRADER_CLIENT_ID,
      client_secret: CTRADER_CLIENT_SECRET,
      refresh_token: currentRefresh          // <— usa SEMPRE l’ultimo valido
    })
  });

  const txt = await res.text();             // leggiamo come testo
  if (!res.ok) {
    console.error('Token refresh failed ⇒', res.status, txt.slice(0, 200));
    process.exit(1);                        // fa riavviare Fly, niente loop infinito
  }

  const j = JSON.parse(txt);                // ora è JSON sicuro
  accessToken   = j.access_token;
  currentRefresh = j.refresh_token || currentRefresh; // <— aggiorna!
  console.log('✔︎ Token ok. Expires in', j.expires_in, 'sec');

  // rinnova 1 min prima della scadenza
  setTimeout(refreshToken, (j.expires_in - 60) * 1000);
}

// — Apre (o riapre) la “chat tecnica” con cTrader
function openSocket() {
  ws = new WebSocket(WS_HOST);

  ws.on('open', () => {
    console.log('✔︎ WS connected');
    ws.send(
      JSON.stringify({
        payloadType: 'PROTOCOL_APPLICATION_AUTH_REQ',
        payload: {
          clientId: CTRADER_CLIENT_ID,
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

// — Piccola API che Make userà
const app = express();
app.use(express.json());

app.post('/order', (req, res) => {
  const { symbol, side, volume, price, tp, sl, type = 'LIMIT' } = req.body;
  if (!ws || ws.readyState !== 1)
    return res.status(503).json({ error: 'socket not ready' });

  const msg = {
    payloadType: 'PROTOCOL_ORDER_NEW_REQ',
    payload: {
      accountId: Number(CTRADER_ACCOUNT_ID),
      symbolName: symbol,
      orderType: type,          // LIMIT / MARKET / STOP
      tradeSide: side,          // BUY / SELL
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
        ws.off('message', once);            // ascolta una sola risposta
        if (m.payloadType.endsWith('REJ'))
          return res.status(400).json({ error: m.payload.rejectReason });
        return res.json({ orderId: m.payload.orderId });
      }
    };
    ws.on('message', once);
  });
});

// — Avvio
await refreshToken();
openSocket();
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('bridge ready on', PORT));
