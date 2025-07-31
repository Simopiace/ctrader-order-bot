// 🚀 cTrader Trading Bridge - Clean & Robust Version
// Telegram → Make.com → This Bridge → cTrader
// Node.js 18+ with "type": "module" in package.json

import express from 'express';
import fetch from 'node-fetch';
import WebSocket from 'ws';

/* ========================================
   📋 CONFIGURATION & CONSTANTS
   ======================================== */

const {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET, 
  CTRADER_REFRESH_TOKEN,
  CTRADER_ACCOUNT_ID,
  CTRADER_ENV = 'demo', // 'demo' | 'live'
  PORT = 8080
} = process.env;

// WebSocket endpoints
const WS_ENDPOINTS = {
  demo: 'wss://demo.ctraderapi.com:5036',
  live: 'wss://live.ctraderapi.com:5036'
};

// PayloadTypes (cTrader protocol)
const MSG_TYPES = {
  APPLICATION_AUTH_REQ: 2100,
  APPLICATION_AUTH_RES: 2101,
  ACCOUNT_AUTH_REQ: 2102,
  ACCOUNT_AUTH_RES: 2103,
  NEW_ORDER_REQ: 2106,
  NEW_ORDER_RES: 2121,
  HEARTBEAT_EVENT: 51,
  ERROR_RES: 2142
};

// Symbol mapping (extend as needed)
const SYMBOLS = {
  'EURUSD': 1,
  'GBPUSD': 2,
  'USDJPY': 3,
  'USDCHF': 4,
  'AUDUSD': 5,
  'USDCAD': 6,
  'NZDUSD': 7
};

/* ========================================
   🔐 TOKEN MANAGER
   ======================================== */

class TokenManager {
  constructor() {
    this.accessToken = null;
    this.refreshToken = CTRADER_REFRESH_TOKEN;
    this.expiryTime = 0;
    this.refreshTimeout = null;
  }

  async getValidToken() {
    // Check if current token is still valid (with 5min buffer)
    if (this.accessToken && Date.now() < this.expiryTime - 300000) {
      return this.accessToken;
    }

    return await this.refreshAccessToken();
  }

  async refreshAccessToken() {
    try {
      console.log('🔄 Refreshing access token...');
      
      const response = await fetch('https://openapi.ctrader.com/apps/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken,
          client_id: CTRADER_CLIENT_ID,
          client_secret: CTRADER_CLIENT_SECRET
        })
      });

      if (!response.ok) {
        throw new Error(`Token refresh failed: ${response.status}`);
      }

      const data = await response.json();
      
      if (data.errorCode) {
        throw new Error(`Token error: ${data.errorCode} - ${data.description}`);
      }

      this.accessToken = data.accessToken;
      this.refreshToken = data.refreshToken || this.refreshToken;
      
      // Set expiry time (default 15 minutes)
      const expiresIn = data.expiresIn || 900;
      this.expiryTime = Date.now() + (expiresIn * 1000);

      console.log(`✅ Token refreshed successfully (expires in ${expiresIn}s)`);
      
      // Schedule next refresh (5 minutes before expiry)
      this.scheduleNextRefresh(expiresIn - 300);
      
      return this.accessToken;

    } catch (error) {
      console.error('❌ Token refresh failed:', error.message);
      throw error;
    }
  }

  scheduleNextRefresh(seconds) {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }

    // Limit timeout to max 24 hours to prevent overflow
    const maxTimeout = 24 * 60 * 60; // 24 hours
    const safeTimeout = Math.min(Math.max(seconds, 60), maxTimeout);
    
    console.log(`⏰ Next token refresh in ${Math.round(safeTimeout/60)} minutes`);
    
    this.refreshTimeout = setTimeout(() => {
      this.refreshAccessToken().catch(console.error);
    }, safeTimeout * 1000);
  }

  destroy() {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }
  }
}

/* ========================================
   🔌 WEBSOCKET CLIENT
   ======================================== */

class cTraderClient {
  constructor(tokenManager) {
    this.tokenManager = tokenManager;
    this.ws = null;
    this.isAuthenticated = false;
    this.accountId = CTRADER_ACCOUNT_ID;
    this.heartbeatInterval = null;
    this.reconnectTimeout = null;
    this.messageHandlers = new Map();
  }

  async connect() {
    try {
      const wsUrl = WS_ENDPOINTS[CTRADER_ENV];
      console.log(`🔌 Connecting to ${CTRADER_ENV} WebSocket...`);
      
      this.ws = new WebSocket(wsUrl);
      
      this.ws.on('open', () => this.onOpen());
      this.ws.on('message', (data) => this.onMessage(data));
      this.ws.on('close', (code, reason) => this.onClose(code, reason));
      this.ws.on('error', (error) => this.onError(error));

    } catch (error) {
      console.error('❌ WebSocket connection failed:', error);
      this.scheduleReconnect();
    }
  }

