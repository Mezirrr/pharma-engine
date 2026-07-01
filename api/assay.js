import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const TIER_LIMITS = {
  Free: 3,
  Starter: 50,
  Researcher: 250
};

const TIER_MAX_TOKENS = {
  Free: 5000,
  Starter: 7500,
  Researcher: 10000
};

// ... fetchWithRetry, currentPeriod, repairJSON, etc. (unchanged)

export default async function handler(req, res) {
  const rid = Math.random().toString(36).slice(2, 8);
  console.log('[' + rid + '] Incoming assay request');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Authentication required.' });
  const token = authHeader.replace('Bearer ', '');
  let user;
  try {
    const { data: { user: authUser }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !authUser) throw authError;
    user = authUser;
    console.log('[' + rid + '] Auth OK – ' + user.email);
  } catch (e) { return res.status(401).json({ error: 'Invalid session.' }); }

  let profile;
  try {
    const { data, error } = await supabaseAdmin.from('profiles').select('*').eq('id', user.id).single();
    if (error && error.code === 'PGRST116') {
      await supabaseAdmin.from('profiles').insert({
        id: user.id, email: user.email, tier: 'Free',
        assays_used_this_month: 0, usage_period: currentPeriod(), search_count: 0,
        topup_assays: 0
      });
      const { data: newProfile } = await supabaseAdmin.from('profiles').select('*').eq('id', user.id).single();
      profile = newProfile;
    } else if (error || !data) {
      throw error || new Error('Profile not found');
    } else {
      profile = data;
    }
    // Super user gets Researcher with unlimited secretly
    if (user.email === 'mezirrr@protonmail.com') {
      if (profile.tier !== 'Researcher') {
        console.log('[' + rid + '] Super user detected – upgrading to Researcher (unlimited)');
        await supabaseAdmin.from('profiles').update({
          tier: 'Researcher',
          assays_used_this_month: 0,
          usage_period: currentPeriod()
        }).eq('id', user.id);
        profile.tier = 'Researcher';
        profile.assays_used_this_month = 0;
      }
    }
    console.log('[' + rid + '] Profile – tier: ' + profile.tier + ', used: ' + profile.assays_used_this_month);
  } catch (e) { return res.status(500).json({ error: 'Profile service error.' }); }

  const period = currentPeriod();
  const monthlyUsed = (profile.usage_period === period) ? (profile.assays_used_this_month || 0) : 0;
  const topupAssays = profile.topup_assays || 0;
  const tier = profile.tier || 'Free';
  const baseLimit = TIER_LIMITS[tier] || TIER_LIMITS.Free;
  const isSuper = user.email === 'mezirrr@protonmail.com';
  const effectiveLimit = isSuper ? 999999 : baseLimit;

  // Check availability: topup first, then monthly
  let remainingTopup = topupAssays;
  let newMonthlyUsed = monthlyUsed;
  if (topupAssays > 0) {
    remainingTopup = topupAssays - 1;
  } else {
    if (monthlyUsed >= effectiveLimit) {
      return res.status(403).json({
        error: 'No assays remaining this month. Please top up or upgrade.'
      });
    }
    newMonthlyUsed = monthlyUsed + 1;
  }

  // Update usage before processing
  await supabaseAdmin.from('profiles').update({
    topup_assays: remainingTopup,
    assays_used_this_month: newMonthlyUsed,
    usage_period: period
  }).eq('id', user.id);

  const maxTokens = TIER_MAX_TOKENS[tier] || 5000;
  const { target, goal, typeLabel } = req.body;
  // ... rest of the assay logic unchanged (enhancer, S2, PMC, synthesis)
  // (keep everything after this point exactly as before)
}
