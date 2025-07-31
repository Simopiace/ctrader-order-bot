// index.js – bridge HTTP ⇄ cTrader OpenAPI (solo JSON)
// v5: AUTH_REQ = 2100, gestione errori corretta

import express from 'express';
import fetch   from 'node-fetch';
import WebSocket from 'ws';

const {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET,
  CTRADER_REFRESH_TOKEN,
  CTRADER_ACCOUNT_ID,
  CTRADER_ENV = 'demo',
  PORT = 8080
} = process.env;

/* ---------- WS host ---------- */
const WS_HOST = CTRADER_ENV === 'live'
  ? 'wss://live.ctraderapi.com:5036'
  : 'wss://demo.ctraderapi.com:5036';

/* ---------- globals ---------- */
let ws;
let accessToken;
let refresh = CTRADER_REFRESH_TOKEN;

/* ---------- token ---------- */
async function refreshToken (delay = 0) {
  if (delay) await new Promise(r => setTimeout(r, delay));

  try {
    const r = await fetch('https://openapi.ctrader.com/apps/token', {
      method : 'POST',
      headers: { 'Content-Type':'application/x-www-form-urlencoded' },
      body   : new URLSearchParams({
        grant_type   :'refresh_token',
        client_id    : CTRADER_CLIENT_ID,
        client_secret: CTRADER_CLIENT_SECRET,
        refresh_token: refresh
      })
    });

    if (r.status === 429) {
      const w = 30_000 + Math.random()*30_000;
      console.warn('↻ 429 Too Many Requests – retry in', w/1000,'s');
      return refreshToken(w);
    }
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);

    const j = await r.json();
    accessToken = j.access_token;
    refresh     = j.refresh_token || refresh;
    const exp   = j.expires_in ?? j.expiresIn ?? 900;
    console.log('✔︎ Token ok. Expires in', exp,'sec');

    setTimeout(refreshToken, (exp-60+(Math.random()*10-5))*1000);
  } catch(e) {
    console.error('⚠︎ token refresh', e.message);
    setTimeout(refreshToken, 60_000 + Math.random()*60_000);
  }
}

/* ---------- websocket ---------- */
function openSocket () {
  ws = new WebSocket(WS_HOST);

  ws.once('open', () => {
    console.log('✔︎ WS connected – sending AUTH');
    ws.send(JSON.stringify({
      payloadType: 2100,                           // <- codice numerico
      payload    : {
        clientId    : CTRADER_CLIENT_ID,
        clientSecret: CTRADER_CLIENT_SECRET,
        accessToken
      }
    }));
  });

  ws.once('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()) } catch { msg = {} }

    console.log('▶︎ WS AUTH RES raw', msg);

    if (msg.payloadType === 2101) {                // ok
      console.log('✓ Auth ok – socket pronto');
      return;                                      // lasciamo il WS aperto
    }

    // se non è 2101 c’è un errore
    console.error('❌ Auth failed:',
      msg.payload?.errorCode, msg.payload?.description);
    process.exit(1);
  });

  ws.on('close', () => {
    console.warn('WS closed – reconnecting in 5 s');
    setTimeout(openSocket, 5000);
  });
  ws.on('error', e => console.error('WS error', e));
}

/* ---------- HTTP API ---------- */
const app = express();
app.use(express.json());

app.post('/order', (req, res) => {
  if (!ws || ws.readyState !== WebSocket.OPEN)
    return res.status(503).json({ error:'socket not ready' });

  const {
    symbolId, side:tradeSide, type='MARKET',
    volumeLots, price, tp, sl
  } = req.body;

  if (!symbolId || !tradeSide || !volumeLots)
    return res.status(400).json({ error:'symbolId, side, volumeLots required' });

  const volume = Math.round(volumeLots*100000);      // 1 lot = 100 k

  const payload = {
    ctidTraderAccountId: Number(CTRADER_ACCOUNT_ID),
    clientMsgId        : `order_${Date.now()}`,
    symbolId,
    orderType : type,
    tradeSide,
    volume
  };
  if (type==='LIMIT') payload.limitPrice = price;
  if (type==='STOP')  payload.stopPrice  = price;
  if (tp) payload.takeProfitPrice = tp;
  if (sl) payload.stopLossPrice   = sl;

  ws.send(JSON.stringify({
    payloadType: 1002,            // PROTO_OA_ORDER_NEW_REQ
    payload
  }), err => {
    if (err) return res.status(502).json({ error:'ws send', detail:err.message });

    const once = data => {
      const m = JSON.parse(data.toString());
      if (m.payloadType === 1003 || m.payloadType === 2142) {   // RES o ERROR
        ws.off('message', once);
        if (m.payloadType === 2142)
          return res.status(400).json(m.payload);
        return res.json({ orderId: m.payload.orderId });
      }
    };
    ws.on('message', once);
  });
});

/* ---------- avvio ---------- */
await refreshToken();
openSocket();
app.listen(PORT, () => console.log('bridge ready on', PORT));
