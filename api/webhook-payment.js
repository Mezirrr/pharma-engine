import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

export const config = { api: { bodyParser: false } };

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Only subscription plan references (Lab Rat removed)
const PHARMAENGINE_PLAN_REFS = ['starter-sub', 'researcher-sub'];

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifySignature(message, signatureBase64, publicKeyPem) {
  try {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(message);
    verifier.end();
    return verifier.verify(publicKeyPem, signatureBase64, 'base64');
  } catch (e) {
    console.error('Signature verification error:', e.message);
    return false;
  }
}

function currentPeriod() {
  return new Date().toISOString().slice(0, 7);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rawBody = await getRawBody(req);
  const timestamp = req.headers['x-boomfi-timestamp'];
  const signature = req.headers['x-boomfi-signature'];

  if (!timestamp || !signature) return res.status(400).json({ error: 'Missing signature headers' });

  const tsSeconds = parseInt(timestamp, 10);
  if (!Number.isFinite(tsSeconds) || Math.abs(Date.now() / 1000 - tsSeconds) > 300) {
    return res.status(400).json({ error: 'Stale or invalid timestamp' });
  }

  const publicKey = (process.env.BOOMFI_PUBLIC_KEY || '').replace(/\\n/g, '\n');
  const message = `${timestamp}.${rawBody}`;

  if (!publicKey || !verifySignature(message, signature, publicKey)) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  if (process.env.BOOMFI_ORG_ID && payload.org_id !== process.env.BOOMFI_ORG_ID) {
    return res.status(401).json({ error: 'Org ID mismatch' });
  }

  // Only act on successful payments
  if (payload.event !== 'Payment.Updated' || payload.status !== 'Succeeded') {
    return res.status(200).json({ received: true, ignored: true });
  }

  const customerEmail = payload.customer?.email;
  const customerId = payload.customer?.id;
  const planReference = payload.plan?.reference;
  const subscriptionId = payload.subscription?.id;

  if (!customerEmail || !planReference) {
    return res.status(200).json({ received: true, ignored: true });
  }

  // Handle top‑up purchases
  if (planReference === 'topup20' || planReference === 'topup45' || planReference === 'topup100') {
    const topupAmount = { topup20: 20, topup45: 45, topup100: 100 }[planReference];
    if (!topupAmount) return res.status(200).json({ received: true, ignored: true });

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id, extra_assays')
      .eq('email', customerEmail)
      .single();

    if (!profile) {
      console.warn('No user found for top‑up email:', customerEmail);
      return res.status(200).json({ received: true, matched: false });
    }

    const newExtra = (profile.extra_assays || 0) + topupAmount;
    await supabaseAdmin
      .from('profiles')
      .update({ extra_assays: newExtra })
      .eq('id', profile.id);

    console.log(`Top‑up ${topupAmount} assays applied to ${customerEmail}`);
    return res.status(200).json({ received: true, matched: true, topup: topupAmount });
  }

  // Map subscription plan references to tier names
  let tier = null;
  if (planReference === 'starter-sub') tier = 'Starter';
  else if (planReference === 'researcher-sub') tier = 'Researcher';

  if (!tier) {
    console.warn('Unknown plan reference:', planReference);
    return res.status(200).json({ received: true, ignored: true });
  }

  // Cancel other PharmaEngine subscriptions for this customer, leaving the new one
  if (subscriptionId && customerId && process.env.BOOMFI_API_KEY) {
    try {
      const listUrl = `https://api.boomfi.xyz/v1/subscriptions?customer_id=${encodeURIComponent(customerId)}&status=active`;
      const listRes = await fetch(listUrl, {
        headers: { 'Authorization': `Bearer ${process.env.BOOMFI_API_KEY}` }
      });
      const listData = await listRes.json();
      const activeSubs = listData.data || [];

      for (const sub of activeSubs) {
        if (
          sub.id !== subscriptionId &&
          sub.plan?.reference &&
          PHARMAENGINE_PLAN_REFS.includes(sub.plan.reference)
        ) {
          console.log(`Cancelling other PharmaEngine subscription ${sub.id} (${sub.plan.reference}) for ${customerEmail}`);
          await fetch(`https://api.boomfi.xyz/v1/subscriptions/${sub.id}/cancel`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.BOOMFI_API_KEY}` }
          });
        }
      }
    } catch (e) {
      console.error('Failed to cancel other PharmaEngine subscriptions:', e.message);
    }
  }

  // Update the profile tier in Supabase
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('email', customerEmail)
    .single();

  if (!profile) {
    console.warn('No user found for email:', customerEmail);
    return res.status(200).json({ received: true, matched: false });
  }

  await supabaseAdmin
    .from('profiles')
    .update({
      tier,
      assays_used_this_month: 0,
      usage_period: currentPeriod()
    })
    .eq('id', profile.id);

  return res.status(200).json({ received: true, matched: true, tier });
}
