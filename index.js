// index.js – ponte HTTP ⇄ WebSocket cTrader (versione 31 lug 25 / h16:40)

import express   from 'express';
import fetch     from 'node-fetch';
import WebSocket from 'ws';

/* ------------------------------------------------------------------ */
/* ENV                                                                 */
/* ------------------------------------------------------------------ */
const {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET,              // serve solo per il refresh-token
  CTRADER_REFRESH_TOKEN: INITIAL_REFRESH,
  CTRADER_ACCOUNT_ID,
  CTRADER_ENV = 'demo'
} = process.env;

const WS_HOST =
  CTRADER_ENV === 'live'
    ? 'wss://live.ctraderapi.com:5036'
    : 'wss://demo.ctraderapi.com:5036';

let ws;
let accessToken;
let currentRefresh = INITIAL_REFRESH;

/* ------------------------------------------------------------------ */
/* TOKEN                                                               */
/* ------------------------------------------------------------------ */
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

    if (res.status === 429) {
      const wait = 30_000 + Math.random()*30_000;
      console.warn('↻ 429 Too Many Requests – retry in', (wait/1000).toFixed(1),'s');
      return refreshToken(wait);
    }
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

    const j = await res.json();
    accessToken    = j.access_token;
    currentRefresh = j.refresh_token || currentRefresh;
    const expires  = j.expires_in ?? j.expiresIn ?? 900;
    console.log('✔︎ Token ok. Expires in', expires,'sec');

    const next = (expires - 60 + (Math.random()*10 - 5))*1000;
    setTimeout(refreshToken, next);
  }
  catch (err) {
    console.error('⚠︎ Token refresh error:', err.message);
    const wait = 60_000 + Math.random()*60_000;
    setTimeout(()=>refreshToken(wait), wait);
  }
}

/* ------------------------------------------------------------------ */
/* WEBSOCKET                                                           */
/* ------------------------------------------------------------------ */
function openSocket () {
  ws = new WebSocket(WS_HOST);

  ws.on('open', () => {
    console.log('✔︎ WS connected (sending auth)');
    ws.send(JSON.stringify({
      payloadType: 2100,                 // ApplicationAuthReq
      payload    : {
        clientId   : CTRADER_CLIENT_ID,
        accessToken                      // **niente clientSecret!**
      }
    }));
  });

  ws.once('message', buf => {
    const raw = buf.toString();
    let msg; try { msg = JSON.parse(raw) } catch { msg = {} }
    console.log('▶︎ WS AUTH RES raw', raw);

    if (msg.payloadType === 2101 && msg.payload?.status === 'OK') {
      console.log('✔︎  Auth OK – streaming ready');
      // se serve, qui potresti sottoscrivere feed, ecc.
    } else {
      console.error('❌  Auth failed:', msg.payload?.status, msg.payload?.description||'');
      // niente exit: riprova tra 30 s
      setTimeout(openSocket, 30_000);
    }
  });

  ws.on('close', () => {
    console.warn('WS closed – reconnecting in 5 s');
    setTimeout(openSocket, 5_000);
  });
  ws.on('error', err => console.error('WS error', err));
}

/* ------------------------------------------------------------------ */
/* HTTP (per Make)                                                     */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json());

app.post('/order', (req,res) => {
  const { symbol, side, volume, price, tp, sl, type='LIMIT' } = req.body;
  if (!ws || ws.readyState !== WebSocket.OPEN)
    return res.status(503).json({ error: 'socket not ready' });

  const msg = {
    payloadType: 2120,                         // OrderNewReq
    payload: {
      accountId     : Number(CTRADER_ACCOUNT_ID),
      symbolName    : symbol,
      orderType     : type,
      tradeSide     : side,
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
      if ([2121,2122].includes(m.payloadType)) {
        ws.off('message', once);
        if (m.payloadType === 2122)
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
await refreshToken();
openSocket();

const PORT = process.env.PORT || 8080;
app.get('/', (_q,res)=>res.send('cTrader bridge running'));
app.listen(PORT, ()=>console.log('bridge ready on', PORT));