  async onOpen() {
    console.log('✅ WebSocket connected - authenticating...');
    await this.authenticateApplication();
  }

  onMessage(data) {
    try {
      const message = JSON.parse(data.toString());
      this.handleMessage(message);
    } catch (error) {
      console.error('❌ Failed to parse message:', error);
    }
  }

  onClose(code, reason) {
    console.log(`⚠️  WebSocket closed (${code}): ${reason}`);
    this.isAuthenticated = false;
    this.stopHeartbeat();
    this.scheduleReconnect();
  }

  onError(error) {
    console.error('❌ WebSocket error:', error);
  }

  async authenticateApplication() {
    try {
      const token = await this.tokenManager.getValidToken();
      
      const authMessage = {
        clientMsgId: `app_auth_${Date.now()}`,
        payloadType: MSG_TYPES.APPLICATION_AUTH_REQ,
        payload: {
          clientId: CTRADER_CLIENT_ID,
          clientSecret: CTRADER_CLIENT_SECRET,
          accessToken: token
        }
      };

      this.sendMessage(authMessage);
    } catch (error) {
      console.error('❌ Application auth failed:', error);
      this.scheduleReconnect();
    }
  }

  async authenticateAccount() {
    try {
      const token = await this.tokenManager.getValidToken();
      
      const authMessage = {
        clientMsgId: `acc_auth_${Date.now()}`,
        payloadType: MSG_TYPES.ACCOUNT_AUTH_REQ,
        payload: {
          ctidTraderAccountId: parseInt(this.accountId),
          accessToken: token
        }
      };

      this.sendMessage(authMessage);
    } catch (error) {
      console.error('❌ Account auth failed:', error);
    }
  }

  handleMessage(message) {
    const { payloadType, clientMsgId } = message;

    // Skip heartbeat spam in logs
    if (payloadType !== MSG_TYPES.HEARTBEAT_EVENT) {
      console.log(`📨 Message: ${payloadType} (${clientMsgId || 'no-id'})`);
    }

    switch (payloadType) {
      case MSG_TYPES.APPLICATION_AUTH_RES:
        console.log('✅ Application authenticated - authenticating account...');
        this.authenticateAccount();
        break;

      case MSG_TYPES.ACCOUNT_AUTH_RES:
        if (message.payload?.errorCode) {
          console.error('❌ Account auth failed:', message.payload.description);
        } else {
          console.log('✅ Account authenticated - starting heartbeat...');
          this.isAuthenticated = true;
          this.startHeartbeat();
        }
        break;

      case MSG_TYPES.NEW_ORDER_RES:
        this.handleOrderResponse(message);
        break;

      case MSG_TYPES.ERROR_RES:
        console.error('❌ API Error:', message.payload);
        break;

      case MSG_TYPES.HEARTBEAT_EVENT:
        // Heartbeat response - connection is alive
        break;

      default:
        // Handle custom message handlers
        const handler = this.messageHandlers.get(clientMsgId);
        if (handler) {
          handler(message);
          this.messageHandlers.delete(clientMsgId);
        }
    }
  }

  handleOrderResponse(message) {
    if (message.payload?.errorCode) {
      console.error('❌ Order failed:', message.payload.description);
    } else {
      console.log('✅ Order executed successfully:', message.payload);
    }
  }

  sendMessage(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  // Send trading order
  async sendOrder(orderData) {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated');
    }

    const orderMessage = {
      clientMsgId: `order_${Date.now()}`,
      payloadType: MSG_TYPES.NEW_ORDER_REQ,
      payload: {
        ctidTraderAccountId: parseInt(this.accountId),
        symbolId: orderData.symbolId,
        orderType: orderData.type || 'MARKET',
        tradeSide: orderData.side === '1' ? 'BUY' : 'SELL',
        volume: orderData.volume,
        ...(orderData.stopLoss && { stopLoss: orderData.stopLoss }),
        ...(orderData.takeProfit && { takeProfit: orderData.takeProfit }),
        ...(orderData.comment && { comment: orderData.comment })
      }
    };

    return new Promise((resolve, reject) => {
      // Set timeout for order response
      const timeout = setTimeout(() => {
        this.messageHandlers.delete(orderMessage.clientMsgId);
        reject(new Error('Order timeout'));
      }, 10000);

      // Set response handler
      this.messageHandlers.set(orderMessage.clientMsgId, (response) => {
        clearTimeout(timeout);
        
        if (response.payload?.errorCode) {
          reject(new Error(`Order failed: ${response.payload.description}`));
        } else {
          resolve(response.payload);
        }
      });

      // Send order
      if (!this.sendMessage(orderMessage)) {
        clearTimeout(timeout);
        this.messageHandlers.delete(orderMessage.clientMsgId);
        reject(new Error('WebSocket not connected'));
      }
    });
  }

