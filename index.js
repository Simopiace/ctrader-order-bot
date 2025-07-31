// index.js  – ponte HTTP ⇄ WebSocket per cTrader Open API (JSON)
// Node ≥ 18 con "type": "module" in package.json

import express   from 'express';
import fetch     from 'node-fetch';
import WebSocket from 'ws';

/* ------------------------------------------------------------------ */
/* ENV                                                                */
/* ------------------------------------------------------------------ */
const {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET,
  CTRADER_REFRESH_TOKEN: INITIAL_REFRESH,
  CTRADER_ACCOUNT_ID,
  CTRADER_ENV = 'demo',   // 'demo' | 'live'
  PORT         = 8080
} = process.env;

if (!CTRADER_CLIENT_ID || !CTRADER_CLIENT_SECRET || !INITIAL_REFRESH || !CTRADER_ACCOUNT_ID) {
  console.error('❌  Variabili d’ambiente mancanti.');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* COSTANTI                                                           */
/* ------------------------------------------------------------------ */
const WS_HOST =
  CTRADER_ENV === 'live'
    ? 'wss://live.ctraderapi.com:5036'     // endpoint JSON
    : 'wss://demo.ctraderapi.com:5036';

/* ------------------------------------------------------------------ */
/* TOKEN (OAuth2)                                                     */
/* ------------------------------------------------------------------ */
let accessToken;
let currentRefresh = INITIAL_REFRESH;

async function refreshToken (delay = 0) {
  if (delay) await new Promise(r => setTimeout(r, delay));

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

    if (res.status === 429) {                       // rate-limit
      const wait = 30_000 + Math.random()*30_000;
      console.warn('↻ 429 Too Many Requests – retry in', (wait/1000).toFixed(1), 's');
      return refreshToken(wait);
    }
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

    const j = await res.json();
    accessToken    = j.access_token;
    currentRefresh = j.refresh_token || currentRefresh;

    const ttl = j.expires_in ?? j.expiresIn ?? 900;
    console.log('✔︎ Token ok – scade in', ttl, 's');

    setTimeout(refreshToken, (ttl - 60 + (Math.random()*10 - 5))*1000); // rinnovo
  }
  catch (err) {
    console.error('⚠︎ Token refresh error:', err.message);
    const wait = 60_000 + Math.random()*60_000;
    setTimeout(() => refreshToken(wait), wait);
  }
}

/* ------------------------------------------------------------------ */
/* WEBSOCKET                                                          */
/* ------------------------------------------------------------------ */
let ws;

function openSocket () {
  ws = new WebSocket(WS_HOST);

  ws.on('open', () => {
    console.log('✔︎ WS connected – sending AUTH');
    ws.send(JSON.stringify({
      clientMsgId : 'auth_'+Date.now(),
      payloadType : 2100,              // APPLICATION_AUTH_REQ
      payload     : {
        clientId    : CTRADER_CLIENT_ID,
        clientSecret: CTRADER_CLIENT_SECRET,
        accessToken
      }
    }));
  });

  // primo messaggio = AUTH RES
  ws.once('message', buf => {
    let msg; try { msg = JSON.parse(buf.toString()) } catch { msg = {} }
    console.log('▶︎ WS AUTH RES', msg);

    if (msg.payloadType === 2101) {     // APPLICATION_AUTH_RES
      console.log('✔︎ Auth ok – socket pronto');
      return;
    }
    console.error('❌ Auth failed:', msg.payload?.errorCode, msg.payload?.description);
    ws.close();
  });

  ws.on('close', () => {
    console.warn('WS closed – reconnect in 5 s');
    setTimeout(openSocket, 5000);
  });

  ws.on('error', err => console.error('WS error', err.message));
}

/* ------------------------------------------------------------------ */
/* MINI API HTTP (es. Make/Zapier)                                    */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json());

/*
   POST /order
   {
     "symbolId": 1          // OPPURE "symbol": "EURUSD"
     "side": "BUY(1)"|"SELL(2)",
     "volume": 100000,      // cent-units (100 000 = 1 lot standard)
     "price": 1.23456,      // richiesto per LIMIT / STOP
     "tp": 1.24000,         // opzionale
     "sl": 1.23000,         // opzionale
     "type": "1"|"2"|"3" (default 1)
   }
*/
app.post('/order', (req, res) => {
  const {
    symbolId,          // INT – preferibile
    symbol,            // stringa – alternativa
    side,
    volume,
    price,
    tp,
    sl,
    type = '1'
  } = req.body || {};

  if (!ws || ws.readyState !== WebSocket.OPEN)
    return res.status(503).json({ error: 'socket not ready' });

  // validazione minima
  if (!(symbolId || symbol) || !side || !volume || (type !== '1' && price === undefined))
    return res.status(400).json({ error: 'missing parameters' });

  const clientMsgId = 'ord_'+Date.now();

  const orderReq = {
    clientMsgId,
    payloadType : 2106,                       // ORDER_NEW_REQ (JSON)
    payload     : {
      ctidTraderAccountId      : Number(CTRADER_ACCOUNT_ID),
      ...(symbolId ? { symbolId: Number(symbolId) } : { symbolName: symbol }),
      orderType      : type,                  // MARKET | LIMIT | STOP
      tradeSide      : side,                  // BUY   | SELL
      volume         : Number(volume),
      ...(type !== '1' ? { requestedPrice: Number(price) } : {}),
      ...(tp !== undefined ? { takeProfit: { price: Number(tp) } } : {}),
      ...(sl !== undefined ? { stopLoss  : { price: Number(sl) } } : {})
    }
  };

  ws.send(JSON.stringify(orderReq), err => {
    if (err) return res.status(500).json({ error: 'ws send error' });

    const listener = data => {
      let m; try { m = JSON.parse(data.toString()) } catch { m = {} }
      if (m.clientMsgId !== clientMsgId) return;   // non nostra risposta

      ws.off('message', listener);

      if (m.payloadType === 2121)                 // ORDER_NEW_RES
        return res.json({ orderId: m.payload?.orderId });

      if (m.payloadType === 2142)                 // ERROR_RES
        return res.status(400).json({ error: m.payload?.description });

      res.status(500).json({ error: 'unexpected reply', raw: m });
    };
    ws.on('message', listener);
  });
});

/* ------------------------------------------------------------------ */
/* BOOT                                                                */
/* ------------------------------------------------------------------ */
await refreshToken();   // primo access-token
openSocket();           // WS con reconnessione

app.get('/', (_q, r) => r.send('cTrader bridge running'));
app.listen(PORT, () => console.log('bridge ready on', PORT));
