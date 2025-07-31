// index.js  – ponte HTTP ⇄ WebSocket per cTrader Open API (JSON)
// richiede Node ≥ 18 con "type":"module" in package.json

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
  CTRADER_ENV = 'demo',          // 'demo' | 'live'
  PORT = 8080
} = process.env;

if (!CTRADER_CLIENT_ID || !CTRADER_CLIENT_SECRET || !INITIAL_REFRESH || !CTRADER_ACCOUNT_ID) {
  console.error('❌  Mancano variabili d’ambiente obbligatorie.');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* COSTANTI                                                           */
/* ------------------------------------------------------------------ */
const WS_HOST =
  CTRADER_ENV === 'live'
    ? 'wss://live.ctraderapi.com:5036'   // JSON
    : 'wss://demo.ctraderapi.com:5036';  // JSON

/* ------------------------------------------------------------------ */
/* TOKEN                                                              */
/* ------------------------------------------------------------------ */
let accessToken;
let currentRefresh = INITIAL_REFRESH;

async function refreshToken (delay = 0) {
  if (delay) await new Promise(r => setTimeout(r, delay));       // jitter / back-off

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

    if (res.status === 429) {
      const wait = 30_000 + Math.random()*30_000;
      console.warn('↻ 429 Too Many Requests – retry in', (wait/1000).toFixed(1), 's');
      return refreshToken(wait);
    }

    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

    const j = await res.json();
    accessToken    = j.access_token;
    currentRefresh = j.refresh_token || currentRefresh;

    const expires = j.expires_in ?? j.expiresIn ?? 900;
    console.log('✔︎ Token ok. Expires in', expires, 'sec');

    const next = (expires - 60 + (Math.random()*10 - 5)) * 1000;
    setTimeout(refreshToken, next);
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
    const authReq = {
      clientMsgId : 'auth_'+Date.now(),
      payloadType : 2100,                 // APPLICATION_AUTH_REQ
      payload     : {
        clientId    : CTRADER_CLIENT_ID,
        clientSecret: CTRADER_CLIENT_SECRET,
        accessToken
      }
    };
    ws.send(JSON.stringify(authReq));
  });

  ws.once('message', buf => {
    let msg; try { msg = JSON.parse(buf.toString()) } catch { msg = {} }
    console.log('▶︎ WS AUTH RES raw', msg);

    if (msg.payloadType === 2101) {               // APPLICATION_AUTH_RES
      console.log('✔︎ Auth ok – socket pronto');
      return;
    }

    const code = msg.payload?.errorCode;
    const desc = msg.payload?.description || '(unknown)';
    console.error('❌ Auth failed:', code, desc);
    ws.close();
  });

  ws.on('close', () => {
    console.warn('WS closed – reconnecting in 5 s');
    setTimeout(openSocket, 5000);
  });

  ws.on('error', err => console.error('WS error', err));
}

/* ------------------------------------------------------------------ */
/* MINI API HTTP (per Make / Zapier …)                                */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json());

app.post('/order', (req, res) => {
  const {
    symbolId,                // ID numerico del simbolo
    side,                    // "BUY" | "SELL"
    volume,                  // in cent-lots (es. 100 000 = 1 lot)
    price,                   // numero o {limit,stop} per STOP_LIMIT
    tp, sl,                  // take-profit / stop-loss price
    type = 'LIMIT'           // "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT"
  } = req.body;

  if (!ws || ws.readyState !== WebSocket.OPEN)
    return res.status(503).json({ error: 'socket not ready' });

  const clientMsgId = 'ord_'+Date.now();

  // mappa prezzi in base al tipo di ordine
  const priceFields = (
    type === 'MARKET'      ? {} :
    type === 'LIMIT'       ? { limitPrice: Number(price) } :
    type === 'STOP'        ? { stopPrice : Number(price) } :
    /* STOP_LIMIT */         { limitPrice: Number(price?.limit), stopPrice: Number(price?.stop) }
  );

  const orderReq = {
    clientMsgId,
    payloadType : 62,                       // ProtoOANewOrderReq
    payload     : {
      ctidTraderAccountId: Number(CTRADER_ACCOUNT_ID),
      symbolId          : Number(symbolId),
      orderType         : type,             // enum string
      tradeSide         : side,
      volume            : Number(volume),
      ...priceFields,
      ...(tp && { takeProfit: { price: Number(tp) } }),
      ...(sl && { stopLoss  : { price: Number(sl) } })
    }
  };

  ws.send(JSON.stringify(orderReq), err => {
    if (err) return res.status(500).json({ error: 'ws send error' });

    const once = data => {
      let m; try { m = JSON.parse(data.toString()) } catch { m = {} }
      if (m.clientMsgId !== clientMsgId) return;   // risposta di un altro messaggio

      ws.off('message', once);

      if (m.payloadType === 63)                   // ProtoOANewOrderRes
        return res.json({ orderId: m.payload?.orderId });

      if (m.payloadType === 39)                   // ProtoOAErrorRes
        return res.status(400).json({ error: m.payload?.description });

      res.status(500).json({ error: 'unexpected reply', raw: m });
    };
    ws.on('message', once);
  });
});

/* ------------------------------------------------------------------ */
/* AVVIO                                                              */
/* ------------------------------------------------------------------ */
await refreshToken();      // ottiene il primo access-token
openSocket();              // apre (e riapre) il WS

app.get('/', (_q,res)=>res.send('cTrader bridge running'));
app.listen(PORT, () => console.log('bridge ready on', PORT));
