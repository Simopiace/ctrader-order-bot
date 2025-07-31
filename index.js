// index.js – ponte HTTP ⇄ WebSocket per cTrader Open API (JSON)
// Node ≥18 + "type":"module" in package.json

import express   from 'express';
import fetch     from 'node-fetch';
import WebSocket from 'ws';

/* ──────────────── ENV ──────────────── */
const {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET,
  CTRADER_REFRESH_TOKEN: INITIAL_REFRESH,
  CTRADER_ACCOUNT_ID,
  CTRADER_ENV = 'demo',   // demo | live
  PORT = 8080
} = process.env;

if (!CTRADER_CLIENT_ID || !CTRADER_CLIENT_SECRET || !INITIAL_REFRESH || !CTRADER_ACCOUNT_ID) {
  console.error('❌  Variabili d’ambiente mancanti.');
  process.exit(1);
}

/* ──────────────── COSTANTI ──────────────── */
const WS_HOST =
  CTRADER_ENV === 'live'
    ? 'wss://live.ctraderapi.com:5036'
    : 'wss://demo.ctraderapi.com:5036';

/* ──────────────── TOKEN ──────────────── */
let accessToken, currentRefresh = INITIAL_REFRESH;

async function refreshToken(delay = 0) {
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

    if (res.status === 429) return refreshToken(30_000 + Math.random()*30_000);
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

    const j = await res.json();
    accessToken    = j.access_token;
    currentRefresh = j.refresh_token || currentRefresh;

    const exp = j.expires_in ?? 900;
    console.log('✔︎ Token ok – scade in', exp, 's');
    setTimeout(refreshToken, (exp - 60 + (Math.random()*10 - 5))*1000);
  } catch (e) {
    console.error('⚠︎ refresh error', e.message);
    setTimeout(refreshToken, 60_000 + Math.random()*60_000);
  }
}

/* ──────────────── WEBSOCKET ──────────────── */
let ws, pingIv;

function sendJSON(o){ ws.send(JSON.stringify(o)); }

function openSocket() {
  ws = new WebSocket(WS_HOST);

  ws.on('open', () => {
    console.log('✔︎ WS connected – APP-AUTH');
    sendJSON({
      clientMsgId : 'auth_'+Date.now(),
      payloadType : 2100,               // ProtoOAApplicationAuthReq
      payload     : {
        clientId    : CTRADER_CLIENT_ID,
        clientSecret: CTRADER_CLIENT_SECRET,
        accessToken
      }
    });
  });

  ws.on('message', data => {
    let m; try { m = JSON.parse(data); } catch { return; }
    const {payloadType, payload} = m;

    if (payloadType === 2101) {         // APP-AUTH RES
      console.log('✓ App-auth OK – ACCOUNT-AUTH');
      sendJSON({
        clientMsgId : 'acct_'+Date.now(),
        payloadType : 2102,             // ProtoOAAccountAuthReq
        payload     : {
          ctidTraderAccountId: Number(CTRADER_ACCOUNT_ID),
          accessToken
        }
      });
      return;
    }

    if (payloadType === 2103) {         // ACCOUNT-AUTH RES
      console.log('✓ Account-auth OK – socket ready');
      // keep-alive ping (25 s)
      clearInterval(pingIv);
      pingIv = setInterval(()=>sendJSON({payloadType:50}), 25_000);
      return;
    }

    if (payloadType === 2142)           // generic error
      console.warn('⚠︎ WS error', payload.errorCode, payload.description);
  });

  ws.on('close', () => {
    console.warn('WS closed – reconnect in 5 s');
    clearInterval(pingIv);
    setTimeout(openSocket, 5_000);
  });

  ws.on('error', err => console.error('WS error', err.message));
}

/* ──────────────── MINI-API HTTP ──────────────── */
const app = express(); app.use(express.json());

app.post('/order', (req,res)=>{
  if (!ws || ws.readyState !== WebSocket.OPEN)
    return res.status(503).json({error:'socket not ready'});

  const {
    symbol, side, volume,
    price, tp, sl,
    type='LIMIT'
  } = req.body;

  const clientMsgId = 'ord_'+Date.now();

  sendJSON({
    clientMsgId,
    payloadType : 2120,                // ProtoOANewOrderReq
    payload     : {
      ctidTraderAccountId: Number(CTRADER_ACCOUNT_ID),
      symbolName   : symbol,
      orderType    : type,
      tradeSide    : side,
      requestedPrice: price,
      volume,
      ...(tp ? { takeProfit: { price: tp }} : {}),
      ...(sl ? { stopLoss  : { price: sl }} : {})
    }
  });

  const handler = data => {
    let m; try{ m = JSON.parse(data);}catch{return;}
    if (m.clientMsgId !== clientMsgId) return;

    ws.off('message', handler);
    if (m.payloadType === 2121)        // ORDER_NEW_RES
      return res.json({orderId: m.payload.orderId});
    if (m.payloadType === 2142)
      return res.status(400).json({error: m.payload.description});

    res.status(500).json({error:'unexpected reply', raw:m});
  };
  ws.on('message', handler);
});

/* ──────────────── AVVIO ──────────────── */
await refreshToken();
openSocket();

app.get('/',(_,r)=>r.send('cTrader bridge running'));
app.listen(PORT, ()=>console.log('bridge HTTP on', PORT));
