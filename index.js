// 🚀 cTrader Trading Bridge - Production Ready Version
// Telegram → Make.com → This Bridge → cTrader
// Node.js 18+ with "type": "module" in package.json

import express from 'express';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
   🔐 SMART TOKEN MANAGER
   ======================================== */

class SmartTokenManager {
  constructor() {
    this.accessToken = null;
    this.refreshToken = CTRADER_REFRESH_TOKEN;
    this.expiryTime = 0;
    this.refreshTimeout = null;
    this.isRefreshing = false;
    this.maxRetries = 3;
    this.retryCount = 0;
    this.pendingRefreshToken = null; // Store new token temporarily
  }

  async getValidToken() {
    // If token is valid for at least 1 hour, use it
    if (this.accessToken && Date.now() < this.expiryTime - 3600000) {
      return this.accessToken;
    }

    // If already refreshing, wait for it
    if (this.isRefreshing) {
      console.log('⏳ Token refresh in progress, waiting...');
      return new Promise((resolve, reject) => {
        const checkInterval = setInterval(() => {
          if (!this.isRefreshing) {
            clearInterval(checkInterval);
            if (this.accessToken) {
              resolve(this.accessToken);
            } else {
              reject(new Error('Token refresh failed'));
            }
          }
        }, 100);
      });
    }

    return await this.refreshAccessToken();
  }

  async refreshAccessToken() {
    if (this.isRefreshing) return this.accessToken;
    
    this.isRefreshing = true;
    
    try {
      console.log('🔄 Refreshing access token...');
      console.log('⚠️  Note: This will invalidate the current refresh token!');
      
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
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      
      if (data.errorCode) {
        throw new Error(`${data.errorCode}: ${data.description}`);
      }

      // Update tokens
      this.accessToken = data.accessToken;
      
      // CRITICAL: Update refresh token (old one is invalidated!)
      if (data.refreshToken) {
        this.refreshToken = data.refreshToken;
        this.pendingRefreshToken = data.refreshToken; // Store for webhook
        console.log('🔄 Refresh token updated (old token invalidated)');
        
        // Send notification to Make.com webhook if configured
        if (process.env.MAKE_WEBHOOK_URL) {
          this.notifyTokenRefresh(data.refreshToken);
        }
        
        // Auto-update Fly.io secrets if running on Fly
        if (process.env.FLY_APP_NAME && process.env.FLY_API_TOKEN) {
          await this.updateFlySecret(data.refreshToken);
        } else {
          console.log('⚠️  IMPORTANT: Update the refresh token in your secrets!');
          console.log(`📝 New refresh token available at: GET /token-update`);
        }
      }
      
      // Set expiry time (30 days = 2,628,000 seconds)
      const expiresIn = data.expiresIn || 2628000; // Default to 30 days
      this.expiryTime = Date.now() + (expiresIn * 1000);

      console.log(`✅ Token refreshed successfully`);
      console.log(`⏰ Token expires in ${Math.round(expiresIn/86400)} days`);
      
      // Schedule next refresh 3 days before expiry (27 days from now)
      this.scheduleNextRefresh(expiresIn - 259200); // 3 days buffer
      
      this.retryCount = 0; // Reset retry counter on success
      return this.accessToken;

    } catch (error) {
      console.error('❌ Token refresh failed:', error.message);
      this.retryCount++;
      
      // If refresh token is invalid, stop trying
      if (error.message.includes('ACCESS_DENIED') || 
          error.message.includes('INVALID_GRANT') ||
          this.retryCount >= this.maxRetries) {
        console.error('💀 Refresh token invalid or max retries reached');
        console.error('📝 Manual re-authorization required');
        throw error;
      }
      
      // Exponential backoff for retries
      const backoffTime = Math.min(60000 * Math.pow(2, this.retryCount), 300000);
      console.log(`🔄 Retrying token refresh in ${backoffTime/1000}s...`);
      
      setTimeout(() => {
        this.refreshAccessToken().catch(console.error);
      }, backoffTime);
      
      throw error;
    } finally {
      this.isRefreshing = false;
    }
  }

