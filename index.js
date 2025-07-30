const express = require('express');
const WebSocket = require('ws');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const CTRADER_WS_URL = 'wss://demo.ctraderapi.com:5035';

app.post('/order', async (req, res) => {
  const { symbol, volume, direction } = req.body;

  const ws = new WebSocket(CTRADER_WS_URL);

  ws.on('open', () => {
    console.log('Connesso a cTrader WebSocket');
    const orderMsg = {
      action: 'PLACE_ORDER',
      data: {
        symbol,
        volume,
        direction, // "BUY" o "SELL"
      },
    };
    ws.send(JSON.stringify(orderMsg));
  });

  ws.on('message', (msg) => {
    console.log('Risposta da cTrader:', msg.toString());
    ws.close();
    res.send({ success: true, message: 'Ordine inviato' });
  });

  ws.on('error', (err) => {
    console.error('Errore WebSocket:', err.message);
    res.status(500).send({ success: false, error: err.message });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});
