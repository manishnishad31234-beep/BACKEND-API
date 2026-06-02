# Design2Code Razorpay Backend

A secure Express backend for Razorpay order creation and payment verification.

## Setup

1. Copy `.env.example` to `.env`.
2. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
3. Optionally adjust `PORT` or `CORS_ORIGIN`.
4. Run `npm install` and `npm start`.

## Endpoints

- `POST /create-order`
  - Request body: `{ amount: 2000, currency: 'INR', receipt?: string, notes?: object }`
  - Response: `{ order_id, amount, currency, key_id }`

- `POST /verify-payment`
  - Request body: `{ razorpay_payment_id, razorpay_order_id, razorpay_signature }`
  - Response: `{ success: true, order_id, payment_id }`

## Integration

Use this backend from the browser to obtain a secure Razorpay order ID, then open checkout with the returned `key_id` and `order_id`.

A simple client helper is available in `public/payment-client.js`.