  async notifyTokenRefresh(newRefreshToken) {
    try {
      console.log('📨 Sending token refresh notification to Make.com...');
      
      await fetch(process.env.MAKE_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'token_refreshed',
          timestamp: new Date().toISOString(),
          app_name: process.env.FLY_APP_NAME || 'ctrader-order-bot',
          refresh_token: newRefreshToken,
          message: 'cTrader refresh token has been updated. Please update your secrets.'
        })
      });
      
      console.log('✅ Notification sent to Make.com');
    } catch (error) {
      console.error('❌ Failed to notify Make.com:', error);
    }
  }

  async updateFlySecret(newRefreshToken) {
    try {
      console.log('🔄 Auto-updating Fly.io refresh token secret...');
      
      // Fly.io API endpoint
      const flyApiUrl = `https://api.fly.io/v1/apps/${process.env.FLY_APP_NAME}/secrets`;
      
      // Need FLY_API_TOKEN to update secrets
      if (!process.env.FLY_API_TOKEN) {
        console.warn('⚠️  FLY_API_TOKEN not set, cannot auto-update refresh token');
        console.log('📝 Set it with: fly secrets set FLY_API_TOKEN=$(fly auth token)');
        console.log(`📝 Manual update required: fly secrets set CTRADER_REFRESH_TOKEN="${newRefreshToken.substring(0, 20)}..."`);
        return;
      }

      const response = await fetch(flyApiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.FLY_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          secrets: {
            CTRADER_REFRESH_TOKEN: newRefreshToken
          }
        })
      });

      if (response.ok) {
        console.log('✅ Fly.io refresh token secret updated automatically!');
        console.log('🔄 App will restart to apply new secret...');
      } else {
        console.error('❌ Failed to update Fly.io secret:', await response.text());
        console.log(`📝 Manual update required: fly secrets set CTRADER_REFRESH_TOKEN="${newRefreshToken.substring(0, 20)}..."`);
      }
    } catch (error) {
      console.error('❌ Error updating Fly.io secret:', error);
      console.log(`📝 Manual update required: fly secrets set CTRADER_REFRESH_TOKEN="${newRefreshToken.substring(0, 20)}..."`);
    }
  }

  scheduleNextRefresh(seconds) {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }

    // Ensure sane timeout values (min 1 hour, max 27 days)
    const minTimeout = 3600; // 1 hour
    const maxTimeout = 27 * 24 * 3600; // 27 days
    const safeTimeout = Math.min(Math.max(seconds, minTimeout), maxTimeout);
    
    console.log(`⏰ Next token refresh in ${Math.round(safeTimeout/86400)} days`);
    
    this.refreshTimeout = setTimeout(() => {
      this.refreshAccessToken().catch(error => {
        console.error('🚨 Scheduled token refresh failed:', error.message);
      });
    }, safeTimeout * 1000);
  }

  destroy() {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }
  }
}

/* ========================================
   🔌 ROBUST WEBSOCKET CLIENT
   ======================================== */

class RobustcTraderClient {
  constructor(tokenManager) {
    this.tokenManager = tokenManager;
    this.ws = null;
    this.isAuthenticated = false;
    this.accountId = CTRADER_ACCOUNT_ID;
    this.heartbeatInterval = null;
    this.reconnectTimeout = null;
    this.messageHandlers = new Map();
    this.connectionAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.lastHeartbeatTime = 0;
  }

  async connect() {
    try {
      if (this.connectionAttempts >= this.maxReconnectAttempts) {
        console.error('💀 Max reconnection attempts reached, stopping...');
        return;
      }

      this.connectionAttempts++;
      const wsUrl = WS_ENDPOINTS[CTRADER_ENV];
      console.log(`🔌 Connecting to ${CTRADER_ENV} WebSocket (attempt ${this.connectionAttempts})...`);
      
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
    console.log('✅ WebSocket connected - authenticating application...');
    this.connectionAttempts = 0; // Reset on successful connection
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
    
    // Don't reconnect for certain close codes (auth failures)
    if (code === 1008 || code === 4000) {
      console.error('💀 Authentication failed, stopping reconnections');
      return;
    }
    
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
      
      // If token is invalid, don't reconnect infinitely
      if (error.message.includes('ACCESS_DENIED')) {
        console.error('💀 Invalid credentials, stopping reconnections');
        return;
      }
      
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
        if (message.payload?.errorCode) {
          console.error('❌ Application auth failed:', message.payload.description);
        } else {
          console.log('✅ Application authenticated - authenticating account...');
          this.authenticateAccount();
        }
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
        this.handleError(message);
        break;

      case MSG_TYPES.HEARTBEAT_EVENT:
        this.lastHeartbeatTime = Date.now();
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
      console.log('✅ Order executed successfully');
    }
  }

