const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4000;

// ✅ CORS - Vercel ke liye * allow
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}));

app.options('*', cors()); // preflight ke liye

function saveRawBody(req, res, buf) {
  if (req.originalUrl === '/webhook/razorpay') {
    req.rawBody = buf;
  }
}

app.use(bodyParser.json({ verify: saveRawBody, limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.error('❌ Missing Razorpay credentials. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
  // process.exit(1) removed - Vercel pe ye crash karta hai
}

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID || '',
  key_secret: RAZORPAY_KEY_SECRET || '',
});

const SUPPORTED_CURRENCY = 'INR';
const FIXED_AMOUNT = Number(process.env.FIXED_AMOUNT || 2000);

// ✅ In-memory store - Vercel pe file system nahi chalta
let shareStore = {};

function createShareId() {
  return `s${crypto.randomBytes(3).toString('hex')}-${Date.now().toString(36)}`;
}

// ✅ Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    environment: process.env.NODE_ENV || 'development',
    razorpay: RAZORPAY_KEY_ID ? 'connected' : 'missing keys'
  });
});

// ✅ Save share
app.post('/save-share', (req, res) => {
  const { html, base, allPages } = req.body;

  if (!html && !allPages) {
    return res.status(400).json({ error: 'Missing shared HTML content or page bundle.' });
  }

  const shareId = createShareId();
  shareStore[shareId] = {
    html: html || null,
    allPages: allPages || null,
    base: base || '',
    createdAt: new Date().toISOString(),
    published: false,
    payment: null,
  };

  console.log(`✅ Share saved: ${shareId}`);
  res.json({ shareId });
});

// ✅ Get share
app.get('/share/:shareId', (req, res) => {
  const share = shareStore[req.params.shareId];
  if (!share) {
    return res.status(404).json({ error: 'Share link not found.' });
  }
  res.json(share);
});

// ✅ Create Razorpay order
app.post('/create-order', async (req, res) => {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return res.status(500).json({ error: 'Razorpay keys not configured on server.' });
  }

  try {
    const amount = Number(req.body.amount || req.query.amount || FIXED_AMOUNT);
    const currency = String(req.body.currency || req.query.currency || SUPPORTED_CURRENCY).toUpperCase();

    if (currency !== SUPPORTED_CURRENCY) {
      return res.status(400).json({ error: 'Only INR orders are supported.' });
    }

    if (amount !== FIXED_AMOUNT) {
      return res.status(400).json({ error: `Amount must be exactly ${FIXED_AMOUNT} paise.` });
    }

    const options = {
      amount,
      currency,
      receipt: req.body.receipt || `receipt_${Date.now()}`,
      payment_capture: 1,
      notes: req.body.notes || {},
    };

    const order = await razorpay.orders.create(options);
    console.log(`✅ Order created: ${order.id}`);

    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error('❌ Order creation failed:', error?.message || error);
    const message =
      error?.error_description ||
      error?.description ||
      error?.message ||
      'Unable to create Razorpay order.';
    res.status(error?.statusCode || 500).json({
      error: `Unable to create Razorpay order. ${message}`,
    });
  }
});

// ✅ Verify payment
app.post('/verify-payment', (req, res) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing required payment verification fields.' });
  }

  const generatedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  const isValid = generatedSignature === razorpay_signature;

  if (!isValid) {
    return res.status(400).json({ error: 'Payment verification failed.' });
  }

  // Mark share as published if shareId in notes
  try {
    const shareId = req.body.notes?.shareId;
    if (shareId && shareStore[shareId]) {
      shareStore[shareId].published = true;
      shareStore[shareId].payment = {
        payment_id: razorpay_payment_id,
        order_id: razorpay_order_id,
        verifiedAt: new Date().toISOString(),
      };
      console.log(`✅ Share ${shareId} marked as published`);
    }
  } catch (e) {
    // ignore
  }

  res.json({ 
    success: true, 
    order_id: razorpay_order_id, 
    payment_id: razorpay_payment_id 
  });
});

// ✅ Razorpay Webhook
app.post('/webhook/razorpay', (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const bodyBuffer = req.rawBody || Buffer.from(JSON.stringify(req.body), 'utf8');

  if (!signature) {
    return res.status(400).json({ error: 'Missing signature' });
  }

  try {
    const expected = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(bodyBuffer)
      .digest('hex');

    if (expected !== signature) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const payload = JSON.parse(bodyBuffer.toString('utf8'));
    let shareId = null;

    try {
      const p = payload?.payload;
      const paymentEntity = p?.payment?.entity;
      const orderEntity = p?.order?.entity;
      shareId = paymentEntity?.notes?.shareId || orderEntity?.notes?.shareId || null;
    } catch (e) {}

    if (shareId && shareStore[shareId]) {
      shareStore[shareId].published = true;
      shareStore[shareId].payment = {
        ...shareStore[shareId].payment,
        webhook: {
          event: payload.event || null,
          receivedAt: new Date().toISOString(),
        },
      };
      console.log(`✅ Webhook: Share ${shareId} published`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Webhook failed:', err?.message || err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found.' });
});

// Local server start (Vercel pe ye ignore hota hai)
if (process.env.NODE_ENV !== 'production') {
  function startServer(startPort, maxRetries = 5) {
    let port = Number(startPort) || 4000;
    let attempts = 0;

    function tryListen() {
      const server = app.listen(port, () => {
        console.log(`✅ Backend running on http://localhost:${port}`);
      });

      server.on('error', (err) => {
        if (err?.code === 'EADDRINUSE') {
          attempts += 1;
          const nextPort = port + 1;
          console.warn(`Port ${port} in use. Trying ${nextPort} (${attempts}/${maxRetries})`);
          if (attempts <= maxRetries) {
            port = nextPort;
            setTimeout(tryListen, 250);
          } else {
            console.error('Failed to bind server. Exiting.');
            process.exit(1);
          }
        } else {
          console.error('Server error:', err);
          process.exit(1);
        }
      });
    }

    tryListen();
  }

  startServer(PORT);
}

module.exports = app;