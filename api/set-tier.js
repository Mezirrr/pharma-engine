import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Authentication required.' });
  const token = authHeader.replace('Bearer ', '');

  let user;
  try {
    const { data: { user: authUser }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !authUser) throw authError;
    user = authUser;
  } catch (e) {
    return res.status(401).json({ error: 'Invalid session.' });
  }

  const { tier } = req.body;
  if (tier !== 'Free') return res.status(400).json({ error: 'Only Free tier can be set via this endpoint.' });

  await supabaseAdmin.from('profiles').update({
    tier: 'Free',
    assays_used_this_month: 0,
    usage_period: new Date().toISOString().slice(0, 7)
  }).eq('id', user.id);

  return res.status(200).json({ success: true });
}