  startHeartbeat() {
    this.stopHeartbeat();
    
    this.heartbeatInterval = setInterval(() => {
      if (this.isAuthenticated) {
        const heartbeat = {
          clientMsgId: `heartbeat_${Date.now()}`,
          payloadType: MSG_TYPES.HEARTBEAT_EVENT,
          payload: {}
        };
        
        this.sendMessage(heartbeat);
      }
    }, 25000); // Every 25 seconds
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimeout) return;

    console.log('⏳ Reconnecting in 5 seconds...');
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, 5000);
  }

  disconnect() {
    this.stopHeartbeat();
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
    }
  }

  isReady() {
    return this.ws && 
           this.ws.readyState === WebSocket.OPEN && 
           this.isAuthenticated;
  }
}

/* ========================================
   🌐 HTTP SERVER
   ======================================== */

// Validate environment variables
function validateConfig() {
  const required = [
    'CTRADER_CLIENT_ID',
    'CTRADER_CLIENT_SECRET', 
    'CTRADER_REFRESH_TOKEN',
    'CTRADER_ACCOUNT_ID'
  ];

  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing);
    process.exit(1);
  }

  console.log('✅ Configuration validated');
}

// Create instances
validateConfig();
const tokenManager = new TokenManager();
const ctraderClient = new cTraderClient(tokenManager);
const app = express();

// Middleware
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  const status = {
    status: 'running',
    environment: CTRADER_ENV,
    websocket: ctraderClient.isReady() ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  };
  
  res.json(status);
});

// Trading endpoint
app.post('/order', async (req, res) => {
  try {
    console.log('📝 Order request received:', req.body);

    // Validate WebSocket connection
    if (!ctraderClient.isReady()) {
      return res.status(503).json({
        error: 'cTrader connection not ready',
        status: 'Please wait for connection to establish'
      });
    }

    // Parse and validate order data
    const { symbol, symbolId, side, volume, type, stopLoss, takeProfit, comment } = req.body;

    // Convert symbol to symbolId if needed
    let finalSymbolId = symbolId;
    if (!finalSymbolId && symbol) {
      finalSymbolId = SYMBOLS[symbol.toUpperCase()];
      if (!finalSymbolId) {
        return res.status(400).json({
          error: 'Invalid symbol',
          availableSymbols: Object.keys(SYMBOLS)
        });
      }
    }

    if (!finalSymbolId) {
      return res.status(400).json({
        error: 'Missing symbolId or symbol',
        example: { symbolId: 1, side: "1", volume: 100000, type: "1" }
      });
    }

    // Validate required fields
    if (!side || !volume) {
      return res.status(400).json({
        error: 'Missing required fields: side, volume',
        received: req.body
      });
    }

    // Prepare order data
    const orderData = {
      symbolId: parseInt(finalSymbolId),
      side: side.toString(),
      volume: parseInt(volume),
      type: type || '1', // Default to market order
      ...(stopLoss && { stopLoss: parseFloat(stopLoss) }),
      ...(takeProfit && { takeProfit: parseFloat(takeProfit) }),
      ...(comment && { comment: comment.toString() })
    };

    // Send order to cTrader
    const result = await ctraderClient.sendOrder(orderData);

    console.log('✅ Order executed successfully');
    res.json({
      success: true,
      result,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Order failed:', error.message);
    res.status(400).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Error handling
app.use((error, req, res, next) => {
  console.error('❌ Server error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

/* ========================================
   🚀 APPLICATION STARTUP
   ======================================== */

async function startup() {
  try {
    console.log('\n🚀 Starting cTrader Trading Bridge...');
    console.log(`📊 Environment: ${CTRADER_ENV}`);
    console.log(`🏦 Account ID: ${CTRADER_ACCOUNT_ID}`);
    
    // Start HTTP server
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`🌐 HTTP server listening on port ${PORT}`);
    });

    // Connect to cTrader
    await ctraderClient.connect();

    // Graceful shutdown
    const shutdown = () => {
      console.log('\n⏹️  Shutting down gracefully...');
      
      server.close(() => {
        ctraderClient.disconnect();
        tokenManager.destroy();
        process.exit(0);
      });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    console.log('✅ cTrader Trading Bridge is ready!');
    console.log('\n📋 API Endpoints:');
    console.log(`   GET  / - Health check`);
    console.log(`   POST /order - Place trading order`);
    console.log('\n📖 Order Example:');
    console.log(`   {
     "symbolId": 1,     // EURUSD
     "side": "1",       // BUY (1) or SELL (2) 
     "volume": 100000,  // 1 lot = 100,000 units
     "type": "1"        // MARKET (1) or LIMIT (2)
   }`);

  } catch (error) {
    console.error('❌ Startup failed:', error);
    process.exit(1);
  }
}

// Start the application
startup();
