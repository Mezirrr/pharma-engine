import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

export const config = { api: { bodyParser: false } };

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PHARMAENGINE_PLAN_REFS = ['starter-sub', 'researcher-sub', 'topup20', 'topup45', 'topup100'];

function getRawBody(req) { /* unchanged */ }
function verifySignature(message, signatureBase64, publicKeyPem) { /* unchanged */ }
function currentPeriod() { return new Date().toISOString().slice(0, 7); }

export default async function handler(req, res) {
  // ... signature verification, JSON parse, event check (unchanged)

  const planReference = payload.plan?.reference;
  const customerEmail = payload.customer?.email;
  const subscriptionId = payload.subscription?.id;

  // Determine if it's a top‑up
  const topupAmounts = { topup20: 20, topup45: 45, topup100: 100 };
  const topupAmount = topupAmounts[planReference];
  if (topupAmount) {
    // It's a top‑up payment
    const { data: profile } = await supabaseAdmin.from('profiles').select('id, topup_assays').eq('email', customerEmail).single();
    if (!profile) return res.status(200).json({ received: true, matched: false });
    const newTopup = (profile.topup_assays || 0) + topupAmount;
    await supabaseAdmin.from('profiles').update({ topup_assays: newTopup }).eq('id', profile.id);
    return res.status(200).json({ received: true, matched: true, topup: topupAmount });
  }

  // Otherwise it's a subscription change (existing logic)
  let tier = null;
  if (planReference === 'starter-sub') tier = 'Starter';
  else if (planReference === 'researcher-sub') tier = 'Researcher';
  // 'labrat-sub' no longer recognized

  if (!tier) return res.status(200).json({ received: true, ignored: true });

  // Cancel other PharmaEngine subscriptions (existing logic)...
  // Update tier (existing logic)
}