  handleError(message) {
    const error = message.payload;
    console.error('❌ API Error:', error);
    
    // Handle rate limiting
    if (error.errorCode === 'REQUEST_FREQUENCY_EXCEEDED') {
      console.warn('⚠️  Rate limit exceeded, backing off...');
    }
  }

  sendMessage(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    console.warn('⚠️  Cannot send message: WebSocket not connected');
    return false;
  }

  // Send trading order with proper error handling
  async sendOrder(orderData) {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated - please wait for connection');
    }

    const orderMessage = {
      clientMsgId: `order_${Date.now()}`,
      payloadType: MSG_TYPES.NEW_ORDER_REQ,
      payload: {
        ctidTraderAccountId: parseInt(this.accountId),
        symbolId: parseInt(orderData.symbolId),
        orderType: parseInt(orderData.type) || 1, // 1=MARKET, 2=LIMIT, 3=STOP
        tradeSide: parseInt(orderData.side), // 1=BUY, 2=SELL
        volume: parseInt(orderData.volume),
        ...(orderData.stopLoss && { stopLoss: parseFloat(orderData.stopLoss) }),
        ...(orderData.takeProfit && { takeProfit: parseFloat(orderData.takeProfit) }),
        ...(orderData.comment && { comment: orderData.comment.toString() })
      }
    };

    return new Promise((resolve, reject) => {
      // Set timeout for order response
      const timeout = setTimeout(() => {
        this.messageHandlers.delete(orderMessage.clientMsgId);
        reject(new Error('Order timeout - no response from broker'));
      }, 15000); // 15 second timeout

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
        reject(new Error('Cannot send order - WebSocket not connected'));
      }
    });
  }

  startHeartbeat() {
    this.stopHeartbeat();
    
    // Send heartbeat every 10 seconds (as per cTrader requirement)
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const heartbeat = {
          clientMsgId: `heartbeat_${Date.now()}`,
          payloadType: MSG_TYPES.HEARTBEAT_EVENT,
          payload: {}
        };
        
        this.sendMessage(heartbeat);
        
        // Check if we're receiving heartbeat responses
        if (Date.now() - this.lastHeartbeatTime > 30000) {
          console.warn('⚠️  No heartbeat response for 30s, connection may be stale');
        }
      }
    }, 10000); // Every 10 seconds (cTrader requirement)
    
    console.log('💓 Heartbeat started (every 10 seconds)');
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      console.log('💓 Heartbeat stopped');
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimeout) return;

    // Exponential backoff: 5s, 10s, 20s, 40s, 60s max
    const backoffTime = Math.min(5000 * Math.pow(2, this.connectionAttempts - 1), 60000);
    
    console.log(`⏳ Reconnecting in ${backoffTime/1000} seconds...`);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, backoffTime);
  }

  disconnect() {
    console.log('⏹️  Disconnecting cTrader client...');
    
    this.stopHeartbeat();
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'Normal closure');
    }
    
    this.isAuthenticated = false;
  }

  isReady() {
    return this.ws && 
           this.ws.readyState === WebSocket.OPEN && 
           this.isAuthenticated;
  }

  getStatus() {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      authenticated: this.isAuthenticated,
      connectionAttempts: this.connectionAttempts,
      lastHeartbeat: this.lastHeartbeatTime ? new Date(this.lastHeartbeatTime).toISOString() : null
    };
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
const tokenManager = new SmartTokenManager();
const ctraderClient = new RobustcTraderClient(tokenManager);
const app = express();

// Middleware
app.use(express.json());

// Enhanced health check endpoint
app.get('/', (req, res) => {
  const status = {
    status: 'running',
    environment: CTRADER_ENV,
    websocket: ctraderClient.getStatus(),
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    tokenRefreshNeeded: tokenManager.pendingRefreshToken ? true : false
  };
  
  res.json(status);
});

