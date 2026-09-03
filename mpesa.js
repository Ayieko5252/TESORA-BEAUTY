// Tessora Beauty - Safaricom Daraja (M-Pesa) STK Push helper.
// Zero dependencies: uses the built-in global fetch (Node >= 20).
//
// All credentials come from the shop's settings (Admin -> Settings -> Payments),
// or from environment variables of the same name in UPPER_SNAKE_CASE, e.g.
// MPESA_CONSUMER_KEY. Environment variables win over saved settings, which is
// handy on hosts where you'd rather keep secrets out of the database file.

function cfg(settings, key, envName) {
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return settings?.[key] ?? '';
}

// Build the {sandbox|production} base URL.
function baseUrl(settings) {
  const env = String(cfg(settings, 'mpesaEnv', 'MPESA_ENV') || 'sandbox').toLowerCase();
  return env === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

// Turn 07XXXXXXXX / 011XXXXXXX / +2547... / 2547... into 2547XXXXXXXX (or 2541...).
export function normalizePhone(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('0')) d = `254${d.slice(1)}`;
  else if (d.startsWith('7') || d.startsWith('1')) d = `254${d}`;
  else if (d.startsWith('254')) { /* already good */ }
  else if (d.startsWith('+254')) d = d.slice(1);
  return d;
}

export function isConfigured(settings) {
  return Boolean(
    cfg(settings, 'mpesaConsumerKey', 'MPESA_CONSUMER_KEY') &&
    cfg(settings, 'mpesaConsumerSecret', 'MPESA_CONSUMER_SECRET') &&
    cfg(settings, 'mpesaShortcode', 'MPESA_SHORTCODE') &&
    cfg(settings, 'mpesaPasskey', 'MPESA_PASSKEY')
  );
}

// YYYYMMDDHHmmss in the server's local time (Daraja is lenient about zone).
function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function getToken(settings) {
  const key = cfg(settings, 'mpesaConsumerKey', 'MPESA_CONSUMER_KEY');
  const secret = cfg(settings, 'mpesaConsumerSecret', 'MPESA_CONSUMER_SECRET');
  const auth = Buffer.from(`${key}:${secret}`).toString('base64');
  const res = await fetch(`${baseUrl(settings)}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.errorMessage || 'Could not authenticate with M-Pesa. Check your consumer key and secret.');
  }
  return data.access_token;
}

/**
 * Trigger an STK push (the green M-Pesa prompt) on the customer's phone.
 * Returns { checkoutRequestId, merchantRequestId, customerMessage }.
 */
export async function stkPush(settings, { phone, amount, reference, description }) {
  const msisdn = normalizePhone(phone);
  if (!/^254\d{9}$/.test(msisdn)) throw new Error('Enter a valid Safaricom number, e.g. 07XX XXX XXX.');

  const shortcode = String(cfg(settings, 'mpesaShortcode', 'MPESA_SHORTCODE')).replace(/\D/g, '');
  const passkey = cfg(settings, 'mpesaPasskey', 'MPESA_PASSKEY');
  const isTill = String(cfg(settings, 'mpesaType', 'MPESA_TYPE') || 'paybill').toLowerCase() === 'till';
  const till = String(cfg(settings, 'mpesaTill', 'MPESA_TILL')).replace(/\D/g, '');
  const partyB = isTill && till ? till : shortcode;

  const ts = timestamp();
  const password = Buffer.from(`${shortcode}${passkey}${ts}`).toString('base64');
  const token = await getToken(settings);

  const body = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: ts,
    TransactionType: isTill ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
    Amount: Math.max(1, Math.round(Number(amount) || 0)),
    PartyA: msisdn,
    PartyB: partyB,
    PhoneNumber: msisdn,
    CallBackURL: cfg(settings, 'mpesaCallbackUrl', 'MPESA_CALLBACK_URL'),
    AccountReference: String(reference || 'Tessora').slice(0, 12),
    TransactionDesc: String(description || 'Order payment').slice(0, 60)
  };

  const res = await fetch(`${baseUrl(settings)}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ResponseCode !== '0') {
    throw new Error(data.errorMessage || data.CustomerMessage || 'M-Pesa could not start the payment. Please try again.');
  }
  return {
    checkoutRequestId: data.CheckoutRequestID,
    merchantRequestId: data.MerchantRequestID,
    customerMessage: data.CustomerMessage || 'Check your phone and enter your M-Pesa PIN to pay.'
  };
}

/**
 * Ask Daraja whether an STK push has been paid yet (used for polling as a
 * backup to the callback). Returns { resultCode, resultDesc } or null when the
 * request is still being processed.
 */
export async function stkQuery(settings, checkoutRequestId) {
  const shortcode = String(cfg(settings, 'mpesaShortcode', 'MPESA_SHORTCODE')).replace(/\D/g, '');
  const passkey = cfg(settings, 'mpesaPasskey', 'MPESA_PASSKEY');
  const ts = timestamp();
  const password = Buffer.from(`${shortcode}${passkey}${ts}`).toString('base64');
  const token = await getToken(settings);

  const res = await fetch(`${baseUrl(settings)}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: shortcode, Password: password, Timestamp: ts,
      CheckoutRequestID: checkoutRequestId
    })
  });
  const data = await res.json().catch(() => ({}));
  // "processing" comes back as an errorCode; treat that as "not done yet".
  if (data.ResultCode === undefined) return null;
  return { resultCode: String(data.ResultCode), resultDesc: data.ResultDesc || '' };
}

// Pull the receipt number + amount out of a Daraja callback payload.
export function parseCallback(payload) {
  const cb = payload?.Body?.stkCallback;
  if (!cb) return null;
  const out = {
    checkoutRequestId: cb.CheckoutRequestID,
    merchantRequestId: cb.MerchantRequestID,
    resultCode: String(cb.ResultCode),
    resultDesc: cb.ResultDesc || '',
    receipt: '', amount: 0, phone: ''
  };
  for (const item of cb.CallbackMetadata?.Item || []) {
    if (item.Name === 'MpesaReceiptNumber') out.receipt = item.Value;
    if (item.Name === 'Amount') out.amount = Number(item.Value) || 0;
    if (item.Name === 'PhoneNumber') out.phone = String(item.Value || '');
  }
  return out;
}
