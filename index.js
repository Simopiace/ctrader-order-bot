// index.js — mini-bridge HTTP ⇄ WebSocket (cTrader Open-API v2)
// -------------------------------------------------------------
// • POST /order   → inoltra ProtoOAOrderNewReq sulla stessa connessione
// • mantiene il WS vivo, rinnova token & reconnection logic
//
// richiede le seguenti env-vars (Fly.io → “Secrets”):
// CTRADER_CLIENT_ID , CTRADER_CLIENT_SECRET , CTRADER_REFRESH_TOKEN
// CTRADER_ACCOUNT_ID, CTRADER_ENV=demo|live
//
// © 2025 – feel free to reuse

import express   from 'express';
import fetch     from 'node-fetch';
import WebSocket from 'ws';

/* ─────────────────────────── ENV ────────────────────────── */
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
    : 'wss://demo.ctraderapi.com:5036';

/* ────────────────────── runtime state ───────────────────── */
let ws;                       // WebSocket instance
let httpToken;                // OAuth token (REST)
let wsAccessToken;            // OA accessToken (step 2)
let currentRefresh = INITIAL_REFRESH;

/* ────────────────────── util helpers ────────────────────── */
const delay = ms => new Promise(r => setTimeout(r, ms));

function sendWs(payloadType, payload) {
  return new Promise((res, rej) => {
    const msg = { payloadType, payload };
    ws.send(JSON.stringify(msg), err => err ? rej(err) : res());
  });
}

function waitFor(predicate, timeout = 8000) {
  return new Promise((res, rej) => {
    const t = setTimeout(
      () => rej(new Error('WS response timeout')),
      timeout
    );
    const once = buf => {
      let m;
      try   { m = JSON.parse(buf.toString()) } catch { return; }
      if (predicate(m)) {
        clearTimeout(t);
        ws.off('message', once);
        res(m);
      }
    };
    ws.on('message', once);
  });
}

/* ─────────────────── REST token (bootstrap) ─────────────── */
async function refreshHttpToken(backoff = 0) {
  if (backoff) await delay(backoff);
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
      console.warn('↻ 429 Too Many Requests – retry in', wait/1000, 's');
      return refreshHttpToken(wait);
    }
    if (!res.ok) throw new Error(await res.text());

    const j   = await res.json();
    httpToken = j.access_token;
    currentRefresh = j.refresh_token || currentRefresh;

    const exp = j.expires_in ?? j.expiresIn ?? 900;
    console.log('✔︎ HTTP token ok – expires in', exp, 's');
    // renew 60 s before
    setTimeout(refreshHttpToken, (exp-60)*1000);
  } catch (e) {
    console.error('⚠︎ HTTP token refresh:', e.message);
    setTimeout(refreshHttpToken, 60_000);
  }
}

/* ────────────────────── WebSocket flow ──────────────────── */
async function openSocket() {
  ws = new WebSocket(WS_HOST);

  ws.on('open', async () => {
    console.log('✔︎ WS connected – sending APP-AUTH');

    /* step 1 – APP AUTH */
    await sendWs(2100, {
      clientId    : CTRADER_CLIENT_ID,
      clientSecret: CTRADER_CLIENT_SECRET
    });
    await waitFor(m => m.payloadType === 2101);
    console.log('✓ App-auth OK – sending REFRESH-TOKEN');

    /* step 2 – REFRESH -> get wsAccessToken */
    await sendWs(42, {            // ProtoOARefreshTokenReq
      refreshToken: currentRefresh,
      clientId    : CTRADER_CLIENT_ID,
      clientSecret: CTRADER_CLIENT_SECRET
    });
    const r42 = await waitFor(m => m.payloadType === 43);
    wsAccessToken = r42.payload.accessToken;
    console.log('✓ Token WS OK – sending ACCOUNT-AUTH');

    /* step 3 – ACCOUNT AUTH */
    await sendWs(2102, {
      ctidTraderAccountId: Number(CTRADER_ACCOUNT_ID),
      accessToken        : wsAccessToken
    });
    await waitFor(m => m.payloadType === 2103);
    console.log('✓ Account-auth OK – socket pronto');
  });

  ws.on('close', () => {
    console.warn('WS closed – reconnecting in 5 s');
    setTimeout(openSocket, 5000);
  });
  ws.on('error', e => console.error('❌ WS error', e.message));
}

/* ───────────────────── tiny HTTP API ────────────────────── */
const app = express();
app.use(express.json());

app.post('/order', async (req, res) => {
  const { symbol, side, volumeLots = 1, type = 'MARKET' } = req.body;

  if (!ws || ws.readyState !== WebSocket.OPEN)
    return res.status(503).json({ error: 'socket not ready' });

  try {
    const clientMsgId = 'ord_' + Date.now();
    await sendWs(1100, {                       // ProtoOAOrderNewReq
      ctidTraderAccountId: Number(CTRADER_ACCOUNT_ID),
      symbolName         : symbol,
      tradeSide          : side,               // BUY / SELL
      orderType          : type,               // MARKET / LIMIT / STOP
      volume             : volumeLots * 100000, // 1 lot = 100 000 units
      clientOrderId      : clientMsgId
    });

    const resp = await waitFor(m =>
      m.payloadType === 1101 && m.payload.clientOrderId === clientMsgId ||
      m.payloadType === 1102 && m.payload.clientOrderId === clientMsgId
    );

    if (resp.payloadType === 1102)        // REJ
      return res.status(400).json({ error: resp.payload.rejectReason });

    return res.json({ orderId: resp.payload.orderId });
  } catch (e) {
    console.error('order err', e.message);
    return res.status(500).json({ error: 'internal error' });
  }
});

/* ────────────────────────── BOOT ────────────────────────── */
await refreshHttpToken();   // get first OAuth token
openSocket();               // start / auto-reconnect

const PORT = process.env.PORT || 8080;
app.get('/', (_q,r)=>r.send('cTrader bridge running'));
app.listen(PORT, () => console.log('bridge ready on', PORT));
