// index.js – bridge HTTP ⇄ cTrader OpenAPI v2
// v6: account-auth + NEW_ORDER_REQ = 1101

import express   from 'express';
import fetch     from 'node-fetch';
import WebSocket from 'ws';

/* ---------- env ---------- */
const {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET,
  CTRADER_REFRESH_TOKEN,
  CTRADER_ACCOUNT_ID,
  CTRADER_ENV = 'demo',
  PORT = 8080
} = process.env;

/* ---------- constants ---------- */
const WS_HOST = CTRADER_ENV==='live'
  ? 'wss://live.ctraderapi.com:5036'
  : 'wss://demo.ctraderapi.com:5036';

const MSG = {
  APP_AUTH_REQ    : 2100,
  APP_AUTH_RES    : 2101,
  ACCOUNT_AUTH_REQ: 2102,
  ACCOUNT_AUTH_RES: 2103,
  ERROR_RES       : 2142,
  NEW_ORDER_REQ   : 1101,
  NEW_ORDER_RES   : 1102
};

/* ---------- globals ---------- */
let ws, accessToken, refresh = CTRADER_REFRESH_TOKEN;
let socketReady = false;

/* ---------- token ---------- */
async function refreshToken (delay=0) {
  if (delay) await new Promise(r=>setTimeout(r,delay));

  try {
    const r = await fetch('https://openapi.ctrader.com/apps/token', {
      method:'POST',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
      body:new URLSearchParams({
        grant_type:'refresh_token',
        client_id:CTRADER_CLIENT_ID,
        client_secret:CTRADER_CLIENT_SECRET,
        refresh_token:refresh
      })
    });
    if(r.status===429){
      const w=30e3+Math.random()*30e3;
      console.warn('↻ 429 – retry in',w/1e3,'s');
      return refreshToken(w);
    }
    if(!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const j=await r.json();
    accessToken=j.access_token;
    refresh=j.refresh_token||refresh;
    const exp=j.expires_in??j.expiresIn??900;
    console.log('✔︎ Token ok. Expires in',exp,'sec');
    setTimeout(refreshToken,(exp-60+(Math.random()*10-5))*1e3);
  }catch(e){
    console.error('⚠︎ token',e.message);
    setTimeout(refreshToken,60e3+Math.random()*60e3);
  }
}

/* ---------- websocket ---------- */
function openSocket(){
  socketReady=false;
  ws=new WebSocket(WS_HOST);

  ws.once('open',()=>{
    console.log('✔︎ WS connected – sending APP-AUTH');
    ws.send(JSON.stringify({
      payloadType:MSG.APP_AUTH_REQ,
      payload:{
        clientId:CTRADER_CLIENT_ID,
        clientSecret:CTRADER_CLIENT_SECRET,
        accessToken
      }
    }));
  });

  ws.on('message',raw=>{
    let m; try{m=JSON.parse(raw)}catch{m={}};
    const {payloadType:pt,payload}=m;

    if(pt===MSG.APP_AUTH_RES){
      console.log('✓ App-auth OK – sending ACCOUNT-AUTH');
      ws.send(JSON.stringify({
        payloadType:MSG.ACCOUNT_AUTH_REQ,
        payload:{
          ctidTraderAccountId:Number(CTRADER_ACCOUNT_ID),
          accessToken
        }
      }));
      return;
    }
    if(pt===MSG.ACCOUNT_AUTH_RES){
      console.log('✓ Account-auth OK – ready 🤝');
      socketReady=true;
      return;
    }
    if(pt===MSG.ERROR_RES){
      console.error('❌ WS error',payload.errorCode,payload.description);
    }
  });

  ws.on('close',()=>{
    console.warn('WS closed – reconnecting in 5 s');
    setTimeout(openSocket,5e3);
  });
  ws.on('error',e=>console.error('WS error',e));
}

/* ---------- HTTP API ---------- */
const app=express();
app.use(express.json());

app.post('/order',(req,res)=>{
  if(!socketReady) return res.status(503).json({error:'socket not ready'});
  const {symbolId,side,type='MARKET',volumeLots,price,tp,sl}=req.body;
  if(!symbolId||!side||!volumeLots)
    return res.status(400).json({error:'symbolId, side, volumeLots required'});

  const payload={
    ctidTraderAccountId:Number(CTRADER_ACCOUNT_ID),
    clientMsgId:`o_${Date.now()}`,
    symbolId,
    tradeSide:side,           // BUY/SELL
    orderType:type,           // MARKET/LIMIT/STOP
    volume:Math.round(volumeLots*100000)
  };
  if(type==='LIMIT') payload.limitPrice=price;
  if(type==='STOP')  payload.stopPrice =price;
  if(tp) payload.takeProfitPrice=tp;
  if(sl) payload.stopLossPrice  =sl;

  ws.send(JSON.stringify({payloadType:MSG.NEW_ORDER_REQ,payload}),err=>{
    if(err) return res.status(502).json({error:'ws send',detail:err.message});
    const once=data=>{
      const m=JSON.parse(data);
      if([MSG.NEW_ORDER_RES,MSG.ERROR_RES].includes(m.payloadType)){
        ws.off('message',once);
        if(m.payloadType===MSG.ERROR_RES)
          return res.status(400).json(m.payload);
        return res.json({orderId:m.payload.orderId});
      }
    };
    ws.on('message',once);
  });
});

/* ---------- start ---------- */
await refreshToken();
openSocket();
app.listen(PORT,()=>console.log('bridge ready on',PORT));
