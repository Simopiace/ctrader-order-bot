// index.js – Bridge HTTP ⇄ WebSocket (cTrader Open API JSON)
// v3 – ordine conforme ai nomi Protobuf

import express   from 'express';
import fetch     from 'node-fetch';
import WebSocket from 'ws';

const {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET,
  CTRADER_REFRESH_TOKEN,
  CTRADER_ACCOUNT_ID,
  CTRADER_ENV = 'demo',
  PORT = 8080,
} = process.env;

// host WS (porta 5036, no /stream)
const WS_HOST = CTRADER_ENV === 'live'
  ? 'wss://live.ctraderapi.com:5036'
  : 'wss://demo.ctraderapi.com:5036';

let ws;
let accessToken;
let refresh = CTRADER_REFRESH_TOKEN;

/* ------------------------------------------------------------------ */
/* TOKEN                                                              */
/* ------------------------------------------------------------------ */
async function refreshToken (delay = 0) {
  if (delay) await new Promise(r => setTimeout(r, delay));

  try {
    const res = await fetch('https://openapi.ctrader.com/apps/token', {
      method : 'POST',
      headers: { 'Content-Type':'application/x-www-form-urlencoded' },
      body   : new URLSearchParams({
        grant_type   :'refresh_token',
        client_id    : CTRADER_CLIENT_ID,
        client_secret: CTRADER_CLIENT_SECRET,
        refresh_token: refresh,
      })
    });

    if (res.status === 429) {
      const w = 30_000 + Math.random()*30_000;
      console.warn('↻ 429 Too Many Requests – retry in', (w/1000).toFixed(1),'s');
      return refreshToken(w);
    }
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

    const j = await res.json();
    accessToken = j.access_token;
    refresh     = j.refresh_token || refresh;
    const exp   = j.expires_in ?? j.expiresIn ?? 900;
    console.log('✔︎ Token ok. Expires in', exp,'sec');

    setTimeout(refreshToken, (exp-60+Math.random()*10-5)*1000);
  } catch(err) {
    console.error('⚠︎ Token refresh error:', err.message);
    setTimeout(refreshToken, 60_000+Math.random()*60_000);
  }
}

/* ------------------------------------------------------------------ */
/* WEBSOCKET                                                          */
/* ------------------------------------------------------------------ */
function openSocket () {
  ws = new WebSocket(WS_HOST);

  ws.on('open', () => {
    console.log('✔︎ WS connected – sending AUTH');
    ws.send(JSON.stringify({
      payloadType: 2101,                        // ProtoOAPayloadType.APPLICATION_AUTH_REQ
      payload: {
        clientId    : CTRADER_CLIENT_ID,
        clientSecret: CTRADER_CLIENT_SECRET,
        accessToken,
      }
    }));
  });

  ws.once('message', buf => {
    const msg = JSON.parse(buf.toString());
    console.log('▶︎ WS AUTH RES raw', msg);
    if (msg.payload?.errorCode) {
      console.error('❌ Auth failed:', msg.payload.errorCode, msg.payload.description);
      process.exit(1);
    } else {
      console.log('✓ Auth ok – socket pronto');
    }
  });

  ws.on('close', () => {
    console.warn('WS closed – reconnecting in 5 s');
    setTimeout(openSocket, 5000);
  });
  ws.on('error', err => console.error('WS error', err));
}

/* ------------------------------------------------------------------ */
/* EXPRESS API for Make/Integromat                                    */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json());

/**
 * POST /order
 * Body example:
 * {
 *   "symbolId": 1,
 *   "side": "BUY",
 *   "type": "MARKET",          // MARKET | LIMIT | STOP
 *   "volumeLots": 1,           // lots (e.g. 1 = 100 000)
 *   "price": 1.1050,           // only for LIMIT/STOP
 *   "tp": 1.11,
 *   "sl": 1.10
 * }
 */
app.post('/order', (req, res) => {
  if (!ws || ws.readyState !== WebSocket.OPEN)
    return res.status(503).json({ error: 'socket not ready' });

  const {
    symbolId,
    side       : tradeSide,
    type       : orderType = 'MARKET',
    volumeLots,
    price,
    tp,
    sl,
  } = req.body;

  if (!symbolId || !tradeSide || !volumeLots)
    return res.status(400).json({ error:'symbolId, side, volumeLots are required' });

  const volume = Math.round(Number(volumeLots) * 100000); // lots → cents

  const payload = {
    ctidTraderAccountId: Number(CTRADER_ACCOUNT_ID),
    clientMsgId        : `order_${Date.now()}`,
    symbolId           : Number(symbolId),
    orderType,
    tradeSide,
    volume,
  };

  if (orderType === 'LIMIT') payload.limitPrice       = price;
  if (orderType === 'STOP')  payload.stopPrice        = price;
  if (tp)                    payload.takeProfitPrice  = tp;
  if (sl)                    payload.stopLossPrice    = sl;

  const msg = { payloadType: 2106, payload };          // NEW_ORDER_REQ = 2106

  console.log('→ NEW_ORDER_REQ', JSON.stringify(payload));
  ws.send(JSON.stringify(msg), err => {
    if (err) return res.status(500).json({ error:'ws send error', detail: err.message });

    // attesa di RESP / REJ
    const once = data => {
      const m = JSON.parse(data.toString());
      if (m.payloadType === 2107 || m.payloadType === 2108) { // RESP / REJ
        ws.off('message', once);
        if (m.payloadType === 2108)
          return res.status(400).json({ error: m.payload.errorCode, description: m.payload.description });
        return res.json({ orderId: m.payload.orderId });
      }
    };
    ws.on('message', once);
  });
});

/**
 * GET /symbols?name=EURUSD (utility, optional)
 * – torna la lista di simboli che contengono la stringa
 */
app.get('/symbols', async (req, res) => {
  try {
    const r = await fetch(`https://api.ctrader.com/v2/symbols?name=${encodeURIComponent(req.query.name||'')}`);
    const j = await r.json();
    res.json(j.data || []);
  } catch(err) {
    res.status(502).json({ error:'symbols fetch error', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* STARTUP                                                            */
/* ------------------------------------------------------------------ */
await refreshToken();
openSocket();
app.listen(PORT, () => console.log('bridge ready on', PORT));