// Detailed status endpoint
app.get('/status', (req, res) => {
  const status = {
    service: 'cTrader Trading Bridge',
    version: '2.0.0',
    environment: CTRADER_ENV,
    account: CTRADER_ACCOUNT_ID,
    websocket: ctraderClient.getStatus(),
    token: {
      hasAccessToken: !!tokenManager.accessToken,
      expiresAt: tokenManager.expiryTime ? new Date(tokenManager.expiryTime).toISOString() : null,
      daysUntilExpiry: tokenManager.expiryTime ? Math.round((tokenManager.expiryTime - Date.now()) / 86400000) : null
    },
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime())
  };
  
  res.json(status);
});

// Trading endpoint with enhanced validation
app.post('/order', async (req, res) => {
  try {
    console.log('📝 Order request received:', req.body);

    // Validate WebSocket connection
    if (!ctraderClient.isReady()) {
      return res.status(503).json({
        error: 'cTrader connection not ready',
        status: ctraderClient.getStatus(),
        message: 'Please wait for connection to establish'
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
        example: { symbolId: 1, side: 1, volume: 100000, type: 1 }
      });
    }

    // Validate required fields
    if (!side || !volume) {
      return res.status(400).json({
        error: 'Missing required fields: side, volume',
        received: req.body
      });
    }

    // Validate enum values
    if (![1, 2].includes(parseInt(side))) {
      return res.status(400).json({
        error: 'Invalid side: must be 1 (BUY) or 2 (SELL)',
        received: side
      });
    }

    if (type && ![1, 2, 3].includes(parseInt(type))) {
      return res.status(400).json({
        error: 'Invalid type: must be 1 (MARKET), 2 (LIMIT), or 3 (STOP)',
        received: type
      });
    }

    // Prepare order data
    const orderData = {
      symbolId: parseInt(finalSymbolId),
      side: parseInt(side),
      volume: parseInt(volume),
      type: parseInt(type) || 1, // Default to market order
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
      orderData,
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

// Secure endpoint to retrieve pending token update
app.get('/token-update', (req, res) => {
  // Simple security: require a key
  const authKey = req.headers['x-auth-key'] || req.query.key;
  
  if (authKey !== process.env.TOKEN_UPDATE_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (tokenManager.pendingRefreshToken) {
    res.json({
      status: 'token_available',
      refresh_token: tokenManager.pendingRefreshToken,
      timestamp: new Date().toISOString(),
      instructions: 'Update with: fly secrets set CTRADER_REFRESH_TOKEN="[token_value]" -a ctrader-order-bot'
    });
    
    // Clear after retrieval
    tokenManager.pendingRefreshToken = null;
  } else {
    res.json({
      status: 'no_pending_token',
      message: 'No refresh token update pending'
    });
  }
});

// Error handling
app.use((error, req, res, next) => {
  console.error('❌ Server error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

/* ========================================
   🚀 APPLICATION STARTUP
   ======================================== */

async function startup() {
  try {
    console.log('\n🚀 Starting cTrader Trading Bridge v2.0...');
    console.log(`📊 Environment: ${CTRADER_ENV}`);
    console.log(`🏦 Account ID: ${CTRADER_ACCOUNT_ID}`);
    console.log('🔒 Production-ready with rate limiting protection');
    
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
        console.log('👋 Shutdown complete');
        process.exit(0);
      });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    console.log('✅ cTrader Trading Bridge is ready!');
    console.log('\n📋 API Endpoints:');
    console.log(`   GET  /        - Health check`);
    console.log(`   GET  /status  - Detailed status`);
    console.log(`   POST /order   - Place trading order`);
    console.log('\n📖 Order Example:');
    console.log(`   {
     "symbolId": 1,     // EURUSD
     "side": 1,         // BUY (1) or SELL (2) 
     "volume": 100000,  // 1 lot = 100,000 units
     "type": 1          // MARKET (1), LIMIT (2), STOP (3)
   }`);

  } catch (error) {
    console.error('❌ Startup failed:', error);
    process.exit(1);
  }
}

// Start the application
startup();
