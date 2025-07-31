// index.js – Bridge HTTP ⇄ WebSocket per cTrader (JSON)
// v4: payloadType = string, mapping simbolo → id, fix AUTH

import express   from 'express';
import fetch     from 'node-fetch';
import WebSocket from 'ws';

const {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET,
  CTRADER_REFRESH_TOKEN,
  CTRADER_ACCOUNT_ID,
  CTRADER_ENV = 'demo',
  PORT = 8080
} = process.env;

// host WS (porta 5036)
const WS_HOST = CTRADER_ENV === 'live'
  ? 'wss://live.ctraderapi.com:5036'
  : 'wss://demo.ctraderapi.com:5036';

let ws;
let accessToken;
let refresh = CTRADER_REFRESH_TOKEN;

/* ------------------------------------------------------------------ */
/* TOKEN                                                              */
/* ------------------------------------------------------------------ */
async function refreshToken(delay = 0) {
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
      console.warn('↻ 429 Too Many Requests – retry in', (w/1000).toFixed(1), 's');
      return refreshToken(w);
    }
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);

    const j = await r.json();
    accessToken = j.access_token;
    refresh     = j.refresh_token || refresh;
    const exp   = j.expires_in ?? j.expiresIn ?? 900;
    console.log('✔︎ Token ok. Expires in', exp, 'sec');

    setTimeout(refreshToken, (exp - 60 + (Math.random()*10-5))*1000);
  } catch(e) {
    console.error('⚠︎ Token refresh error', e.message);
    setTimeout(refreshToken, 60_000 + Math.random()*60_000);
  }
}

/* ------------------------------------------------------------------ */
/* WEBSOCKET                                                          */
/* ------------------------------------------------------------------ */
function openSocket() {
  ws = new WebSocket(WS_HOST);

  ws.on('open', () => {
    console.log('✔︎ WS connected – sending AUTH');
    ws.send(JSON.stringify({
      /* ⇣ STRING! */
      payloadType: 'PROTO_OA_APPLICATION_AUTH_REQ',
      payload: {
        clientId    : CTRADER_CLIENT_ID,
        clientSecret: CTRADER_CLIENT_SECRET,
        accessToken
      }
    }));
  });

  ws.once('message', buf => {
    const msg = JSON.parse(buf.toString());
    console.log('▶︎ WS AUTH RES raw', msg);

    if (msg.payloadType === 'PROTO_OA_ERROR_RES') {
      console.error('❌ Auth failed:', msg.payload.errorCode, msg.payload.description);
      process.exit(1);
    }
    console.log('✓ Auth ok – socket pronto');
  });

  ws.on('close', () => {
    console.warn('WS closed – reconnecting in 5 s');
    setTimeout(openSocket, 5000);
  });
  ws.on('error', e => console.error('WS error', e));
}

/* ------------------------------------------------------------------ */
/* EXPRESS API                                                         */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json());

/**
 * POST /order
 * body:
 * {
 *   "symbolId": 1,            // obbligatorio
 *   "side": "BUY",            // BUY | SELL
 *   "type": "MARKET",         // MARKET | LIMIT | STOP
 *   "volumeLots": 0.5,        // lotti
 *   "price": 1.1050,          // solo LIMIT/STOP
 *   "tp": 1.11,
 *   "sl": 1.10
 * }
 */
app.post('/order', (req, res) => {
  if (!ws || ws.readyState !== WebSocket.OPEN)
    return res.status(503).json({ error: 'socket not ready' });

  const {
    symbolId,
    side: tradeSide,
    type: orderType = 'MARKET',
    volumeLots,
    price, tp, sl
  } = req.body;

  if (!symbolId || !tradeSide || !volumeLots)
    return res.status(400).json({ error:'symbolId, side, volumeLots required' });

  const volume = Math.round(volumeLots * 100000); // lotti → centesimi

  const payload = {
    ctidTraderAccountId: Number(CTRADER_ACCOUNT_ID),
    clientMsgId        : `order_${Date.now()}`,
    symbolId,
    orderType,
    tradeSide,
    volume
  };

  if (orderType === 'LIMIT') payload.limitPrice      = price;
  if (orderType === 'STOP')  payload.stopPrice       = price;
  if (tp) payload.takeProfitPrice = tp;
  if (sl) payload.stopLossPrice   = sl;

  const msg = {
    payloadType: 'PROTO_OA_ORDER_NEW_REQ',
    payload
  };

  console.log('→ NEW_ORDER_REQ', JSON.stringify(payload));
  ws.send(JSON.stringify(msg), err => {
    if (err) return res.status(500).json({ error:'ws send error', detail: err.message });

    const once = data => {
      const m = JSON.parse(data.toString());
      if (m.payloadType === 'PROTO_OA_ORDER_NEW_RES'
       || m.payloadType === 'PROTO_OA_ERROR_RES') {
        ws.off('message', once);
        if (m.payloadType === 'PROTO_OA_ERROR_RES')
          return res.status(400).json(m.payload);
        return res.json({ orderId: m.payload.orderId });
      }
    };
    ws.on('message', once);
  });
});

/* util: GET /symbols?name=EURUSD */
app.get('/symbols', async (req, res) => {
  try {
    const r = await fetch(`https://api.ctrader.com/v2/symbols?name=${encodeURIComponent(req.query.name||'')}`);
    res.json((await r.json()).data || []);
  } catch(e) {
    res.status(502).json({ error:'symbols fetch', detail:e.message });
  }
});

/* ------------------------------------------------------------------ */
await refreshToken();
openSocket();
app.listen(PORT, () => console.log('bridge ready on', PORT));
