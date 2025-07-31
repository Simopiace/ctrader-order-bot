// index.js — ponte HTTP ⇄ WebSocket (JSON) per cTrader Open API
// v1.0  — 31-lug-2025

import express   from 'express';
import fetch     from 'node-fetch';
import WebSocket from 'ws';

/* ──────────────────────────────────────────────────────────────
 *  ENV
 * ──────────────────────────────────────────────────────────── */
const {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET,
  CTRADER_REFRESH_TOKEN: INITIAL_REFRESH,
  CTRADER_ACCOUNT_ID,
  CTRADER_ENV = 'demo'
} = process.env;

if (!CTRADER_CLIENT_ID || !CTRADER_CLIENT_SECRET || !INITIAL_REFRESH || !CTRADER_ACCOUNT_ID) {
  console.error('⚠︎  Mancano una o più variabili d’ambiente cTrader. Stop.');
  process.exit(1);
}

const WS_HOST =
  CTRADER_ENV === 'live'
    ? 'wss://live.ctraderapi.com:5036'
    : 'wss://demo.ctraderapi.com:5036';

/* ──────────────────────────────────────────────────────────────
 *  TOKEN REST
 * ──────────────────────────────────────────────────────────── */
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

    if (res.status === 429) {
      const wait = 30_000 + Math.random() * 30_000;
      console.warn('↻ 429 Too Many Requests — retry in', (wait/1e3).toFixed(1), 's');
      return refreshToken(wait);
    }
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

    const j = await res.json();
    accessToken    = j.access_token;
    currentRefresh = j.refresh_token || currentRefresh;

    const exp = j.expires_in ?? j.expiresIn ?? 900;
    console.log('✔︎ Token OK. Exp. in', exp, 'sec');

    const next = (exp - 60 + (Math.random()*10 - 5)) * 1000;
    setTimeout(refreshToken, next);
  } catch (err) {
    console.error('⚠︎ Token refresh error:', err.message);
    const wait = 60_000 + Math.random() * 60_000;
    setTimeout(() => refreshToken(wait), wait);
  }
}

/* ──────────────────────────────────────────────────────────────
 *  WEBSOCKET JSON
 * ──────────────────────────────────────────────────────────── */
let ws;

function send (obj) {
  ws.send(JSON.stringify(obj));
}

function openSocket () {
  ws = new WebSocket(WS_HOST);

  ws.on('open', () => {
    console.log('✔︎ WS connected (sending APPLICATION_AUTH_REQ)');

    send({
      clientMsgId : `app_${Date.now()}`,
      payloadType : 2100,                      // APPLICATION_AUTH_REQ
      payload     : {
        clientId    : CTRADER_CLIENT_ID,
        clientSecret: CTRADER_CLIENT_SECRET
      }
    });
  });

  ws.on('message', buf => {
    let msg;
    try { msg = JSON.parse(buf.toString()) } catch { return; }

    /* ---------- esiti auth app ---------- */
    if (msg.payloadType === 2101) {            // APPLICATION_AUTH_RES
      console.log('✔︎ APPLICATION_AUTH_RES OK');

      /* passo 2: TRADER_AUTH_REQ */
      send({
        clientMsgId : `trader_${Date.now()}`,
        payloadType : 2104,                    // TRADER_AUTH_REQ
        payload     : {
          ctidTraderAccountId: Number(CTRADER_ACCOUNT_ID),
          accessToken
        }
      });
      return;
    }
    if (msg.payloadType === 2142) {            // APPLICATION_AUTH_REJ / error
      console.error('❌ Auth failed:',
        msg.payload?.errorCode, msg.payload?.description);
      return;
    }

    /* ---------- esiti auth trader ---------- */
    if (msg.payloadType === 2105) {            // TRADER_AUTH_RES
      console.log('✔︎ TRADER_AUTH_RES OK — ready for orders');
      return;
    }
    if (msg.payloadType === 2143) {            // TRADER_AUTH_REJ
      console.error('❌ Trader auth reject:',
        msg.payload?.errorCode, msg.payload?.description);
      return;
    }

    /* ---------- ordini (risposte / eventi) ---------- */
    const waiter = waiters.get(msg.clientMsgId);
    if (waiter) waiter(msg);                   // risveglia la /order HTTP
  });

  ws.on('close', () => {
    console.warn('WS closed – reconnect in 5 s');
    setTimeout(openSocket, 5000);
  });
  ws.on('error', err => console.error('WS error', err));
}

/* ──────────────────────────────────────────────────────────────
 *  HTTP tiny API (per Make.com)
 * ──────────────────────────────────────────────────────────── */
const app = express();
app.use(express.json());

const waiters = new Map();      // clientMsgId → resolver

app.post('/order', (req, res) => {
  const { symbol, side, volume, price, tp, sl, type = 'LIMIT' } = req.body;

  if (!ws || ws.readyState !== WebSocket.OPEN)
    return res.status(503).json({ error: 'socket not ready' });

  const clientMsgId = `ord_${Date.now()}`;
  const proto = {
    clientMsgId,
    payloadType : 2006,                      // ORDER_NEW_REQ
    payload     : {
      ctidTraderAccountId: Number(CTRADER_ACCOUNT_ID),
      symbolName        : symbol,
      orderType         : type,              // LIMIT / MARKET / STOP
      tradeSide         : side,              // BUY / SELL
      volume,
      requestedPrice    : price,
      takeProfit        : tp ? { price: tp } : undefined,
      stopLoss          : sl ? { price: sl } : undefined
    }
  };

  /* invia e attende la risposta 2007 o 2011 */
  send(proto);

  const timer = setTimeout(() => {
    waiters.delete(clientMsgId);
    res.status(504).json({ error: 'timeout' });
  }, 10_000);

  waiters.set(clientMsgId, msg => {
    clearTimeout(timer);
    waiters.delete(clientMsgId);

    if (msg.payloadType === 2007)             // ORDER_NEW_RES
      return res.json({ orderId: msg.payload.orderId });

    if (msg.payloadType === 2011)             // ORDER_NEW_REJ
      return res.status(400).json({
        error: msg.payload.errorCode || 'order rejected',
        description: msg.payload.description
      });

    return res.status(500).json({ error: 'unknown response' });
  });
});

/* ──────────────────────────────────────────────────────────────
 *  BOOT
 * ──────────────────────────────────────────────────────────── */
await refreshToken();         // prende il primo accessToken REST
openSocket();                 // apre il WS JSON

const PORT = process.env.PORT || 8080;
app.get('/', (_q, r) => r.send('cTrader JSON bridge running'));
app.listen(PORT, () => console.log('HTTP ready on', PORT));
