// index.js — NON toccare nulla qui sotto

import express from 'express';
import fetch from 'node-fetch';
import WebSocket from 'ws';

const {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET,
  CTRADER_REFRESH_TOKEN,
  CTRADER_ACCOUNT_ID,
  CTRADER_ENV = 'demo'          // scrivi 'live' solo se sei su conto reale
} = process.env;

const WS_HOST =
  CTRADER_ENV === 'live'
    ? 'wss://live.ctraderapi.com:5036'
    : 'wss://demo.ctraderapi.com:5036';

let ws, accessToken;

// — ottiene ogni 30 min un nuovo access-token
async function refreshToken() {
  const res = await fetch('https://openapi.ctrader.com/apps/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CTRADER_CLIENT_ID,
      client_secret: CTRADER_CLIENT_SECRET,
      refresh_token: CTRADER_REFRESH_TOKEN
    })
  });
  const j = await res.json();
  accessToken = j.access_token;
  setTimeout(refreshToken, (j.expires_in - 60) * 1000);
}

// — apre (e riapre) la “chat tecnica” con cTrader
function openSocket() {
  ws = new WebSocket(WS_HOST);
  ws.on('open', () => {
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
  ws.on('close', () => setTimeout(openSocket, 2000));
}

// — piccola API che Make userà
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
      orderType: type,
      tradeSide: side,
      requestedPrice: price,
      volume,
      takeProfit: tp ? { price: tp } : undefined,
      stopLoss:   sl ? { price: sl } : undefined
    }
  };

  ws.send(JSON.stringify(msg), err => {
    if (err) return res.status(500).json({ error: 'ws send error' });
    ws.once('message', data => {
      const m = JSON.parse(data.toString());
      if (m.payloadType === 'PROTOCOL_ORDER_NEW_REJ')
        return res.status(400).json({ error: m.payload.rejectReason });
      if (m.payloadType === 'PROTOCOL_ORDER_NEW_RESP')
        return res.json({ orderId: m.payload.orderId });
    });
  });
});

await refreshToken();
openSocket();
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('bridge ready on', PORT));
