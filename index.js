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

console.log('🚀 Starting cTrader bridge...');
console.log('ENV:', CTRADER_ENV);
console.log('PORT:', PORT);
console.log('Has CLIENT_ID:', !!CTRADER_CLIENT_ID);
console.log('Has CLIENT_SECRET:', !!CTRADER_CLIENT_SECRET);
console.log('Has REFRESH_TOKEN:', !!INITIAL_REFRESH);
console.log('Has ACCOUNT_ID:', !!CTRADER_ACCOUNT_ID);

if (!CTRADER_CLIENT_ID || !CTRADER_CLIENT_SECRET || !INITIAL_REFRESH) {
  console.error('❌ Variabili d\'ambiente mancanti:');
  console.error('CTRADER_CLIENT_ID:', !!CTRADER_CLIENT_ID);
  console.error('CTRADER_CLIENT_SECRET:', !!CTRADER_CLIENT_SECRET);
  console.error('CTRADER_REFRESH_TOKEN:', !!INITIAL_REFRESH);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* COSTANTI                                                           */
/* ------------------------------------------------------------------ */
const WS_HOST =
  CTRADER_ENV === 'live'
    ? 'wss://live.ctraderapi.com:5036'     // endpoint JSON
    : 'wss://demo.ctraderapi.com:5036';

console.log('WS_HOST:', WS_HOST);

/* ------------------------------------------------------------------ */
/* TOKEN (OAuth2)                                                     */
/* ------------------------------------------------------------------ */
let accessToken;
let currentRefresh = INITIAL_REFRESH;

async function refreshToken(delay = 0) {
  if (delay) {
    console.log(`⏳ Waiting ${delay/1000}s before token refresh...`);
    await new Promise(r => setTimeout(r, delay));
  }

  try {
    console.log('🔄 Refreshing token...');
    
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
    
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errorText}`);
    }

    const j = await res.json();
    console.log('Token response fields:', Object.keys(j));
    
    if (!j.access_token) {
      throw new Error('No access_token in response: ' + JSON.stringify(j));
    }
    
    accessToken    = j.access_token;
    currentRefresh = j.refresh_token || currentRefresh;

    const ttl = j.expires_in ?? j.expiresIn ?? 900;
    console.log('✔︎ Token refreshed successfully – expires in', ttl, 's');

    // Limita il timeout per evitare overflow (max 24 ore)
    const maxTimeout = 24 * 60 * 60 * 1000; // 24 ore in ms
    const refreshTime = Math.min((ttl - 60) * 1000, maxTimeout);
    
    console.log(`Next refresh in ${refreshTime/1000/60} minutes`);
    
    // Schedule next refresh
    setTimeout(refreshToken, refreshTime);
    
    return true;
  }
  catch (err) {
    console.error('⚠︎ Token refresh error:', err.message);
    const wait = 60_000 + Math.random()*60_000;
    console.log(`⏳ Retrying token refresh in ${wait/1000}s...`);
    setTimeout(() => refreshToken(wait), wait);
    throw err; // Re-throw for initial startup
  }
}

/* ------------------------------------------------------------------ */
/* WEBSOCKET                                                          */
/* ------------------------------------------------------------------ */
let ws;
let heartbeatInterval;
let isAuthenticated = false;
let currentAccountId = null;

function openSocket() {
  if (!accessToken) {
    console.error('❌ No access token available for WebSocket connection');
    return;
  }

  console.log('🔌 Opening WebSocket connection...');
  ws = new WebSocket(WS_HOST);

  ws.on('open', () => {
    console.log('✔︎ WS connected – sending AUTH');
    isAuthenticated = false;
    
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
    let msg;
    try { 
      msg = JSON.parse(buf.toString()) 
    } catch (e) { 
      console.error('❌ Failed to parse AUTH response:', e.message);
      ws.close();
      return;
    }
    
    console.log('▶︎ WS AUTH RES', msg);

    if (msg.payloadType === 2101) {     // APPLICATION_AUTH_RES
      console.log('✔︎ App Auth ok – requesting account list...');
      
      // Richiediamo la lista degli account
      ws.send(JSON.stringify({
        clientMsgId : 'get_accounts_'+Date.now(),
        payloadType : 2149,              // TRADER_REQ
        payload     : {
          accessToken: accessToken
        }
      }));
      
      // Aspettiamo la risposta con la lista account
      ws.once('message', buf2 => {
        let accountListMsg;
        try { 
          accountListMsg = JSON.parse(buf2.toString()) 
        } catch (e) { 
          console.error('❌ Failed to parse ACCOUNT LIST response:', e.message);
          ws.close();
          return;
        }
        
        console.log('▶︎ ACCOUNT LIST RESPONSE:', JSON.stringify(accountListMsg, null, 2));
        
        if (accountListMsg.payloadType === 2150) {     // TRADER_RES
          if (accountListMsg.payload?.ctidTraderAccount && accountListMsg.payload.ctidTraderAccount.length > 0) {
            console.log('📋 Available accounts:');
            accountListMsg.payload.ctidTraderAccount.forEach((account, i) => {
              console.log(`  ${i+1}. AccountID: ${account.ctidTraderAccountId}, Login: ${account.traderLogin}, ${account.isLive ? 'LIVE' : 'DEMO'}, Currency: ${account.depositAssetId}`);
            });
            
            // Cerchiamo prima l'account FP Markets con login 1056968
            const targetAccount = accountListMsg.payload.ctidTraderAccount.find(acc => 
              !acc.isLive && acc.traderLogin === 1056968
            );
            
            if (targetAccount) {
              console.log(`🎯 Using target demo account ID: ${targetAccount.ctidTraderAccountId} (Login: ${targetAccount.traderLogin})`);
              authenticateAccount(targetAccount.ctidTraderAccountId);
            } else {
              // Fallback al primo account demo
              const demoAccount = accountListMsg.payload.ctidTraderAccount.find(acc => !acc.isLive);
              if (demoAccount) {
                console.log(`🎯 Using demo account ID: ${demoAccount.ctidTraderAccountId} (Login: ${demoAccount.traderLogin})`);
                authenticateAccount(demoAccount.ctidTraderAccountId);
              } else {
                console.error('❌ No demo account found - using first available account');
                const firstAccount = accountListMsg.payload.ctidTraderAccount[0];
                console.log(`🎯 Using account ID: ${firstAccount.ctidTraderAccountId} (Login: ${firstAccount.traderLogin})`);
                authenticateAccount(firstAccount.ctidTraderAccountId);
              }
            }
          } else {
            console.error('❌ No accounts found in response');
            ws.close();
          }
        } else if (accountListMsg.payloadType === 2142) {
          console.error('❌ Account list request failed:', accountListMsg.payload?.errorCode, accountListMsg.payload?.description);
          ws.close();
        } else {
          console.error('❌ Unexpected account list response type:', accountListMsg.payloadType);
          ws.close();
        }
      });
      
      return;
    }
    
    console.error('❌ App Auth failed:', msg.payload?.errorCode, msg.payload?.description);
    ws.close();
  });

  // Gestisci tutti i messaggi successivi
  ws.on('message', buf => {
    let msg;
    try { 
      msg = JSON.parse(buf.toString()) 
    } catch (e) { 
      console.error('❌ Failed to parse message:', e.message);
      return;
    }
    
    // Log solo messaggi non-heartbeat per ridurre spam
    if (msg.payloadType !== 51) { // HEARTBEAT_EVENT
      console.log('▶︎ WS MSG', msg.payloadType, msg.clientMsgId || 'no-id');
    }
  });

  ws.on('close', (code, reason) => {
    console.warn(`⚠︎ WS closed (${code}): ${reason || 'no reason'} – reconnect in 5s`);
    isAuthenticated = false;
    stopHeartbeat();
    setTimeout(openSocket, 5000);
  });

  ws.on('error', err => {
    console.error('❌ WS error:', err.message);
    isAuthenticated = false;
    stopHeartbeat();
  });
}

function authenticateAccount(accountId) {
  console.log(`🔐 Authenticating account: ${accountId}`);
  
  ws.send(JSON.stringify({
    clientMsgId : 'account_auth_'+Date.now(),
    payloadType : 2102,              // ACCOUNT_AUTH_REQ
    payload     : {
      ctidTraderAccountId: Number(accountId),
      accessToken
    }
  }));
  
  // Aspettiamo la risposta dell'account auth
  ws.once('message', buf => {
    let accountMsg;
    try { 
      accountMsg = JSON.parse(buf.toString()) 
    } catch (e) { 
      console.error('❌ Failed to parse ACCOUNT AUTH response:', e.message);
      ws.close();
      return;
    }
    
    console.log('▶︎ WS ACCOUNT AUTH RES', accountMsg);
    
    if (accountMsg.payloadType === 2103) {     // ACCOUNT_AUTH_RES
      console.log('✔︎ Account Auth ok – socket fully ready');
      isAuthenticated = true;
      currentAccountId = Number(accountId);
      startHeartbeat();
    } else {
      console.error('❌ Account Auth failed:', accountMsg.payload?.errorCode, accountMsg.payload?.description);
      ws.close();
    }
  });
}

function startHeartbeat() {
  stopHeartbeat(); // pulisci eventuale precedente
  
  console.log('♥ Starting heartbeat...');
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN && isAuthenticated) {
      ws.send(JSON.stringify({
        clientMsgId: 'ping_' + Date.now(),
        payloadType: 51, // HEARTBEAT_EVENT
        payload: {}
      }));
      // console.log('♥ Heartbeat sent'); // Uncomment for debugging
    }
  }, 10000); // ogni 10 secondi
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    console.log('♥ Stopping heartbeat...');
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/* ------------------------------------------------------------------ */
/* MINI API HTTP (es. Make/Zapier)                                    */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  const status = {
    status: 'running',
    websocket: ws ? (ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected') : 'not_initialized',
    authenticated: isAuthenticated,
    accountId: currentAccountId,
    timestamp: new Date().toISOString()
  };
  res.json(status);
});

// Status endpoint
app.get('/status', (req, res) => {
  const status = {
    websocket_ready: ws && ws.readyState === WebSocket.OPEN && isAuthenticated,
    websocket_state: ws ? ws.readyState : 'none',
    authenticated: isAuthenticated,
    has_token: !!accessToken,
    account_id: currentAccountId,
    environment: CTRADER_ENV
  };
  res.json(status);
});

/*
   POST /order
   {
     "symbolId": 1          // OPPURE "symbol": "EURUSD"
     "side": "1"|"2",       // BUY=1, SELL=2
     "volume": 100000,      // cent-units (100 000 = 1 lot standard)
     "price": 1.23456,      // richiesto per LIMIT / STOP
     "tp": 1.24000,         // opzionale
     "sl": 1.23000,         // opzionale
     "type": "1"|"2"|"3"    // MARKET=1, LIMIT=2, STOP=3 (default 1)
   }
*/
app.post('/order', (req, res) => {
  console.log('📝 Order request received:', req.body);

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

  if (!ws || ws.readyState !== WebSocket.OPEN || !isAuthenticated) {
    console.error('❌ Socket not ready:', {
      ws_exists: !!ws,
      ws_state: ws ? ws.readyState : 'none',
      authenticated: isAuthenticated,
      account_id: currentAccountId
    });
    return res.status(503).json({ 
      error: 'socket not ready',
      ws_state: ws ? ws.readyState : 'none',
      authenticated: isAuthenticated,
      account_id: currentAccountId
    });
  }

  // validazione minima
  if (!(symbolId || symbol) || !side || !volume || (type !== '1' && price === undefined)) {
    console.error('❌ Missing parameters:', { symbolId, symbol, side, volume, price, type });
    return res.status(400).json({ error: 'missing parameters' });
  }

  const clientMsgId = 'ord_'+Date.now();

  const orderReq = {
    clientMsgId,
    payloadType : 2106,                       // NEW_ORDER_REQ
    payload     : {
      ctidTraderAccountId      : currentAccountId,
      ...(symbolId ? { symbolId: Number(symbolId) } : { symbolName: symbol }),
      orderType      : Number(type),            // MARKET | LIMIT | STOP
      tradeSide      : Number(side),            // BUY   | SELL
      volume         : Number(volume),
      ...(type !== '1' ? { requestedPrice: Number(price) } : {}),
      ...(tp !== undefined ? { takeProfitPrice: Number(tp) } : {}),
      ...(sl !== undefined ? { stopLossPrice: Number(sl) } : {})
    }
  };

  console.log('📤 Sending order request:', clientMsgId);
  console.log('Order payload:', JSON.stringify(orderReq, null, 2));

  ws.send(JSON.stringify(orderReq), err => {
    if (err) {
      console.error('❌ WS send error:', err.message);
      return res.status(500).json({ error: 'ws send error: ' + err.message });
    }

    const timeout = setTimeout(() => {
      ws.off('message', listener);
      console.error('⏱️ Order timeout for:', clientMsgId);
      res.status(504).json({ error: 'order timeout' });
    }, 30000); // 30 second timeout

    const listener = data => {
      let m;
      try { 
        m = JSON.parse(data.toString()) 
      } catch (e) { 
        console.error('❌ Failed to parse order response:', e.message);
        return;
      }
      
      if (m.clientMsgId !== clientMsgId) return;   // non nostra risposta

      clearTimeout(timeout);
      ws.off('message', listener);

      console.log('📥 Order response:', m.payloadType, m.payload);

      if (m.payloadType === 2121) {               // ORDER_NEW_RES
        return res.json({ 
          success: true,
          orderId: m.payload?.orderId,
          message: 'Order placed successfully'
        });
      }

      if (m.payloadType === 2142) {               // ERROR_RES
        return res.status(400).json({ 
          error: m.payload?.description || 'Order failed',
          errorCode: m.payload?.errorCode
        });
      }

      res.status(500).json({ 
        error: 'unexpected reply', 
        payloadType: m.payloadType,
        raw: m 
      });
    };
    
    ws.on('message', listener);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Express error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

/* ------------------------------------------------------------------ */
/* GRACEFUL SHUTDOWN                                                  */
/* ------------------------------------------------------------------ */
process.on('SIGTERM', () => {
  console.log('📴 SIGTERM received, shutting down gracefully...');
  stopHeartbeat();
  if (ws) ws.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('📴 SIGINT received, shutting down gracefully...');
  stopHeartbeat();
  if (ws) ws.close();
  process.exit(0);
});

/* ------------------------------------------------------------------ */
/* BOOT                                                                */
/* ------------------------------------------------------------------ */
async function start() {
  try {
    console.log('🔄 Initializing token...');
    await refreshToken();   // primo access-token
    
    console.log('🔌 Opening WebSocket...');
    openSocket();           // WS con reconnessione
    
    console.log('🌐 Starting HTTP server...');
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log('✅ cTrader bridge ready on port', PORT);
    });

    server.on('error', (err) => {
      console.error('❌ Server error:', err);
      process.exit(1);
    });

  } catch (error) {
    console.error('❌ Startup error:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

// Catch unhandled errors
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

console.log('🚀 Starting application...');
start();
