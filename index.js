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

    // troppe richieste → attendo 30-60 s e riprovo
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

    // rinnovo 1 min prima, ±5 s di jitter
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
      clientMsgId : 'auth_'+Date.now(),   // ID univoco che ci tornerà nel RES
      payloadType : 2100,                 // APPLICATION_AUTH_REQ
      payload     : {
        clientId    : CTRADER_CLIENT_ID,
        clientSecret: CTRADER_CLIENT_SECRET,
        accessToken
      }
    };
    ws.send(JSON.stringify(authReq));
  });

  // primo messaggio = esito autenticazione
  ws.once('message', buf => {
    let msg; try { msg = JSON.parse(buf.toString()) } catch { msg = {} }
    console.log('▶︎ WS AUTH RES raw', msg);

    if (msg.payloadType === 2101) {               // APPLICATION_AUTH_RES
      console.log('✔︎ Auth ok – socket pronto');
      return;                                     // tutto bene
    }

    // qualsiasi altra cosa = errore
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
/* MINI API HTTP (per Make / Zapier …)                                 */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json());

app.post('/order', (req, res) => {
  const { symbol, side, volume, price, tp, sl, type='LIMIT' } = req.body;

  if (!ws || ws.readyState !== WebSocket.OPEN)
    return res.status(503).json({ error: 'socket not ready' });

  const clientMsgId = 'ord_'+Date.now();

  const orderReq = {
    clientMsgId,
    payloadType : 2120,                       // ORDER_NEW_REQ
    payload     : {
      accountId     : Number(CTRADER_ACCOUNT_ID),
      symbolName    : symbol,
      orderType     : type,                   // LIMIT / MARKET / STOP
      tradeSide     : side,                   // BUY / SELL
      requestedPrice: price,
      volume,
      takeProfit    : tp ? { price: tp } : undefined,
      stopLoss      : sl ? { price: sl } : undefined
    }
  };

  ws.send(JSON.stringify(orderReq), err => {
    if (err) return res.status(500).json({ error: 'ws send error' });

    const once = data => {
      const m = JSON.parse(data.toString());
      if (m.clientMsgId !== clientMsgId) return;   // non è la nostra risposta

      ws.off('message', once);

      if (m.payloadType === 2121)                 // ORDER_NEW_RES
        return res.json({ orderId: m.payload.orderId });

      if (m.payloadType === 2142)                 // generic REJ
        return res.status(400).json({ error: m.payload.description });

      // caso imprevisto
      res.status(500).json({ error: 'unexpected reply', raw: m });
    };
    ws.on('message', once);
  });
});

/* ------------------------------------------------------------------ */
/* AVVIO                                                               */
/* ------------------------------------------------------------------ */
await refreshToken();      // ottiene il primo access-token
openSocket();              // apre (e riapre) il WS

app.get('/', (_q,res)=>res.send('cTrader bridge running'));
app.listen(PORT, () => console.log('bridge ready on', PORT));
