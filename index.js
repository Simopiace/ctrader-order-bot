// index.js – ponte HTTP ⇄ WebSocket cTrader
// sostituisce COMPLETAMENTE il precedente

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
  CTRADER_ENV = 'demo'
} = process.env;

const WS_HOST =
  CTRADER_ENV === 'live'
    ? 'wss://live.ctraderapi.com:5036'
    : 'wss://demo.ctraderapi.com:5036';          // porta corretta 5036

let ws;
let accessToken;
let currentRefresh = INITIAL_REFRESH;

/* ------------------------------------------------------------------ */
/* TOKEN – ottiene / rinnova l’access-token                            */
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

    if (res.status === 429) {                     // back-off 30-60 s
      const wait = 30_000 + Math.random()*30_000;
      console.warn('↻ 429 Too Many Requests – retry in', (wait/1000).toFixed(1),'s');
      return refreshToken(wait);
    }
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

    const j = await res.json();
    accessToken    = j.access_token;
    currentRefresh = j.refresh_token || currentRefresh;

    const expires = j.expires_in ?? j.expiresIn ?? 900;
    console.log('✔︎ Token ok. Expires in', expires,'sec');

    const next = (expires - 60 + (Math.random()*10 - 5))*1000;  // rinnovo 1 min prima
    setTimeout(refreshToken, next);
  }
  catch (err) {
    console.error('⚠︎ Token refresh error:', err.message);
    const wait = 60_000 + Math.random()*60_000;                  // 60-120 s
    setTimeout(()=>refreshToken(wait), wait);
  }
}

/* ------------------------------------------------------------------ */
/* WEBSOCKET                                                          */
/* ------------------------------------------------------------------ */
function openSocket () {
  ws = new WebSocket(WS_HOST);

  ws.on('open', () => {
    console.log('✔︎ WS connected (sending auth)');

    /*  IMPORTANTISSIMO
        Il protocollo di streaming di cTrader *non* accetta il nome simbolico
        «APPLICATION_AUTH_REQ», ma l’ID numerico 2100.
        Il pacchetto deve essere:

        {
          payloadType : 2100,
          payload     : { clientId, clientSecret, accessToken }
        }

        Il server risponde con 2101 (ApplicationAuthRes).                 */
    ws.send(JSON.stringify({
      payloadType : 2100,                     // 2100  = ApplicationAuthReq
      payload     : {
        clientId    : CTRADER_CLIENT_ID,
        clientSecret: CTRADER_CLIENT_SECRET,
        accessToken
      }
    }));
  });

  ws.once('message', buf => {
    let msg; try { msg = JSON.parse(buf.toString()) } catch { msg = {} }
    console.log('▶︎ WS AUTH RES:', msg.payloadType, msg.payload?.description||'');
    // 2101 = ApplicationAuthRes
    if (msg.payloadType === 2101 && msg.payload?.status !== 'OK') {
      console.error('❌  AUTH FAILED:', msg.payload?.description || '(unknown)');
      process.exit(1);                                        // interrompe loop infinito
    }
  });

  ws.on('close', () => {
    console.warn('WS closed – reconnecting in 2 s');
    setTimeout(openSocket, 2000);
  });
  ws.on('error', err => console.error('WS error', err));
}

/* ------------------------------------------------------------------ */
/* PICCOLA API HTTP (per Make.com)                                    */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json());

app.post('/order', (req, res) => {
  const { symbol, side, volume, price, tp, sl, type = 'LIMIT' } = req.body;
  if (!ws || ws.readyState !== WebSocket.OPEN)
    return res.status(503).json({ error: 'socket not ready' });

  const msg = {
    payloadType: 2120,                                 // OrderNewReq
    payload: {
      accountId     : Number(CTRADER_ACCOUNT_ID),
      symbolName    : symbol,
      orderType     : type,        // LIMIT / MARKET / STOP
      tradeSide     : side,        // BUY / SELL
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
      if ([2121, 2122].includes(m.payloadType)) {      // NewResp / NewRej
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
app.get('/', (_q, res) => res.send('cTrader bridge running'));
app.listen(PORT, () => console.log('bridge ready on', PORT));
